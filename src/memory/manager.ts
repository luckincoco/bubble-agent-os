import type { LLMProvider, EmbeddingProvider, Bubble, BubbleType, SourceRef } from '../shared/types.js'
import { MemoryExtractor } from './extractor.js'
import { BubbleAggregator } from '../bubble/aggregator.js'
import { createBubble, getAllMemoryBubbles, searchBubbles, updateBubble, rowToBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { FocusTracker, tokenize } from './focus-tracker.js'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../shared/tokens.js'
import { getDatabase, buildInClause } from '../storage/database.js'
import { logger } from '../shared/logger.js'

// Re-export for other modules
export { tokenize }

/** Calculate surprise score: 0 = fully expected, 1 = completely novel */
export function calcSurprise(newContent: string, existingBubbles: Bubble[]): { score: number; contradicts: boolean; nearDuplicate: Bubble | null } {
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
  private focusTracker: FocusTracker
  private focusEnabled: boolean

  constructor(llm: LLMProvider, enableFocus = true) {
    this.extractor = new MemoryExtractor(llm)
    this.aggregator = new BubbleAggregator()
    this.focusTracker = new FocusTracker()
    this.focusEnabled = enableFocus
  }

  /** Record user message for focus tracking */
  recordFocus(userId: string, message: string): void {
    if (this.focusEnabled) {
      this.focusTracker.record(userId, message)
    }
  }

  /** Get recent interest topics for a user (for interest_search task) */
  getRecentTopics(userId: string): Array<{ term: string; freq: number }> {
    if (!this.focusEnabled) return []
    const windowSize = this.focusTracker.getWindowSize(userId)
    const minFreq = windowSize < 5 ? 1 : 2
    return this.focusTracker.getTopTerms(userId, minFreq, 15)
  }

  /** Get all user IDs with active focus data */
  getActiveFocusUserIds(): string[] {
    if (!this.focusEnabled) return []
    return this.focusTracker.getActiveUserIds()
  }

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
    this.aggregator.setEmbeddingProvider(provider)
    logger.info('Memory: embedding provider connected')
  }

  async getContextForQuery(userInput: string, spaceIds?: string[], userId?: string, tokenBudget?: number): Promise<{ context: string; sources: SourceRef[] }> {
    const budget = tokenBudget ?? TOKEN_LIMITS.MEMORY_BUDGET
    const focusBoostFn = this.focusEnabled && userId
      ? (content: string) => this.focusTracker.computeFocusBoost(userId, content)
      : undefined

    // Phase 1: Get lightweight summaries (wider net, lower cost)
    const summaryHits = await this.aggregator.aggregateSummaries(userInput, 30, spaceIds, focusBoostFn)
    if (summaryHits.length === 0) return { context: '', sources: [] }

    // Phase 2: Load full content only for top candidates within budget
    const topIds = summaryHits.slice(0, 20).map(h => h.id)
    const bubbles = this.aggregator.loadFullBubbles(topIds)
    if (bubbles.length === 0) return { context: '', sources: [] }

    // Separate structured data (excel summaries) from regular memories
    const excelBubbles = bubbles.filter(b => b.tags?.includes('excel-summary'))
    const regular = bubbles.filter(b => !b.tags?.includes('excel-summary'))

    const parts: string[] = []
    const sources: SourceRef[] = []
    let usedTokens = 0
    let refIndex = 1
    // Reserve tokens for framing text around the data
    const framingOverhead = 200

    // Add excel summaries first (higher value for data queries), with per-bubble cap
    if (excelBubbles.length > 0) {
      const included: string[] = []
      for (const m of excelBubbles) {
        const capped = truncateToTokenBudget(m.content, TOKEN_LIMITS.SINGLE_BUBBLE_MAX)
        const cost = estimateTokens(capped)
        if (usedTokens + cost + framingOverhead > budget) break
        included.push(capped)
        sources.push({ refIndex, id: m.id, title: m.title, type: m.type, tags: m.tags, source: m.source, snippet: m.content.slice(0, 100) })
        refIndex++
        usedTokens += cost
      }
      if (included.length > 0) {
        parts.push(`以下是结构化数据（来自Excel导入），包含完整的数据表和统计信息，可以直接用于计算和分析：\n${included.join('\n\n')}`)
      }
    }

    // Add regular memories within remaining budget
    if (regular.length > 0) {
      const lines: string[] = []
      for (const m of regular) {
        const line = `[${m.type}] ${m.content}`
        const cost = estimateTokens(line)
        if (usedTokens + cost + framingOverhead > budget) break
        lines.push(line)
        sources.push({ refIndex, id: m.id, title: m.title, type: m.type, tags: m.tags, source: m.source, snippet: m.content.slice(0, 100) })
        refIndex++
        usedTokens += cost
      }
      if (lines.length > 0) {
        parts.push(`以下是记忆库中的相关信息：\n${lines.join('\n')}`)
      }
    }

    if (parts.length === 0) return { context: '', sources: [] }

    logger.debug(`Memory context: ~${usedTokens} tokens (budget ${budget}), ${summaryHits.length} candidates → ${bubbles.length} loaded, ${parts.length} sections`)

    const context = `\n${parts.join('\n\n')}\n\n请基于以上信息回答用户的问题。回复格式要求：\n1. 先用一句话给出结论（如"本月毛利 12.3万，环比下降 8%"）\n2. 多行数据用 Markdown 表格呈现（≤6列），金额≥1万时用"万"为单位（如 52.3万）\n3. 异常项排在最前并用 ⚠️ 标注（如负库存、亏损单、大额逾期）\n4. 如需计算过程，放在最后的"计算明细"段落，不要穿插在结论中\n5. 保持简洁，不要重复列出用户已知的信息`
    return { context, sources }
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

  async search(query: string, limit = 15, spaceIds?: string[], userId?: string, filters?: SearchFilters) {
    const focusBoostFn = this.focusEnabled && userId
      ? (content: string) => this.focusTracker.computeFocusBoost(userId, content)
      : undefined

    // If filters are provided, apply post-filter on aggregated results
    if (filters && hasActiveFilters(filters)) {
      const results = await this.aggregator.aggregate(query, limit * 3, spaceIds, focusBoostFn)
      return applyFilters(results, filters).slice(0, limit)
    }

    return this.aggregator.aggregate(query, limit, spaceIds, focusBoostFn)
  }

  /** Get knowledge statistics for the dashboard summary */
  getKnowledgeStats(spaceIds?: string[]): KnowledgeStats {
    const db = getDatabase()
    const spaceFilter = buildSpaceFilter(spaceIds)

    const totalRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM bubbles WHERE deleted_at IS NULL${spaceFilter.sql}`,
    ).get(...spaceFilter.params) as { cnt: number }

    const byTypeRows = db.prepare(
      `SELECT type, COUNT(*) as cnt FROM bubbles WHERE deleted_at IS NULL${spaceFilter.sql} GROUP BY type`,
    ).all(...spaceFilter.params) as Array<{ type: string; cnt: number }>

    const bySourceRows = db.prepare(
      `SELECT source, COUNT(*) as cnt FROM bubbles WHERE deleted_at IS NULL${spaceFilter.sql} GROUP BY source ORDER BY cnt DESC`,
    ).all(...spaceFilter.params) as Array<{ source: string; cnt: number }>

    const byLevelRows = db.prepare(
      `SELECT abstraction_level, COUNT(*) as cnt FROM bubbles WHERE deleted_at IS NULL${spaceFilter.sql} GROUP BY abstraction_level`,
    ).all(...spaceFilter.params) as Array<{ abstraction_level: number; cnt: number }>

    const recentRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM bubbles WHERE deleted_at IS NULL AND created_at > ?${spaceFilter.sql}`,
    ).get(Date.now() - 7 * 24 * 60 * 60 * 1000, ...spaceFilter.params) as { cnt: number }

    const linkRow = db.prepare(
      'SELECT COUNT(*) as cnt FROM bubble_links',
    ).get() as { cnt: number }

    return {
      total: totalRow.cnt,
      byType: Object.fromEntries(byTypeRows.map(r => [r.type, r.cnt])) as Record<string, number>,
      bySource: Object.fromEntries(bySourceRows.map(r => [r.source, r.cnt])) as Record<string, number>,
      byLevel: Object.fromEntries(byLevelRows.map(r => [String(r.abstraction_level), r.cnt])) as Record<string, number>,
      recentWeek: recentRow.cnt,
      totalLinks: linkRow.cnt,
    }
  }

  /** Paginated knowledge index for the browser list view */
  getKnowledgeIndex(
    spaceIds?: string[],
    filters?: SearchFilters,
    page = 1,
    pageSize = 30,
  ): { items: Bubble[]; total: number; page: number; pageSize: number } {
    const db = getDatabase()
    const spaceFilter = buildSpaceFilter(spaceIds)

    let whereClauses = `deleted_at IS NULL${spaceFilter.sql}`
    const params: unknown[] = [...spaceFilter.params]

    if (filters?.types?.length) {
      const { placeholders, params: tp } = buildInClause(filters.types)
      whereClauses += ` AND type IN (${placeholders})`
      params.push(...tp)
    }
    if (filters?.sources?.length) {
      const { placeholders, params: sp } = buildInClause(filters.sources)
      whereClauses += ` AND source IN (${placeholders})`
      params.push(...sp)
    }
    if (filters?.levels?.length) {
      const levelPlaceholders = filters.levels.map(() => '?').join(',')
      whereClauses += ` AND abstraction_level IN (${levelPlaceholders})`
      params.push(...filters.levels)
    }
    if (filters?.tags?.length) {
      for (const tag of filters.tags) {
        whereClauses += ' AND tags LIKE ?'
        params.push(`%"${tag}"%`)
      }
    }
    if (filters?.minConfidence !== undefined) {
      whereClauses += ' AND confidence >= ?'
      params.push(filters.minConfidence)
    }
    if (filters?.since) {
      whereClauses += ' AND created_at >= ?'
      params.push(filters.since)
    }

    const countRow = db.prepare(
      `SELECT COUNT(*) as cnt FROM bubbles WHERE ${whereClauses}`,
    ).get(...params) as { cnt: number }

    const sortCol = filters?.sortBy === 'confidence' ? 'confidence' : filters?.sortBy === 'created' ? 'created_at' : 'updated_at'
    const sortDir = filters?.sortDir === 'asc' ? 'ASC' : 'DESC'
    const offset = (page - 1) * pageSize

    const rows = db.prepare(
      `SELECT * FROM bubbles WHERE ${whereClauses} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, offset) as any[]

    return {
      items: rows.map(rowToBubble),
      total: countRow.cnt,
      page,
      pageSize,
    }
  }
}

// ── Search Filters ─────────────────────────────────────────────

export interface SearchFilters {
  types?: BubbleType[]
  sources?: string[]
  levels?: number[]
  tags?: string[]
  minConfidence?: number
  since?: number
  sortBy?: 'updated' | 'created' | 'confidence'
  sortDir?: 'asc' | 'desc'
}

export interface KnowledgeStats {
  total: number
  byType: Record<string, number>
  bySource: Record<string, number>
  byLevel: Record<string, number>
  recentWeek: number
  totalLinks: number
}

function hasActiveFilters(f: SearchFilters): boolean {
  return !!(f.types?.length || f.sources?.length || f.levels?.length || f.tags?.length || f.minConfidence !== undefined || f.since)
}

function applyFilters(bubbles: Bubble[], f: SearchFilters): Bubble[] {
  return bubbles.filter(b => {
    if (f.types?.length && !f.types.includes(b.type)) return false
    if (f.sources?.length && !f.sources.includes(b.source)) return false
    if (f.levels?.length && !f.levels.includes(b.abstractionLevel)) return false
    if (f.tags?.length && !f.tags.every(t => b.tags.includes(t))) return false
    if (f.minConfidence !== undefined && b.confidence < f.minConfidence) return false
    if (f.since && b.createdAt < f.since) return false
    return true
  })
}

function buildSpaceFilter(spaceIds?: string[]): { sql: string; params: unknown[] } {
  if (!spaceIds?.length) return { sql: '', params: [] }
  const { placeholders, params } = buildInClause(spaceIds)
  return { sql: ` AND space_id IN (${placeholders})`, params }
}
