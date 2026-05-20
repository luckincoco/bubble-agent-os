import type { Bubble, EmbeddingProvider } from '../shared/types.js'
import { getDatabase, buildInClause } from '../storage/database.js'
import { cosineSimilarity } from '../ai/embeddings.js'
import { getNeighborIds } from './links.js'
import { searchBubbles, getAllMemoryBubbles, getBubble } from './model.js'
import { searchFTS, getShortSegments } from './fts.js'
import { extractEntities, findBubblesByEntity } from './entity-extractor.js'
import { logger } from '../shared/logger.js'

/** Lightweight bubble representation for Phase 1 of tiered loading */
export interface BubbleSummaryHit {
  id: string
  type: string
  title: string
  summary: string
  score: number
}

// --- Query intent classification ---
type QueryIntent = 'precise' | 'fuzzy' | 'temporal' | 'aggregate'

// Heuristic patterns for query intent classification
const TEMPORAL_PATTERNS = /今天|昨天|最近|上周|上个月|本月|这周|刚才|今年|去年|本周|近期|最新/
const AGGREGATE_PATTERNS = /一共|总共|多少|合计|汇总|统计|总计|共计|平均|总额|总量|几[个条笔份]|有哪些|所有|列出/
const PRECISE_PATTERNS = /电话|手机|地址|邮箱|编号|名字叫|是谁|哪个|哪位/

function classifyIntent(query: string): QueryIntent {
  if (TEMPORAL_PATTERNS.test(query)) return 'temporal'
  if (AGGREGATE_PATTERNS.test(query)) return 'aggregate'
  if (PRECISE_PATTERNS.test(query)) return 'precise'
  return 'fuzzy'
}

/** Boost factor based on abstraction level and query intent */
function abstractionBoost(level: number, intent: QueryIntent): number {
  const BOOST: Record<QueryIntent, number[]> = {
    precise:   [1.0, 0.6, 0.3],  // L0: find concrete facts
    fuzzy:     [0.7, 1.0, 1.2],  // L1/L2: find high-level understanding
    temporal:  [1.0, 0.8, 0.5],  // L0: has precise timestamps
    aggregate: [0.5, 1.0, 1.3],  // L1/L2: already aggregated results
  }
  return BOOST[intent][Math.min(level, 2)] ?? 1.0
}

