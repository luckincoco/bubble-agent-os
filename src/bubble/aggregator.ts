import type { Bubble, EmbeddingProvider } from '../shared/types.js'
import { getDatabase, buildInClause } from '../storage/database.js'
import { cosineSimilarity } from '../ai/embeddings.js'
import { getNeighborIds } from './links.js'
import { searchBubbles, getAllMemoryBubbles } from './model.js'
import { logger } from '../shared/logger.js'

interface AggregateResult {
  bubble: Bubble
  score: number
}

// --- Dynamic weight profiles based on query intent ---
type QueryIntent = 'precise' | 'fuzzy' | 'temporal' | 'aggregate'

interface WeightProfile {
  keyword: number
  vector: number
  graph: number
  recency: number
}

const WEIGHT_PROFILES: Record<QueryIntent, WeightProfile> = {
  precise:   { keyword: 0.55, vector: 0.25, graph: 0.10, recency: 0.10 },
  fuzzy:     { keyword: 0.15, vector: 0.45, graph: 0.30, recency: 0.10 },
  temporal:  { keyword: 0.20, vector: 0.20, graph: 0.10, recency: 0.50 },
  aggregate: { keyword: 0.35, vector: 0.30, graph: 0.15, recency: 0.20 },
}

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
    const W = WEIGHT_PROFILES[intent]

    const scores = new Map<string, { bubble: Bubble; keyword: number; vector: number; graph: number; recency: number }>()

    // Path 1: Keyword search (always fast — SQLite)
    const keywordResults = searchBubbles(query, limit * 2, spaceIds)
    for (let i = 0; i < keywordResults.length; i++) {
      const b = keywordResults[i]
      const pinBoost = b.pinned ? 0.3 : 0
      scores.set(b.id, {
        bubble: b,
        keyword: 1 - i / keywordResults.length + pinBoost,
        vector: 0,
        graph: 0,
        recency: recencyScore(b.accessedAt),
      })
    }

    // Path 2: Vector similarity — SKIP if keyword results are strong enough
    // This is the expensive path (embedding API call + full scan)
    const needVector = this.embeddings && keywordResults.length < limit * 0.6
    if (needVector) {
      try {
        // Timeout: abort embedding if takes > 3 seconds
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const queryEmbedding = await this.embeddings!.embed(query)
        clearTimeout(timer)

        // Only scan recent bubbles (limit 200) to avoid full table scan
        const candidates = getAllBubblesWithEmbeddings(spaceIds, 200)

        for (const b of candidates) {
          const sim = cosineSimilarity(queryEmbedding, b.embedding!)
          if (sim < 0.3) continue  // Skip low-similarity early
          const entry = scores.get(b.id)
          if (entry) {
            entry.vector = sim
          } else {
            scores.set(b.id, {
              bubble: b,
              keyword: 0,
              vector: sim,
              graph: 0,
              recency: recencyScore(b.accessedAt),
            })
          }
        }
      } catch (err) {
        // Embedding timeout or failure — gracefully skip
        logger.debug('Vector search skipped:', err instanceof Error ? err.message : String(err))
      }
    }

    // Path 3: Graph traversal - boost neighbors of top keyword results
    const topIds = keywordResults.slice(0, 3).map((b) => b.id)
    for (const id of topIds) {
      const neighborIds = getNeighborIds(id, 2)
      for (const nId of neighborIds) {
        const entry = scores.get(nId)
        if (entry) {
          entry.graph = 0.8
        }
      }
    }

    // Dynamic weighted fusion
    const results: AggregateResult[] = []
    for (const [, entry] of scores) {
      let score =
        W.keyword * entry.keyword +
        W.vector * entry.vector +
        W.graph * entry.graph +
        W.recency * entry.recency

      // Apply focus boost from conversation tracking
      score += focusBoostFn?.(entry.bubble.content) ?? 0

      // Apply tier-based memory level multiplier
      score *= tierMultiplier(entry.bubble.accessedAt, entry.bubble.pinned)

      // Apply abstraction level boost
      score *= abstractionBoost(entry.bubble.abstractionLevel ?? 0, intent)

      if (score > 0.01) {
        results.push({ bubble: entry.bubble, score })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit).map((r) => r.bubble)
  }
}

function recencyScore(accessedAt: number): number {
  const hoursSince = (Date.now() - accessedAt) / (1000 * 60 * 60)
  return Math.exp(-hoursSince / 168) // decay over ~1 week
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
  }))
}
