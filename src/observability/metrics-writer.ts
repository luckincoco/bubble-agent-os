/**
 * MetricsWriter — batched SQLite persistence for metrics, traces, and spans.
 * Uses WAL mode for concurrent reader/writer access.
 */

import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { TraceRecord, SpanRecord, MetricPoint, EvalResult } from './types.js'

export class MetricsWriter {
  init(): void {
    // Verify tables exist (migration should have created them)
    getDatabase()
  }

  writeTrace(trace: TraceRecord): void {
    try {
      const db = getDatabase()
      db.prepare(`
        INSERT INTO traces (id, trace_type, correlation_id, user_id, space_id, started_at, duration_ms, status, error_message, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        trace.id,
        trace.traceType,
        trace.correlationId ?? null,
        trace.userId ?? null,
        trace.spaceId ?? null,
        trace.startedAt,
        trace.durationMs,
        trace.status,
        trace.errorMessage ?? null,
        JSON.stringify(trace.metadata),
      )
    } catch (err) {
      logger.debug('MetricsWriter: failed to write trace', err)
    }
  }

  writeSpans(spans: SpanRecord[]): void {
    if (spans.length === 0) return
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        INSERT INTO trace_spans (id, trace_id, span_type, name, started_at, duration_ms, status, input_tokens, output_tokens, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const transaction = db.transaction(() => {
        for (const span of spans) {
          stmt.run(
            span.id,
            span.traceId,
            span.spanType,
            span.name,
            span.startedAt,
            span.durationMs,
            span.status,
            span.inputTokens ?? null,
            span.outputTokens ?? null,
            JSON.stringify(span.metadata),
          )
        }
      })
      transaction()
    } catch (err) {
      logger.debug('MetricsWriter: failed to write spans', err)
    }
  }

  writeMetrics(points: MetricPoint[]): void {
    if (points.length === 0) return
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        INSERT INTO metrics (name, value, tags, recorded_at)
        VALUES (?, ?, ?, ?)
      `)
      const transaction = db.transaction(() => {
        for (const p of points) {
          stmt.run(
            p.name,
            p.value,
            p.tags ? JSON.stringify(p.tags) : '{}',
            p.recordedAt,
          )
        }
      })
      transaction()
    } catch (err) {
      logger.debug('MetricsWriter: failed to write metrics batch', err)
    }
  }

  writeEvalResult(result: EvalResult): void {
    try {
      const db = getDatabase()
      db.prepare(`
        INSERT INTO eval_results (id, eval_type, space_id, run_at, period_start, period_end, scores, sample_size, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        result.id,
        result.evalType,
        result.spaceId ?? null,
        result.runAt,
        result.periodStart,
        result.periodEnd,
        JSON.stringify(result.scores),
        result.sampleSize,
        JSON.stringify(result.metadata),
      )
    } catch (err) {
      logger.debug('MetricsWriter: failed to write eval result', err)
    }
  }
}
