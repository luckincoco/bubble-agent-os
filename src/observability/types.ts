/**
 * Observability Types — interfaces for tracing, metrics, and evaluation.
 */

// ── Configuration ───────────────────────────────────────────────

export type TracingLevel = 'off' | 'minimal' | 'full'

export interface ObservabilityConfig {
  enabled: boolean
  tracingLevel: TracingLevel   // 'minimal': trace only, 'full': trace + spans
  metricsFlushIntervalMs: number  // default 30000
  metricsBufferSize: number       // default 100
}

export const DEFAULT_OBS_CONFIG: ObservabilityConfig = {
  enabled: true,
  tracingLevel: 'minimal',
  metricsFlushIntervalMs: 30_000,
  metricsBufferSize: 100,
}

// ── Trace Types ─────────────────────────────────────────────────

export type TraceType = 'think' | 'scheduler_task' | 'causal_eval'
export type TraceStatus = 'ok' | 'error' | 'timeout'

export interface TraceRecord {
  id: string
  traceType: TraceType
  correlationId?: string
  userId?: string
  spaceId?: string
  startedAt: number
  durationMs: number
  status: TraceStatus
  errorMessage?: string
  metadata: Record<string, unknown>
}

// ── Span Types ──────────────────────────────────────────────────

export type SpanType = 'llm_call' | 'tool_call' | 'memory_retrieval' | 'critique' | 'compaction'
export type SpanStatus = 'ok' | 'error'

export interface SpanRecord {
  id: string
  traceId: string
  spanType: SpanType
  name: string
  startedAt: number
  durationMs: number
  status: SpanStatus
  inputTokens?: number
  outputTokens?: number
  metadata: Record<string, unknown>
}

// ── Metrics ─────────────────────────────────────────────────────

export interface MetricPoint {
  name: string
  value: number
  tags?: Record<string, string>
  recordedAt: number
}

// ── Eval Results ────────────────────────────────────────────────

export interface EvalResult {
  id: string
  evalType: EvalType
  spaceId?: string
  runAt: number
  periodStart: number
  periodEnd: number
  scores: ObservationSurvivalScore | CausalAccuracyScore | SystemHealthScore
  sampleSize: number
  metadata: Record<string, unknown>
}

export type EvalType = 'observation_survival' | 'causal_accuracy' | 'system_health'

export interface ObservationSurvivalScore {
  totalDiscovered: number
  reachedStable: number
  reachedStale: number
  avgLifespanDays: number
  survivalRate: number
  currentActive: number
}

export interface CausalAccuracyScore {
  totalVerdicts: number
  contradictionPrecision: number
  confirmationPrecision: number
  avgConfidence: number
}

export interface SystemHealthScore {
  avgTokenUtilization: number
  compactionReductionRatio: number
  llmLatencyP50: number
  llmLatencyP95: number
  dailyTokenConsumption: number
  taskSuccessRate: number
}
