/**
 * Tracer — lightweight request-level tracing with optional span-level detail.
 *
 * In 'minimal' mode: only TraceRecords are persisted (one row per think() call).
 * In 'full' mode: SpanRecords are also persisted (per tool call, LLM call, etc).
 */

import { ulid } from 'ulid'
import type { TracingLevel, TraceType, TraceStatus, TraceRecord, SpanRecord, SpanType, SpanStatus } from './types.js'
import type { MetricsWriter } from './metrics-writer.js'
import type { MetricsCollector } from './metrics-collector.js'
import { logger } from '../shared/logger.js'

// ── Public API ──────────────────────────────────────────────────

export class Tracer {
  private writer: MetricsWriter
  private metrics: MetricsCollector
  private level: TracingLevel

  constructor(writer: MetricsWriter, metrics: MetricsCollector, level: TracingLevel) {
    this.writer = writer
    this.metrics = metrics
    this.level = level
  }

  get tracingLevel(): TracingLevel {
    return this.level
  }

  setLevel(level: TracingLevel): void {
    this.level = level
  }

  /**
   * Start a new trace. Returns a TraceContext handle for recording spans and ending.
   * Returns null if tracing is disabled.
   */
  startTrace(type: TraceType, opts?: { userId?: string; spaceId?: string; correlationId?: string }): TraceContext | null {
    if (this.level === 'off') return null
    return new TraceContext(this.writer, this.metrics, this.level, type, opts)
  }
}

// ── TraceContext ────────────────────────────────────────────────

export class TraceContext {
  readonly id: string
  private writer: MetricsWriter
  private metrics: MetricsCollector
  private level: TracingLevel
  private traceType: TraceType
  private userId?: string
  private spaceId?: string
  private correlationId?: string
  private startedAt: number
  private spans: SpanRecord[] = []
  private ended = false

  constructor(
    writer: MetricsWriter,
    metrics: MetricsCollector,
    level: TracingLevel,
    traceType: TraceType,
    opts?: { userId?: string; spaceId?: string; correlationId?: string },
  ) {
    this.id = ulid()
    this.writer = writer
    this.metrics = metrics
    this.level = level
    this.traceType = traceType
    this.userId = opts?.userId
    this.spaceId = opts?.spaceId
    this.correlationId = opts?.correlationId
    this.startedAt = Date.now()
  }

  /**
   * Start a span within this trace. Only records if level is 'full'.
   */
  startSpan(spanType: SpanType, name: string): SpanHandle {
    return new SpanHandle(this, spanType, name, this.level === 'full')
  }

  /** @internal Called by SpanHandle when ended */
  _addSpan(span: SpanRecord): void {
    if (this.level === 'full') {
      this.spans.push(span)
    }
  }

  /**
   * End the trace and persist.
   */
  end(status: TraceStatus, metadata?: Record<string, unknown>): void {
    if (this.ended) return
    this.ended = true

    const durationMs = Date.now() - this.startedAt
    const trace: TraceRecord = {
      id: this.id,
      traceType: this.traceType,
      correlationId: this.correlationId,
      userId: this.userId,
      spaceId: this.spaceId,
      startedAt: this.startedAt,
      durationMs,
      status,
      metadata: metadata ?? {},
    }

    // Persist asynchronously (non-blocking)
    try {
      this.writer.writeTrace(trace)
      if (this.spans.length > 0) {
        this.writer.writeSpans(this.spans)
      }
    } catch (err) {
      logger.debug('Tracer: failed to persist trace', err)
    }

    // Record summary metrics
    this.metrics.record(`trace.${this.traceType}.duration_ms`, durationMs)
    if (status === 'error' || status === 'timeout') {
      this.metrics.increment(`trace.${this.traceType}.errors`)
    }
  }
}

// ── SpanHandle ──────────────────────────────────────────────────

export class SpanHandle {
  private ctx: TraceContext
  private spanType: SpanType
  private name: string
  private active: boolean
  private startedAt: number
  private ended = false

  constructor(ctx: TraceContext, spanType: SpanType, name: string, active: boolean) {
    this.ctx = ctx
    this.spanType = spanType
    this.name = name
    this.active = active
    this.startedAt = Date.now()
  }

  /**
   * End the span with result info.
   */
  end(status: SpanStatus, meta?: { inputTokens?: number; outputTokens?: number; [key: string]: unknown }): void {
    if (this.ended) return
    this.ended = true

    if (!this.active) return // 'minimal' mode, skip span persistence

    const durationMs = Date.now() - this.startedAt
    const { inputTokens, outputTokens, ...rest } = meta ?? {}

    const span: SpanRecord = {
      id: ulid(),
      traceId: this.ctx.id,
      spanType: this.spanType,
      name: this.name,
      startedAt: this.startedAt,
      durationMs,
      status,
      inputTokens,
      outputTokens,
      metadata: rest,
    }

    this.ctx._addSpan(span)
  }
}
