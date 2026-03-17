import type { Bubble, EmbeddingProvider } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'
import { cosineSimilarity } from '../ai/embeddings.js'
import { getNeighborIds } from './links.js'
import { searchBubbles, getAllMemoryBubbles } from './model.js'
import { logger } from '../shared/logger.js'

interface AggregateResult {
  bubble: Bubble
  score: number
}

// Weights for three-path fusion
const WEIGHTS = {
  keyword: 0.3,   // alpha
  vector: 0.4,    // beta
  graph: 0.2,     // gamma
  recency: 0.1,   // delta
}

export class BubbleAggregator {
  private embeddings: EmbeddingProvider | null = null

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
  }

  async aggregate(query: string, limit = 10): Promise<Bubble[]> {
    const scores = new Map<string, { bubble: Bubble; keyword: number; vector: number; graph: number; recency: number }>()

    // Path 1: Keyword search
    const keywordResults = searchBubbles(query, limit * 2)
    for (let i = 0; i < keywordResults.length; i++) {
      const b = keywordResults[i]
      scores.set(b.id, {
        bubble: b,
        keyword: 1 - i / keywordResults.length, // rank-based score
        vector: 0,
        graph: 0,
        recency: recencyScore(b.accessedAt),
      })
    }

    // Path 2: Vector similarity (if embedding provider available)
    if (this.embeddings) {
      try {
        const queryEmbedding = await this.embeddings.embed(query)
        const allBubbles = getAllBubblesWithEmbeddings()

        for (const b of allBubbles) {
          const sim = cosineSimilarity(queryEmbedding, b.embedding!)
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

    // Weighted fusion
    const results: AggregateResult[] = []
    for (const [, entry] of scores) {
      const score =
        WEIGHTS.keyword * entry.keyword +
        WEIGHTS.vector * entry.vector +
        WEIGHTS.graph * entry.graph +
        WEIGHTS.recency * entry.recency

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

function getAllBubblesWithEmbeddings(): Bubble[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT * FROM bubbles WHERE embedding IS NOT NULL
  `).all() as any[]

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
  }))
}
