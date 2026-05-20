/**
 * Pre-built SQL queries for observability analysis.
 * Used by CLI eval command and potentially future API endpoints.
 */

import { getDatabase } from '../storage/database.js'
import type { ObservationSurvivalScore, CausalAccuracyScore, SystemHealthScore, EvalType } from './types.js'

interface EvalResultRow {
  id: string
  eval_type: string
  space_id: string | null
  run_at: number
  period_start: number
  period_end: number
  scores: string
  sample_size: number
  metadata: string
}

interface TraceRow {
  id: string
  trace_type: string
  started_at: number
  duration_ms: number
  status: string
  metadata: string
}

interface MetricRow {
  name: string
  value: number
  tags: string
  recorded_at: number
}

/**
 * Get the latest eval result for each type.
 */
export function getLatestEvals(): Map<EvalType, { scores: ObservationSurvivalScore | CausalAccuracyScore | SystemHealthScore; runAt: number; sampleSize: number }> {
  const db = getDatabase()
  const types: EvalType[] = ['observation_survival', 'causal_accuracy', 'system_health']
  const results = new Map<EvalType, { scores: ObservationSurvivalScore | CausalAccuracyScore | SystemHealthScore; runAt: number; sampleSize: number }>()

  for (const type of types) {
    const row = db.prepare(`
      SELECT * FROM eval_results WHERE eval_type = ? ORDER BY run_at DESC LIMIT 1
    `).get(type) as EvalResultRow | undefined

    if (row) {
      results.set(type as EvalType, {
        scores: JSON.parse(row.scores),
        runAt: row.run_at,
        sampleSize: row.sample_size,
      })
    }
  }

  return results
}

/**
 * Get eval history for a specific type (for trend analysis).
 */
export function getEvalHistory(evalType: EvalType, days = 7): Array<{ runAt: number; scores: Record<string, unknown>; sampleSize: number }> {
  const db = getDatabase()
  const since = Date.now() - days * 24 * 60 * 60 * 1000

  const rows = db.prepare(`
    SELECT run_at, scores, sample_size FROM eval_results
    WHERE eval_type = ? AND run_at >= ?
    ORDER BY run_at ASC
  `).all(evalType, since) as Array<{ run_at: number; scores: string; sample_size: number }>

  return rows.map(r => ({
    runAt: r.run_at,
    scores: JSON.parse(r.scores),
    sampleSize: r.sample_size,
  }))
}

/**
 * Get recent traces for a trace type.
 */
export function getRecentTraces(traceType?: string, limit = 20): TraceRow[] {
  const db = getDatabase()
  if (traceType) {
    return db.prepare(`
      SELECT id, trace_type, started_at, duration_ms, status, metadata FROM traces
      WHERE trace_type = ? ORDER BY started_at DESC LIMIT ?
    `).all(traceType, limit) as TraceRow[]
  }
  return db.prepare(`
    SELECT id, trace_type, started_at, duration_ms, status, metadata FROM traces
    ORDER BY started_at DESC LIMIT ?
  `).all(limit) as TraceRow[]
}

/**
 * Get spans for a specific trace.
 */
export function getTraceSpans(traceId: string): Array<{ span_type: string; name: string; duration_ms: number; status: string; input_tokens: number | null; output_tokens: number | null }> {
  const db = getDatabase()
  return db.prepare(`
    SELECT span_type, name, duration_ms, status, input_tokens, output_tokens
    FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC
  `).all(traceId) as Array<{ span_type: string; name: string; duration_ms: number; status: string; input_tokens: number | null; output_tokens: number | null }>
}

/**
 * Get metric values for a given name within a time range.
 */
export function getMetricValues(name: string, hoursBack = 24): MetricRow[] {
  const db = getDatabase()
  const since = Date.now() - hoursBack * 60 * 60 * 1000
  return db.prepare(`
    SELECT name, value, tags, recorded_at FROM metrics
    WHERE name = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(name, since) as MetricRow[]
}

/**
 * Get summary stats for a metric (count, sum, avg, min, max).
 */
export function getMetricSummary(name: string, hoursBack = 24): { count: number; sum: number; avg: number; min: number; max: number } | null {
  const db = getDatabase()
  const since = Date.now() - hoursBack * 60 * 60 * 1000
  const row = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(value), 0) as sum,
           COALESCE(AVG(value), 0) as avg, COALESCE(MIN(value), 0) as min, COALESCE(MAX(value), 0) as max
    FROM metrics WHERE name = ? AND recorded_at >= ?
  `).get(name, since) as { count: number; sum: number; avg: number; min: number; max: number }

  return row.count > 0 ? row : null
}
