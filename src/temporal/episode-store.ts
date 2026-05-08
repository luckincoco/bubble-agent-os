/**
 * EpisodeStore — CRUD for episodes table.
 * Episodes are immutable raw records of interactions/events.
 * They serve as the non-lossy data source from which entities and relations are extracted.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export type EpisodeType = 'conversation' | 'business' | 'system'
export type EpisodeSource = 'feishu' | 'wecom' | 'scheduler' | 'admin' | 'api' | 'cli'

export interface Episode {
  id: string
  type: EpisodeType
  source: EpisodeSource
  actorId: string | null
  spaceId: string | null
  content: string
  summary: string | null
  metadata: Record<string, unknown>
  parentEpisodeId: string | null
  createdAt: number
}

export interface CreateEpisodeInput {
  type: EpisodeType
  source: EpisodeSource
  actorId?: string
  spaceId?: string
  content: string
  summary?: string
  metadata?: Record<string, unknown>
  parentEpisodeId?: string
}

export interface EpisodeQueryOptions {
  type?: EpisodeType
  source?: EpisodeSource
  actorId?: string
  spaceId?: string
  since?: number
  until?: number
  limit?: number
  offset?: number
}

// ── Row mapping ─────────────────────────────────────────────────

interface EpisodeRow {
  id: string
  type: string
  source: string
  actor_id: string | null
  space_id: string | null
  content: string
  summary: string | null
  metadata: string
  parent_episode_id: string | null
  created_at: number
}

function rowToEpisode(row: EpisodeRow): Episode {
  return {
    id: row.id,
    type: row.type as EpisodeType,
    source: row.source as EpisodeSource,
    actorId: row.actor_id,
    spaceId: row.space_id,
    content: row.content,
    summary: row.summary,
    metadata: JSON.parse(row.metadata || '{}'),
    parentEpisodeId: row.parent_episode_id,
    createdAt: row.created_at,
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Create a new episode. Returns the created episode.
 */
export function createEpisode(input: CreateEpisodeInput): Episode {
  const db = getDatabase()
  const id = ulid()
  const now = Date.now()

  db.prepare(`
    INSERT INTO episodes (id, type, source, actor_id, space_id, content, summary, metadata, parent_episode_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.type,
    input.source,
    input.actorId ?? null,
    input.spaceId ?? null,
    input.content,
    input.summary ?? null,
    JSON.stringify(input.metadata || {}),
    input.parentEpisodeId ?? null,
    now,
  )

  return {
    id,
    type: input.type,
    source: input.source,
    actorId: input.actorId ?? null,
    spaceId: input.spaceId ?? null,
    content: input.content,
    summary: input.summary ?? null,
    metadata: input.metadata || {},
    parentEpisodeId: input.parentEpisodeId ?? null,
    createdAt: now,
  }
}

/**
 * Get a single episode by ID.
 */
export function getEpisodeById(id: string): Episode | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(id) as EpisodeRow | undefined
  return row ? rowToEpisode(row) : null
}

/**
 * Query episodes with filters.
 */
export function queryEpisodes(opts: EpisodeQueryOptions = {}): Episode[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }
  if (opts.source) { conditions.push('source = ?'); params.push(opts.source) }
  if (opts.actorId) { conditions.push('actor_id = ?'); params.push(opts.actorId) }
  if (opts.spaceId) { conditions.push('space_id = ?'); params.push(opts.spaceId) }
  if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since) }
  if (opts.until) { conditions.push('created_at <= ?'); params.push(opts.until) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = opts.limit ? `LIMIT ${opts.limit}` : 'LIMIT 100'
  const offset = opts.offset ? `OFFSET ${opts.offset}` : ''

  const rows = db.prepare(
    `SELECT * FROM episodes ${where} ORDER BY created_at DESC ${limit} ${offset}`
  ).all(...params) as EpisodeRow[]

  return rows.map(rowToEpisode)
}

/**
 * Get conversation thread (episode + all children following it).
 */
export function getEpisodeThread(episodeId: string, limit = 50): Episode[] {
  const db = getDatabase()

  // Get the root episode
  const root = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId) as EpisodeRow | undefined
  if (!root) return []

  // Get all episodes in this thread (sharing same parent or being children of this)
  const children = db.prepare(
    'SELECT * FROM episodes WHERE parent_episode_id = ? ORDER BY created_at ASC LIMIT ?'
  ).all(episodeId, limit) as EpisodeRow[]

  return [rowToEpisode(root), ...children.map(rowToEpisode)]
}

/**
 * Get recent episodes by actor (for context building).
 */
export function getRecentEpisodesByActor(actorId: string, limit = 20): Episode[] {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT * FROM episodes WHERE actor_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(actorId, limit) as EpisodeRow[]
  return rows.map(rowToEpisode)
}

/**
 * Count episodes (for diagnostics).
 */
export function countEpisodes(opts: { type?: EpisodeType; since?: number } = {}): number {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (opts.type) { conditions.push('type = ?'); params.push(opts.type) }
  if (opts.since) { conditions.push('created_at >= ?'); params.push(opts.since) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return (db.prepare(`SELECT COUNT(*) as cnt FROM episodes ${where}`).get(...params) as { cnt: number }).cnt
}

/**
 * Update episode summary (the only mutable field — for async LLM summarization).
 */
export function updateEpisodeSummary(episodeId: string, summary: string): void {
  const db = getDatabase()
  db.prepare('UPDATE episodes SET summary = ? WHERE id = ?').run(summary, episodeId)
}
