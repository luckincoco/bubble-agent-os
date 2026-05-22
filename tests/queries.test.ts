import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

import {
  getLatestEvals,
  getEvalHistory,
  getRecentTraces,
  getTraceSpans,
  getMetricValues,
  getMetricSummary,
} from '../src/observability/queries.js'

let tmpDir: string

const NOW = Date.now()
const HOUR = 60 * 60 * 1000

// ── Helpers ──────────────────────────────────────────────────────

function insertEvalResult(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO eval_results (id, eval_type, space_id, run_at, period_start, period_end, scores, sample_size, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.eval_type || 'observation_survival',
    overrides.space_id || null,
    overrides.run_at || NOW,
    overrides.period_start || NOW - HOUR,
    overrides.period_end || NOW,
    JSON.stringify(overrides.scores || { survivalRate: 0.85, totalCount: 100 }),
    overrides.sample_size || 100,
    '{}',
  )
}

function insertTrace(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO traces (id, trace_type, started_at, duration_ms, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    id,
    overrides.trace_type || 'llm_call',
    overrides.started_at || NOW,
    overrides.duration_ms || 150,
    overrides.status || 'ok',
    JSON.stringify(overrides.metadata || {}),
  )
}

function insertSpan(traceId: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO trace_spans (trace_id, span_type, name, started_at, duration_ms, status, input_tokens, output_tokens, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    traceId,
    overrides.span_type || 'tool_call',
    overrides.name || 'search',
    overrides.started_at || NOW,
    overrides.duration_ms || 50,
    overrides.status || 'ok',
    overrides.input_tokens ?? null,
    overrides.output_tokens ?? null,
    '{}',
  )
}

