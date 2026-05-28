/**
 * Decision Trace — records why a matching decision was made.
 *
 * Phase 2: every notification push records its matching rationale,
 * so we can later learn what worked and what didn't.
 *
 * Trace = producer side (what we decided, why)
 * Feedback = consumer side (what user did with it)
 * They link via source_type + trigger_id.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface TraceMatchedItem {
  label: string
  matchReason: string
  confidence: number
}

export interface DecisionTrace {
  id: string
  sourceType: string
  triggerId: string
  matchedItems: TraceMatchedItem[]
  pushed: boolean
  executionMs: number
  createdAt: number
}

export interface TraceQuery {
  sourceType?: string
  limit?: number
  since?: number
}

/** Record a decision trace. */
export function recordDecisionTrace(params: {
  sourceType: string
  triggerId?: string
  matchedItems?: TraceMatchedItem[]
  pushed?: boolean
  executionMs?: number
}): DecisionTrace {
  const db = getDatabase()
  const now = Date.now()
  const trace: DecisionTrace = {
    id: ulid(),
    sourceType: params.sourceType,
    triggerId: params.triggerId || '',
    matchedItems: params.matchedItems || [],
    pushed: params.pushed ?? true,
    executionMs: params.executionMs ?? 0,
    createdAt: now,
  }

  db.prepare(
    `INSERT INTO decision_traces (id, source_type, trigger_id, matched_items, pushed, execution_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    trace.id,
    trace.sourceType,
    trace.triggerId,
    JSON.stringify(trace.matchedItems),
    trace.pushed ? 1 : 0,
    trace.executionMs,
    trace.createdAt,
  )

  return trace
}

/** Query decision traces. */
export function queryDecisionTraces(query: TraceQuery = {}): DecisionTrace[] {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (query.sourceType) { conditions.push('source_type = ?'); params.push(query.sourceType) }
  if (query.since) { conditions.push('created_at >= ?'); params.push(query.since) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = query.limit || 50

  const rows = db.prepare(`SELECT * FROM decision_traces ${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...params) as Array<Record<string, unknown>>

  return rows.map(r => ({
    id: r.id as string,
    sourceType: r.source_type as string,
    triggerId: r.trigger_id as string,
    matchedItems: JSON.parse(r.matched_items as string || '[]') as TraceMatchedItem[],
    pushed: !!(r.pushed as number),
    executionMs: r.execution_ms as number,
    createdAt: r.created_at as number,
  }))
}

/** Get trace stats: count, avg match items, avg execution ms, by source type. */
export function getTraceStats(sourceType?: string): {
  totalTraces: number
  avgMatchItems: number
  avgExecutionMs: number
  pushRate: number
} {
  const db = getDatabase()
  const conditions: string[] = []
  const params: unknown[] = []

  if (sourceType) { conditions.push('source_type = ?'); params.push(sourceType) }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const row = db.prepare(
    `SELECT
       COUNT(*) as total,
       COALESCE(AVG(json_array_length(matched_items)), 0) as avg_items,
       COALESCE(AVG(execution_ms), 0) as avg_ms,
       COALESCE(AVG(CAST(pushed AS REAL)), 0) as push_rate
     FROM decision_traces ${where}`
  ).get(...params) as { total: number; avg_items: number; avg_ms: number; push_rate: number } | undefined

  if (!row) return { totalTraces: 0, avgMatchItems: 0, avgExecutionMs: 0, pushRate: 0 }

  return {
    totalTraces: row.total,
    avgMatchItems: Math.round(row.avg_items * 10) / 10,
    avgExecutionMs: Math.round(row.avg_ms),
    pushRate: Math.round(row.push_rate * 100),
  }
}

/**
 * Get combined stats: decision traces + feedback events, merged by source type.
 */
export function getCombinedStats(sourceType: string): {
  traces: ReturnType<typeof getTraceStats>
  feedback: Record<string, number>
} {
  return {
    traces: getTraceStats(sourceType),
    feedback: getCombinedFeedbackStats(sourceType),
  }
}

function getCombinedFeedbackStats(sourceType: string): Record<string, number> {
  const db = getDatabase()
  const rows = db.prepare(
    `SELECT action, COUNT(*) as cnt FROM feedback_events WHERE source_type = ? GROUP BY action`
  ).all(sourceType) as Array<{ action: string; cnt: number }>

  const stats: Record<string, number> = {}
  for (const r of rows) stats[r.action] = r.cnt

  // Derived metrics
  const delivered = stats.delivered || 0
  if (delivered > 0) {
    stats.readRate = Math.round(((stats.read || 0) / delivered) * 100)
    stats.actionRate = Math.round(((stats.acted || 0) / delivered) * 100)
    stats.dismissRate = Math.round(((stats.dismissed || 0) / delivered) * 100)
  }

  return stats
}
