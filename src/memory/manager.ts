import type { LLMProvider, EmbeddingProvider } from '../shared/types.js'
import { MemoryExtractor } from './extractor.js'
import { BubbleAggregator } from '../bubble/aggregator.js'
import { createBubble, getAllMemoryBubbles, searchBubbles } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

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

  async getContextForQuery(userInput: string): Promise<string> {
    const bubbles = await this.aggregator.aggregate(userInput)
    if (bubbles.length === 0) return ''

    const lines = bubbles.map((m) => `- ${m.content}`).join('\n')
    return `\n你记住的关于用户的信息：\n${lines}\n\n请在回复中自然地运用这些记忆，不要生硬地列出来。`
  }

  async extractAndStore(userMessage: string, assistantMessage: string): Promise<void> {
    const extracted = await this.extractor.extract(userMessage, assistantMessage)
    const newIds: string[] = []

    for (const mem of extracted) {
      const existing = searchBubbles(mem.title, 5)
      const isDuplicate = existing.some((b) =>
        b.type === 'memory' && b.content === mem.content
      )
      if (isDuplicate) continue

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
        tags: mem.tags,
        embedding,
        source: 'dialogue',
        confidence: mem.confidence,
      })
      newIds.push(bubble.id)
      logger.debug(`Stored memory: ${mem.title}`)
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

  listMemories() {
    return getAllMemoryBubbles()
  }
}