function insertMetric(overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO metrics (name, value, tags, recorded_at)
    VALUES (?, ?, ?, ?)
  `).run(
    overrides.name || 'test_metric',
    overrides.value ?? 42,
    JSON.stringify(overrides.tags || {}),
    overrides.recorded_at || NOW,
  )
}

// ── Setup / Teardown ──────────────────────────────────────────

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'queries-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.exec('DELETE FROM eval_results')
  db.exec('DELETE FROM trace_spans')
  db.exec('DELETE FROM traces')
  db.exec('DELETE FROM metrics')
})

// ── getLatestEvals ───────────────────────────────────────────────

describe('getLatestEvals', () => {
  it('returns empty map when no eval results exist', () => {
    const result = getLatestEvals()
    expect(result.size).toBe(0)
  })

  it('returns latest eval for each type', () => {
    insertEvalResult('e1', { eval_type: 'observation_survival', run_at: NOW, scores: { survivalRate: 0.85 } })
    insertEvalResult('e2', { eval_type: 'causal_accuracy', run_at: NOW, scores: { accuracy: 0.92 } })
    insertEvalResult('e3', { eval_type: 'system_health', run_at: NOW, scores: { health: 0.95 } })

    const result = getLatestEvals()

    expect(result.size).toBe(3)
    expect(result.get('observation_survival')!.scores).toEqual({ survivalRate: 0.85 })
    expect(result.get('causal_accuracy')!.scores).toEqual({ accuracy: 0.92 })
    expect(result.get('system_health')!.scores).toEqual({ health: 0.95 })
  })

  it('returns only the most recent for each type', () => {
    insertEvalResult('e-old', { eval_type: 'observation_survival', run_at: NOW - 10000, scores: { survivalRate: 0.5 } })
    insertEvalResult('e-new', { eval_type: 'observation_survival', run_at: NOW, scores: { survivalRate: 0.9 } })

    const result = getLatestEvals()

    expect(result.size).toBe(1)
    expect(result.get('observation_survival')!.scores).toEqual({ survivalRate: 0.9 })
  })

  it('includes runAt and sampleSize', () => {
    insertEvalResult('e1', { eval_type: 'observation_survival', run_at: NOW, sample_size: 200 })

    const result = getLatestEvals()

    expect(result.get('observation_survival')!.runAt).toBe(NOW)
    expect(result.get('observation_survival')!.sampleSize).toBe(200)
  })
})

// ── getEvalHistory ───────────────────────────────────────────────

describe('getEvalHistory', () => {
  it('returns empty array when no history exists', () => {
    const result = getEvalHistory('observation_survival')
    expect(result).toHaveLength(0)
  })

  it('returns history sorted ASC for a given type', () => {
    insertEvalResult('e1', { eval_type: 'observation_survival', run_at: NOW + 2000 })
    insertEvalResult('e2', { eval_type: 'observation_survival', run_at: NOW })
    insertEvalResult('e3', { eval_type: 'observation_survival', run_at: NOW + 1000 })
    // Different type — should be excluded
    insertEvalResult('e4', { eval_type: 'causal_accuracy', run_at: NOW })

    const result = getEvalHistory('observation_survival')

    expect(result).toHaveLength(3)
    // Should be sorted ASC by runAt
    expect(result[0].runAt).toBe(NOW)
    expect(result[1].runAt).toBe(NOW + 1000)
    expect(result[2].runAt).toBe(NOW + 2000)
  })

  it('respects days parameter to filter old results', () => {
    insertEvalResult('e1', { eval_type: 'observation_survival', run_at: NOW })
    // 8 days ago — outside default 7 day window
    insertEvalResult('e2', { eval_type: 'observation_survival', run_at: NOW - 8 * 24 * HOUR })

    const result = getEvalHistory('observation_survival')

    expect(result).toHaveLength(1)
  })
})

// ── getRecentTraces ──────────────────────────────────────────────

describe('getRecentTraces', () => {
  it('returns all traces sorted DESC by default', () => {
    insertTrace('t1', { started_at: NOW })
    insertTrace('t2', { started_at: NOW + 1000 })
    insertTrace('t3', { started_at: NOW - 1000 })

    const result = getRecentTraces()

    expect(result).toHaveLength(3)
    // Most recent first
    expect(result[0].id).toBe('t2')
    expect(result[1].id).toBe('t1')
    expect(result[2].id).toBe('t3')
  })

  it('filters by trace_type', () => {
    insertTrace('t1', { trace_type: 'llm_call', started_at: NOW })
    insertTrace('t2', { trace_type: 'tool_exec', started_at: NOW })

    const result = getRecentTraces('llm_call')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t1')
  })

  it('respects limit', () => {
    insertTrace('t1', { started_at: NOW + 2000 })
    insertTrace('t2', { started_at: NOW + 1000 })
    insertTrace('t3', { started_at: NOW })

    const result = getRecentTraces(undefined, 2)

    expect(result).toHaveLength(2)
  })

  it('returns empty array when no traces exist', () => {
    const result = getRecentTraces()
    expect(result).toHaveLength(0)
  })

  it('returns correct shape with metadata', () => {
    insertTrace('t1', { trace_type: 'llm_call', started_at: NOW, duration_ms: 200, status: 'ok', metadata: { model: 'gpt-4' } })

    const result = getRecentTraces()

    expect(result[0].id).toBe('t1')
    expect(result[0].trace_type).toBe('llm_call')
    expect(result[0].started_at).toBe(NOW)
    expect(result[0].duration_ms).toBe(200)
    expect(result[0].status).toBe('ok')
    expect(result[0].metadata).toBe(JSON.stringify({ model: 'gpt-4' }))
  })
})

// ── getTraceSpans ────────────────────────────────────────────────

describe('getTraceSpans', () => {
  it('returns spans for a trace ordered ASC', () => {
    insertTrace('trace-1')
    insertSpan('trace-1', { name: 'search', started_at: NOW })
    insertSpan('trace-1', { name: 'calc', started_at: NOW + 100 })

    const result = getTraceSpans('trace-1')

    expect(result).toHaveLength(2)
    expect(result[0].name).toBe('search')
    expect(result[1].name).toBe('calc')
  })

  it('returns empty array when trace has no spans', () => {
    insertTrace('trace-1')

    const result = getTraceSpans('trace-1')

    expect(result).toHaveLength(0)
  })

  it('returns empty array for non-existent trace', () => {
    const result = getTraceSpans('nonexistent')
    expect(result).toHaveLength(0)
  })

  it('returns span details including token counts', () => {
    insertTrace('trace-1')
    insertSpan('trace-1', { name: 'llm_call', span_type: 'llm', duration_ms: 500, status: 'ok', input_tokens: 100, output_tokens: 50 })

    const result = getTraceSpans('trace-1')

    expect(result[0].span_type).toBe('llm')
    expect(result[0].duration_ms).toBe(500)
    expect(result[0].status).toBe('ok')
    expect(result[0].input_tokens).toBe(100)
    expect(result[0].output_tokens).toBe(50)
  })
})

// ── getMetricValues ──────────────────────────────────────────────

describe('getMetricValues', () => {
  it('returns metric values within time range', () => {
    insertMetric({ name: 'latency', value: 100, recorded_at: NOW })
    insertMetric({ name: 'latency', value: 200, recorded_at: NOW + 1000 })

    const result = getMetricValues('latency')

    expect(result).toHaveLength(2)
    expect(result[0].value).toBe(100)
    expect(result[1].value).toBe(200)
  })

  it('filters by name', () => {
    insertMetric({ name: 'latency', value: 100 })
    insertMetric({ name: 'throughput', value: 50 })

    const result = getMetricValues('latency')

    expect(result).toHaveLength(1)
  })

  it('returns empty when no data within time range', () => {
    insertMetric({ name: 'latency', value: 100, recorded_at: NOW - 48 * HOUR })

    // Default hoursBack is 24 — the metric is 48h old
    const result = getMetricValues('latency')

    expect(result).toHaveLength(0)
  })

  it('returns metric with tags', () => {
    insertMetric({ name: 'latency', value: 100, tags: { endpoint: '/api' }, recorded_at: NOW })

    const result = getMetricValues('latency')

    expect(result[0].tags).toBe(JSON.stringify({ endpoint: '/api' }))
  })
})

// ── getMetricSummary ─────────────────────────────────────────────

describe('getMetricSummary', () => {
  it('returns null when no data exists', () => {
    const result = getMetricSummary('nonexistent')
    expect(result).toBeNull()
  })

  it('returns correct summary stats', () => {
    insertMetric({ name: 'latency', value: 100, recorded_at: NOW })
    insertMetric({ name: 'latency', value: 200, recorded_at: NOW + 1000 })
    insertMetric({ name: 'latency', value: 300, recorded_at: NOW + 2000 })

    const result = getMetricSummary('latency')

    expect(result).not.toBeNull()
    expect(result!.count).toBe(3)
    expect(result!.sum).toBe(600)
    expect(result!.avg).toBe(200)
    expect(result!.min).toBe(100)
    expect(result!.max).toBe(300)
  })

  it('respects hoursBack parameter', () => {
    insertMetric({ name: 'latency', value: 100, recorded_at: NOW })
    // 48 hours ago — outside 24h default
    insertMetric({ name: 'latency', value: 999, recorded_at: NOW - 48 * HOUR })

    const result = getMetricSummary('latency')

    expect(result).not.toBeNull()
    expect(result!.count).toBe(1)
    expect(result!.sum).toBe(100)
  })

  it('returns null when all data is outside time range', () => {
    insertMetric({ name: 'latency', value: 100, recorded_at: NOW - 48 * HOUR })

    const result = getMetricSummary('latency')

    expect(result).toBeNull()
  })
})
