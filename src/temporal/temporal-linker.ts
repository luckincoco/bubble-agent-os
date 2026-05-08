/**
 * TemporalLinker — manages temporal validity lifecycle for bubble_links.
 * Handles creation with valid_from, invalidation with valid_until,
 * and contradiction-based auto-expiry.
 */

import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface TemporalLinkInput {
  sourceId: string
  targetId: string
  relation: string
  weight?: number
  linkSource?: string
  episodeId?: string
  validFrom?: number
  metadata?: Record<string, unknown>
}

export interface TemporalLink {
  id: number
  sourceId: string
  targetId: string
  relation: string
  weight: number
  linkSource: string
  validFrom: number | null
  validUntil: number | null
  episodeId: string | null
  metadata: Record<string, unknown>
  createdAt: number
}

interface LinkRow {
  id: number
  source_id: string
  target_id: string
  relation: string
  weight: number
  link_source: string
  valid_from: number | null
  valid_until: number | null
  episode_id: string | null
  metadata: string
  created_at: number
}

function rowToLink(row: LinkRow): TemporalLink {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    relation: row.relation,
    weight: row.weight,
    linkSource: row.link_source,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    episodeId: row.episode_id,
    metadata: JSON.parse(row.metadata || '{}'),
    createdAt: row.created_at,
  }
}

/**
 * Create a temporally-bounded link.
 */
export function createTemporalLink(input: TemporalLinkInput): void {
  const db = getDatabase()
  const now = Date.now()

  db.prepare(`
    INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, episode_id, valid_from, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.sourceId,
    input.targetId,
    input.relation,
    input.weight ?? 1.0,
    input.linkSource ?? 'system',
    input.episodeId ?? null,
    input.validFrom ?? now,
    JSON.stringify(input.metadata || {}),
    now,
  )
}

/**
 * Invalidate a link — sets valid_until timestamp.
 * The link remains in the graph for historical queries but is hidden by default.
 */
export function invalidateLink(sourceId: string, targetId: string, relation: string, reason?: string): number {
  const db = getDatabase()
  const now = Date.now()
  const meta = reason ? JSON.stringify({ invalidationReason: reason }) : undefined

  // Find active links matching criteria
  const links = db.prepare(
    'SELECT id, metadata FROM bubble_links WHERE source_id = ? AND target_id = ? AND relation = ? AND valid_until IS NULL'
  ).all(sourceId, targetId, relation) as Array<{ id: number; metadata: string }>

  for (const link of links) {
    if (meta) {
      // Merge reason into existing metadata
      const existing = JSON.parse(link.metadata || '{}')
      existing.invalidationReason = reason
      existing.invalidatedAt = now
      db.prepare('UPDATE bubble_links SET valid_until = ?, metadata = ? WHERE id = ?')
        .run(now, JSON.stringify(existing), link.id)
    } else {
      db.prepare('UPDATE bubble_links SET valid_until = ? WHERE id = ?').run(now, link.id)
    }
  }

  if (links.length > 0) {
    logger.info(`TemporalLinker: invalidated ${links.length} link(s) [${sourceId}→${targetId} rel=${relation}]`)
  }
  return links.length
}

/**
 * Invalidate all outgoing links of a specific relation from a source.
 * Used when replacing a relationship (e.g., "new supplier replaces old one").
 */
export function invalidateOutgoingLinks(sourceId: string, relation: string, reason?: string): number {
  const db = getDatabase()
  const now = Date.now()

  const result = db.prepare(
    'UPDATE bubble_links SET valid_until = ? WHERE source_id = ? AND relation = ? AND valid_until IS NULL'
  ).run(now, sourceId, relation)

  if (result.changes > 0) {
    logger.info(`TemporalLinker: invalidated ${result.changes} outgoing link(s) from ${sourceId} rel=${relation}`)
  }
  return result.changes
}

/**
 * Get active links for a bubble (valid_until IS NULL).
 */
export function getActiveLinks(bubbleId: string, direction: 'outgoing' | 'incoming' | 'both' = 'both'): TemporalLink[] {
  const db = getDatabase()
  let rows: LinkRow[]

  if (direction === 'outgoing') {
    rows = db.prepare(
      'SELECT * FROM bubble_links WHERE source_id = ? AND valid_until IS NULL'
    ).all(bubbleId) as LinkRow[]
  } else if (direction === 'incoming') {
    rows = db.prepare(
      'SELECT * FROM bubble_links WHERE target_id = ? AND valid_until IS NULL'
    ).all(bubbleId) as LinkRow[]
  } else {
    rows = db.prepare(
      'SELECT * FROM bubble_links WHERE (source_id = ? OR target_id = ?) AND valid_until IS NULL'
    ).all(bubbleId, bubbleId) as LinkRow[]
  }

  return rows.map(rowToLink)
}

/**
 * Get links valid at a specific point in time (for historical queries).
 */
export function getLinksAsOf(bubbleId: string, asOf: number, direction: 'outgoing' | 'incoming' | 'both' = 'both'): TemporalLink[] {
  const db = getDatabase()
  const temporalCondition = '(valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?)'

  let query: string
  let params: unknown[]

  if (direction === 'outgoing') {
    query = `SELECT * FROM bubble_links WHERE source_id = ? AND ${temporalCondition}`
    params = [bubbleId, asOf, asOf]
  } else if (direction === 'incoming') {
    query = `SELECT * FROM bubble_links WHERE target_id = ? AND ${temporalCondition}`
    params = [bubbleId, asOf, asOf]
  } else {
    query = `SELECT * FROM bubble_links WHERE (source_id = ? OR target_id = ?) AND ${temporalCondition}`
    params = [bubbleId, bubbleId, asOf, asOf]
  }

  const rows = db.prepare(query).all(...params) as LinkRow[]
  return rows.map(rowToLink)
}

/**
 * Check if a new link would contradict an existing active link.
 * Returns the conflicting link if found, null otherwise.
 */
export function findContradiction(sourceId: string, relation: string, newTargetId: string): TemporalLink | null {
  const db = getDatabase()

  // A contradiction exists if there's already an active link with the same source+relation
  // but pointing to a DIFFERENT target (e.g., "supplier_of" can only have one active target)
  const existing = db.prepare(
    'SELECT * FROM bubble_links WHERE source_id = ? AND relation = ? AND target_id != ? AND valid_until IS NULL LIMIT 1'
  ).get(sourceId, relation, newTargetId) as LinkRow | undefined

  return existing ? rowToLink(existing) : null
}

/**
 * Auto-resolve contradiction: invalidate old link and create new one.
 * Returns true if a contradiction was resolved.
 */
export function resolveContradiction(input: TemporalLinkInput): boolean {
  const contradiction = findContradiction(input.sourceId, input.relation, input.targetId)
  if (!contradiction) return false

  // Invalidate the old link
  invalidateLink(contradiction.sourceId, contradiction.targetId, contradiction.relation, 'superseded by new information')

  // Create the new link
  createTemporalLink(input)

  logger.info(`TemporalLinker: resolved contradiction — old target ${contradiction.targetId} superseded by ${input.targetId} for relation ${input.relation}`)
  return true
}
