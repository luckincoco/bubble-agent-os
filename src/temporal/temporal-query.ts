/**
 * TemporalQuery — time-bounded graph queries for the temporal knowledge graph.
 * Answers questions like "Who was our supplier for HRB400 in March 2026?"
 */

import { getDatabase } from '../storage/database.js'
import type { Bubble, BubbleType } from '../shared/types.js'
import { rowToBubble } from '../bubble/model.js'

export interface TemporalQueryOptions {
  /** Point in time to query state at (ms timestamp). Null = current. */
  asOf?: number
  /** Time range start (for range queries) */
  since?: number
  /** Time range end (for range queries) */
  until?: number
  /** Space filter */
  spaceId?: string
  /** Maximum results */
  limit?: number
}

interface BubbleRow {
  id: string
  type: BubbleType
  title: string
  content: string
  metadata: string
  tags: string
  embedding: string | null
  source: string
  confidence: number
  decay_rate: number
  pinned: number
  created_at: number
  updated_at: number
  accessed_at: number
  space_id: string | null
  abstraction_level: number
  summary: string | null
  valid_from: number | null
  valid_until: number | null
  episode_id: string | null
}

/**
 * Get bubbles that were valid at a specific point in time.
 */
export function getBubblesAsOf(asOf: number, opts: { spaceId?: string; type?: string; limit?: number } = {}): Bubble[] {
  const db = getDatabase()
  const conditions = [
    '(valid_from IS NULL OR valid_from <= ?)',
    '(valid_until IS NULL OR valid_until > ?)',
  ]
  const params: unknown[] = [asOf, asOf]

  if (opts.spaceId) { conditions.push('space_id = ?'); params.push(opts.spaceId) }
  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }

  const limit = opts.limit || 50
  const query = `SELECT * FROM bubbles WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ${limit}`

  const rows = db.prepare(query).all(...params) as BubbleRow[]
  return rows.map(r => rowToBubble(r ))
}

/**
 * Find entities connected to a source bubble at a specific time.
 * "Who was the supplier of product X at time T?"
 */
export function getNeighborsAsOf(bubbleId: string, asOf: number, opts: { relation?: string; direction?: 'outgoing' | 'incoming' | 'both' } = {}): Array<{ bubble: Bubble; relation: string; weight: number }> {
  const db = getDatabase()
  const temporalCondition = '(bl.valid_from IS NULL OR bl.valid_from <= ?) AND (bl.valid_until IS NULL OR bl.valid_until > ?)'
  const direction = opts.direction || 'both'
  const conditions: string[] = [temporalCondition]
  const params: unknown[] = [asOf, asOf]

  if (opts.relation) { conditions.push('bl.relation = ?'); params.push(opts.relation) }

  let dirCondition: string
  if (direction === 'outgoing') {
    dirCondition = 'bl.source_id = ?'
  } else if (direction === 'incoming') {
    dirCondition = 'bl.target_id = ?'
  } else {
    dirCondition = '(bl.source_id = ? OR bl.target_id = ?)'
    params.push(bubbleId)
  }
  conditions.push(dirCondition)
  params.push(bubbleId)

  // Also ensure the target bubble itself was valid at that time
  const bubbleTemporalCondition = '(b.valid_from IS NULL OR b.valid_from <= ?) AND (b.valid_until IS NULL OR b.valid_until > ?)'
  conditions.push(bubbleTemporalCondition)
  params.push(asOf, asOf)

  const neighborCol = direction === 'incoming' ? 'bl.source_id' : direction === 'outgoing' ? 'bl.target_id' : `CASE WHEN bl.source_id = '${bubbleId}' THEN bl.target_id ELSE bl.source_id END`

  const query = `
    SELECT b.*, bl.relation, bl.weight
    FROM bubble_links bl
    JOIN bubbles b ON b.id = ${neighborCol}
    WHERE ${conditions.join(' AND ')}
    ORDER BY bl.weight DESC
    LIMIT 20
  `

  // For 'both' direction we need a different approach
  if (direction === 'both') {
    const outgoing = getNeighborsAsOf(bubbleId, asOf, { ...opts, direction: 'outgoing' })
    const incoming = getNeighborsAsOf(bubbleId, asOf, { ...opts, direction: 'incoming' })
    const seen = new Set<string>()
    const result: Array<{ bubble: Bubble; relation: string; weight: number }> = []
    for (const item of [...outgoing, ...incoming]) {
      if (!seen.has(item.bubble.id)) {
        seen.add(item.bubble.id)
        result.push(item)
      }
    }
    return result
  }

  const rows = db.prepare(query).all(...params) as Array<BubbleRow & { relation: string; weight: number }>
  return rows.map(r => ({
    bubble: rowToBubble(r ),
    relation: r.relation,
    weight: r.weight,
  }))
}

/**
 * Timeline query: get all versions/states of a relationship over time.
 * "Show me all suppliers we've ever had for product X"
 */
export function getRelationTimeline(sourceId: string, relation: string): Array<{ targetId: string; targetTitle: string; validFrom: number | null; validUntil: number | null; weight: number }> {
  const db = getDatabase()

  const rows = db.prepare(`
    SELECT bl.target_id, b.title as target_title, bl.valid_from, bl.valid_until, bl.weight
    FROM bubble_links bl
    JOIN bubbles b ON b.id = bl.target_id
    WHERE bl.source_id = ? AND bl.relation = ?
    ORDER BY bl.valid_from ASC
  `).all(sourceId, relation) as Array<{ target_id: string; target_title: string; valid_from: number | null; valid_until: number | null; weight: number }>

  return rows.map(r => ({
    targetId: r.target_id,
    targetTitle: r.target_title,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    weight: r.weight,
  }))
}

/**
 * Get bubbles that were invalidated (superseded) within a time range.
 * Useful for understanding what changed.
 */
export function getInvalidatedBubbles(since: number, until?: number, spaceId?: string): Bubble[] {
  const db = getDatabase()
  const conditions = ['valid_until IS NOT NULL', 'valid_until >= ?']
  const params: unknown[] = [since]

  if (until) { conditions.push('valid_until <= ?'); params.push(until) }
  if (spaceId) { conditions.push('space_id = ?'); params.push(spaceId) }

  const rows = db.prepare(
    `SELECT * FROM bubbles WHERE ${conditions.join(' AND ')} ORDER BY valid_until DESC LIMIT 50`
  ).all(...params) as BubbleRow[]

  return rows.map(r => rowToBubble(r ))
}

/**
 * Count active vs invalidated knowledge (for diagnostics).
 */
export function getTemporalStats(spaceId?: string): { active: number; invalidated: number; total: number } {
  const db = getDatabase()
  const whereSpace = spaceId ? 'WHERE space_id = ?' : ''
  const params = spaceId ? [spaceId] : []

  const total = (db.prepare(`SELECT COUNT(*) as cnt FROM bubbles ${whereSpace}`).get(...params) as { cnt: number }).cnt
  const invalidated = (db.prepare(`SELECT COUNT(*) as cnt FROM bubbles WHERE valid_until IS NOT NULL ${spaceId ? 'AND space_id = ?' : ''}`).get(...params) as { cnt: number }).cnt

  return { active: total - invalidated, invalidated, total }
}
