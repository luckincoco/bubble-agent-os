/**
 * Feedback Store — records user interactions with pushed information.
 *
 * Phase 1 feedback loop core: every delivered/read/acted/dismissed event
 * is stored here so the matching engine can learn from user behavior.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export type FeedbackAction = 'delivered' | 'read' | 'dismissed' | 'marked_useful' | 'marked_useless' | 'acted'

export interface FeedbackEvent {
  id: string
  userId: string
  spaceId: string
  sourceType: string
  sourceId: string
  action: FeedbackAction
  context: Record<string, unknown>
  createdAt: number
}

export interface FeedbackQuery {
  sourceType?: string
  sourceId?: string
  action?: FeedbackAction
  userId?: string
  limit?: number
  since?: number
}

/** Record a feedback event. */
export function recordFeedback(
  userId: string,
  sourceType: string,
  action: FeedbackAction,
  options?: {
    spaceId?: string
    sourceId?: string
    context?: Record<string, unknown>
  },
): FeedbackEvent {
  const db = getDatabase()
  const now = Date.now()
  const event: FeedbackEvent = {
    id: ulid(),
    userId,
    spaceId: options?.spaceId || '',
    sourceType,
    sourceId: options?.sourceId || '',
    action,
    context: options?.context || {},
    createdAt: now,
  }

  db.prepare(
    `INSERT INTO feedback_events (id, user_id, space_id, source_type, source_id, action, context, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event.id, event.userId, event.spaceId, event.sourceType, event.sourceId, event.action, JSON.stringify(event.context), event.createdAt)

  return event
}

/** Query feedback events. */
export function queryFeedback(query: FeedbackQuery): FeedbackEvent[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.sourceType) { conditions.push('source_type = ?'); params.push(query.sourceType) }
  if (query.sourceId) { conditions.push('source_id = ?'); params.push(query.sourceId) }
  if (query.action) { conditions.push('action = ?'); params.push(query.action) }
  if (query.userId) { conditions.push('user_id = ?'); params.push(query.userId) }
  if (query.since) { conditions.push('created_at >= ?'); params.push(query.since) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = query.limit || 100

  const rows = db.prepare(`SELECT * FROM feedback_events ${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...params) as Array<Record<string, unknown>>

  return rows.map(r => ({
    id: r.id as string,
    userId: r.user_id as string,
    spaceId: r.space_id as string,
    sourceType: r.source_type as string,
    sourceId: r.source_id as string,
    action: r.action as FeedbackAction,
    context: JSON.parse(r.context as string || '{}'),
    createdAt: r.created_at as number,
  }))
}

/** Get feedback stats by action type for a source. */
export function getFeedbackStats(sourceType: string, sourceId?: string): Record<string, number> {
  const db = getDatabase()
  const conditions = ['source_type = ?']
  const params: unknown[] = [sourceType]
  if (sourceId) { conditions.push('source_id = ?'); params.push(sourceId) }

  const where = `WHERE ${conditions.join(' AND ')}`
  const rows = db.prepare(`SELECT action, COUNT(*) as cnt FROM feedback_events ${where} GROUP BY action`).all(...params) as Array<{ action: string; cnt: number }>

  const stats: Record<string, number> = {}
  for (const r of rows) stats[r.action] = r.cnt
  return stats
}

/**
 * Wire feedback recording into existing push flows.
 * Called after a Feishu message is sent to record "delivered".
 */
export function recordDelivery(
  userId: string,
  sourceType: string,
  context?: Record<string, unknown>,
): FeedbackEvent {
  return recordFeedback(userId, sourceType, 'delivered', { context })
}