export class BubbleAggregator {
  private embeddings: EmbeddingProvider | null = null

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
  }

  async aggregate(query: string, limit = 10, spaceIds?: string[], focusBoostFn?: (content: string) => number): Promise<Bubble[]> {
    const intent = classifyIntent(query)

    // ── Path 1: BM25 via FTS5 (or LIKE fallback) — produces ranked list ──
    const ftsResults = searchFTS(query, limit * 3, spaceIds)
    const keywordResults = searchBubbles(query, limit * 2, spaceIds)

    // Merge FTS + LIKE results: FTS results take priority ordering
    const bm25Ranked: string[] = []
    const seenIds = new Set<string>()
    for (const r of ftsResults) {
      if (!seenIds.has(r.id)) {
        bm25Ranked.push(r.id)
        seenIds.add(r.id)
      }
    }
    for (const b of keywordResults) {
      if (!seenIds.has(b.id)) {
        bm25Ranked.push(b.id)
        seenIds.add(b.id)
      }
    }

    // ── Path 2: Vector similarity — produces ranked list ──
    const vectorRanked: string[] = []
    const needVector = this.embeddings && bm25Ranked.length < limit * 0.6
    if (needVector) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const queryEmbedding = await this.embeddings!.embed(query)
        clearTimeout(timer)

        const candidates = getAllBubblesWithEmbeddings(spaceIds, 200)
        const scored: Array<{ id: string; sim: number }> = []
        for (const b of candidates) {
          const sim = cosineSimilarity(queryEmbedding, b.embedding!)
          if (sim >= 0.3) scored.push({ id: b.id, sim })
        }
        scored.sort((a, b) => b.sim - a.sim)
        for (const s of scored) vectorRanked.push(s.id)
      } catch (err) {
        logger.debug('Vector search skipped:', err instanceof Error ? err.message : String(err))
      }
    }

    // ── Path 3: Graph traversal + Entity KG — produces ranked list ──
    const graphRanked: string[] = []
    const topIds = bm25Ranked.slice(0, 3)
    const graphScores = new Map<string, number>()

    // 3a: Link-based graph traversal (existing)
    for (const id of topIds) {
      const neighborIds = getNeighborIds(id, 2)
      for (const nId of neighborIds) {
        if (!graphScores.has(nId)) {
          graphScores.set(nId, 0)
        }
        graphScores.set(nId, graphScores.get(nId)! + 1)
      }
    }

    // 3b: Entity-based KG expansion — find bubbles sharing entities with query
    try {
      const queryEntities = extractEntities(query)
      for (const entity of queryEntities.slice(0, 5)) {
        const relatedIds = findBubblesByEntity(entity.text, entity.type, 10)
        for (const rId of relatedIds) {
          graphScores.set(rId, (graphScores.get(rId) || 0) + 1)
        }
      }
    } catch {
      // Entity index might not be populated yet; silently skip
    }
    // Sort by co-occurrence count, then add to ranked list
    const graphEntries = [...graphScores.entries()].sort((a, b) => b[1] - a[1])
    for (const [id] of graphEntries) graphRanked.push(id)

    // ── RRF Fusion (k=60) ──
    const RRF_K = 60
    const rrfScores = new Map<string, number>()

    // BM25 contribution
    for (let i = 0; i < bm25Ranked.length; i++) {
      const id = bm25Ranked[i]
      rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + i + 1))
    }
    // Vector contribution
    for (let i = 0; i < vectorRanked.length; i++) {
      const id = vectorRanked[i]
      rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + i + 1))
    }
    // Graph contribution
    for (let i = 0; i < graphRanked.length; i++) {
      const id = graphRanked[i]
      rrfScores.set(id, (rrfScores.get(id) || 0) + 1 / (RRF_K + i + 1))
    }

    // ── Post-RRF adjustments: recency, focus, abstraction, pin ──
    const allIds = [...rrfScores.keys()]
    const bubbleCache = new Map<string, Bubble>()

    // Batch-load keyword results (already fetched)
    for (const b of keywordResults) bubbleCache.set(b.id, b)

    // Load any missing bubbles
    for (const id of allIds) {
      if (!bubbleCache.has(id)) {
        const b = getBubble(id, spaceIds)
        if (b) bubbleCache.set(id, b)
      }
    }

    interface ScoredResult { bubble: Bubble; score: number }
    const results: ScoredResult[] = []

    for (const [id, rrfBase] of rrfScores) {
      const bubble = bubbleCache.get(id)
      if (!bubble) continue

      let score = rrfBase

      // Apply focus boost
      score += focusBoostFn?.(bubble.content) ?? 0

      // Apply tier multiplier (recency)
      score *= tierMultiplier(bubble.accessedAt, bubble.pinned)

      // Apply abstraction level boost
      score *= abstractionBoost(bubble.abstractionLevel ?? 0, intent)

      // Pin boost
      if (bubble.pinned) score += 0.005

      results.push({ bubble, score })
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit).map((r) => r.bubble)
  }

  /**
   * Two-phase tiered retrieval:
   * Phase 1: Run full aggregate but return only lightweight summaries (saves token budget)
   * Phase 2: Caller uses loadFullBubbles() to fetch full content for top-K
   */
  async aggregateSummaries(query: string, limit = 20, spaceIds?: string[], focusBoostFn?: (content: string) => number): Promise<BubbleSummaryHit[]> {
    const bubbles = await this.aggregate(query, limit, spaceIds, focusBoostFn)

    // Convert full bubbles to lightweight summaries with re-computed scores
    const intent = classifyIntent(query)
    return bubbles.map((b, i) => ({
      id: b.id,
      type: b.type,
      title: b.title,
      summary: b.summary || b.content.slice(0, 100).replace(/[\n\r]+/g, ' '),
      score: 1 - i / bubbles.length, // normalized rank score
    }))
  }

  /**
   * Phase 2: Load full bubble content for selected IDs
   */
  loadFullBubbles(ids: string[]): Bubble[] {
    const results: Bubble[] = []
    for (const id of ids) {
      const b = getBubble(id)
      if (b) results.push(b)
    }
    return results
  }
}

/** Memory tier multiplier: recent bubbles rank higher, old ones are deprioritized. */
export function tierMultiplier(accessedAt: number, pinned: boolean): number {
  if (pinned) return 1.0
  const hours = (Date.now() - accessedAt) / (1000 * 60 * 60)
  if (hours <= 1) return 1.0        // Tier 0: working memory
  if (hours <= 168) return 0.8      // Tier 1: active (7 days)
  if (hours <= 2160) return 0.5     // Tier 2: long-term (90 days)
  return 0.2                        // Tier 3: archive
}

function getAllBubblesWithEmbeddings(spaceIds?: string[], maxRows = 200): Bubble[] {
  const db = getDatabase()
  let sql = 'SELECT * FROM bubbles WHERE embedding IS NOT NULL'
  const params: unknown[] = []

  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }

  sql += ' ORDER BY accessed_at DESC LIMIT ?'
  params.push(maxRows)

  const rows = db.prepare(sql).all(...params) as any[]

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata || '{}'),
    tags: JSON.parse(row.tags || '[]'),
    embedding: JSON.parse(row.embedding),
    links: [],
    source: row.source,
    confidence: row.confidence,
    decayRate: row.decay_rate,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    spaceId: row.space_id ?? undefined,
    abstractionLevel: row.abstraction_level ?? 0,
    summary: row.summary ?? undefined,
  }))
}
