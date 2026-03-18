import type { LLMProvider, EmbeddingProvider, Bubble } from '../shared/types.js'
import { MemoryExtractor } from './extractor.js'
import { BubbleAggregator } from '../bubble/aggregator.js'
import { createBubble, getAllMemoryBubbles, searchBubbles, updateBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

// --- Surprise-driven memory helpers ---

/** Extract meaningful tokens from text for overlap comparison */
function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,，。？！、；：""''（）()\[\]{}·\-—\n]+/)
      .filter(t => t.length >= 2)
  )
}

/** Calculate surprise score: 0 = fully expected, 1 = completely novel */
function calcSurprise(newContent: string, existingBubbles: Bubble[]): { score: number; contradicts: boolean; nearDuplicate: Bubble | null } {
  if (existingBubbles.length === 0) return { score: 0.8, contradicts: false, nearDuplicate: null }

  const newTokens = tokenize(newContent)
  let maxOverlap = 0
  let bestMatch: Bubble | null = null

  for (const b of existingBubbles) {
    const existTokens = tokenize(b.content)
    // Jaccard similarity
    let intersection = 0
    for (const t of newTokens) { if (existTokens.has(t)) intersection++ }
    const union = new Set([...newTokens, ...existTokens]).size
    const overlap = union > 0 ? intersection / union : 0
    if (overlap > maxOverlap) {
      maxOverlap = overlap
      bestMatch = b
    }
  }

  // Contradiction detection: high token overlap but different numeric values
  let contradicts = false
  if (bestMatch && maxOverlap > 0.4) {
    const newNums = newContent.match(/\d+\.?\d*/g) || []
    const oldNums = bestMatch.content.match(/\d+\.?\d*/g) || []
    if (newNums.length > 0 && oldNums.length > 0) {
      const newSet = new Set(newNums)
      const oldSet = new Set(oldNums)
      const numOverlap = [...newSet].filter(n => oldSet.has(n)).length
      // Same context but different numbers → contradiction
      if (numOverlap < Math.min(newSet.size, oldSet.size) * 0.5) {
        contradicts = true
      }
    }
  }

  // Near duplicate: very high overlap
  const nearDuplicate = maxOverlap > 0.7 ? bestMatch : null

  // Surprise score
  let score: number
  if (contradicts) {
    score = 1.0  // Maximum surprise: contradicts existing knowledge
  } else if (maxOverlap > 0.7) {
    score = 0.1  // Almost duplicate, very low surprise
  } else if (maxOverlap > 0.4) {
    score = 0.4  // Related info, moderate surprise
  } else {
    score = 0.8  // Novel info, high surprise
  }

  return { score, contradicts, nearDuplicate }
}

export class MemoryManager {
  private extractor: MemoryExtractor
  private aggregator: BubbleAggregator
  private embeddings: EmbeddingProvider | null = null

  constructor(llm: LLMProvider) {
    this.extractor = new MemoryExtractor(llm)
    this.aggregator = new BubbleAggregator()
  }

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
    this.aggregator.setEmbeddingProvider(provider)
    logger.info('Memory: embedding provider connected')
  }

  async getContextForQuery(userInput: string, spaceIds?: string[]): Promise<string> {
    const bubbles = await this.aggregator.aggregate(userInput, 20, spaceIds)
    if (bubbles.length === 0) return ''

    // Separate structured data (excel summaries) from regular memories
    const summaries = bubbles.filter(b => b.tags?.includes('excel-summary'))
    const regular = bubbles.filter(b => !b.tags?.includes('excel-summary'))

    const parts: string[] = []

    if (summaries.length > 0) {
      const tableLines = summaries.map(m => m.content).join('\n\n')
      parts.push(`以下是结构化数据（来自Excel导入），包含完整的数据表和统计信息，可以直接用于计算和分析：\n${tableLines}`)
    }

    if (regular.length > 0) {
      const lines = regular.map((m) => `- [${m.type}] ${m.content}`).join('\n')
      parts.push(`以下是记忆库中的相关信息：\n${lines}`)
    }

    return `\n${parts.join('\n\n')}\n\n请基于以上信息回答用户的问题。如果涉及数值计算（金额汇总、吨位统计等），请基于完整数据表列出相关数据并计算，确保不遗漏任何行。`
  }

  async extractAndStore(userMessage: string, assistantMessage: string, spaceId?: string): Promise<void> {
    const extracted = await this.extractor.extract(userMessage, assistantMessage)
    const newIds: string[] = []

    for (const mem of extracted) {
      // Search existing similar bubbles for surprise calculation
      const existing = searchBubbles(mem.title, 10)
      const memoryBubbles = existing.filter(b => b.type === 'memory')

      // Exact duplicate check
      const isDuplicate = memoryBubbles.some((b) => b.content === mem.content)
      if (isDuplicate) continue

      // Calculate surprise score
      const { score: surprise, contradicts, nearDuplicate } = calcSurprise(mem.content, memoryBubbles)

      // Near duplicate: just refresh access time instead of storing
      if (nearDuplicate && surprise < 0.2) {
        updateBubble(nearDuplicate.id, {})  // triggers updated_at refresh
        logger.debug(`Memory refreshed (low surprise): ${mem.title}`)
        continue
      }

      // Adjust confidence and decayRate based on surprise
      const confidence = contradicts
        ? 1.0                                     // Contradictions are always important
        : Math.min(1.0, mem.confidence * (0.5 + surprise * 0.5))
      const decayRate = contradicts
        ? 0.02                                    // Very slow decay for contradictions
        : surprise > 0.6 ? 0.05 : 0.1            // Novel = slow decay, expected = normal

      // Tag contradictions for visibility
      const tags = [...mem.tags]
      if (contradicts) tags.push('surprise', 'contradiction')
      else if (surprise > 0.6) tags.push('novel')

      // Generate embedding if provider available
      let embedding: number[] | undefined
      if (this.embeddings) {
        try {
          embedding = await this.embeddings.embed(mem.content)
        } catch {
          logger.debug('Embedding generation failed, storing without vector')
        }
      }

      const bubble = createBubble({
        type: 'memory',
        title: mem.title,
        content: mem.content,
        tags,
        embedding,
        source: 'dialogue',
        confidence,
        decayRate,
        spaceId,
      })
      newIds.push(bubble.id)

      // Link contradictions to the bubble they contradict
      if (contradicts && nearDuplicate) {
        addLink(bubble.id, nearDuplicate.id, 'contradicts', 1.0, 'system')
      }

      logger.debug(`Stored memory [surprise=${surprise.toFixed(2)}]: ${mem.title}`)
    }

    // Auto-link new memories to each other (same conversation turn)
    if (newIds.length > 1) {
      for (let i = 0; i < newIds.length; i++) {
        for (let j = i + 1; j < newIds.length; j++) {
          addLink(newIds[i], newIds[j], 'same_turn', 0.8, 'system')
        }
      }
    }
  }

  listMemories(spaceIds?: string[]) {
    return getAllMemoryBubbles(spaceIds)
  }

  async search(query: string, limit = 15, spaceIds?: string[]) {
    return this.aggregator.aggregate(query, limit, spaceIds)
  }
}
