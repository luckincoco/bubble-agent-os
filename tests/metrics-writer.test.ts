import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MetricsWriter } from '../src/observability/metrics-writer.js'
import type { TraceRecord, SpanRecord, MetricPoint, EvalResult } from '../src/observability/types.js'

const { dbMock } = vi.hoisted(() => {
  const run = vi.fn()
  const prepare = vi.fn(() => ({ run }))
  const transaction = vi.fn((fn: () => void) => fn())
  return { dbMock: { prepare, transaction, run } }
})

vi.mock('../src/storage/database.js', () => ({
  getDatabase: () => dbMock,
}))

function resetDbMock() {
  dbMock.prepare.mockReset()
  dbMock.transaction.mockReset()
  dbMock.run.mockReset()
  dbMock.prepare.mockReturnValue({ run: dbMock.run })
  dbMock.transaction.mockImplementation((fn: () => void) => fn())
}

const writer = new MetricsWriter()

const sampleTrace: TraceRecord = {
  id: 'trace-1', traceType: 'llm_call', correlationId: 'corr-1',
  userId: 'user-1', spaceId: 'space-1',
  startedAt: 1000, durationMs: 500, status: 'success',
  errorMessage: null, metadata: { model: 'gpt-4' },
}

const sampleSpan: SpanRecord = {
  id: 'span-1', traceId: 'trace-1', spanType: 'chat',
  name: 'openai-chat', startedAt: 1000, durationMs: 200,
  status: 'success', inputTokens: 50, outputTokens: 100,
  metadata: { temperature: 0.7 },
}

const sampleMetric: MetricPoint = {
  name: 'llm_latency_ms', value: 450,
  tags: { model: 'gpt-4' }, recordedAt: 1000,
}

const sampleEval: EvalResult = {
  id: 'eval-1', evalType: 'weekly',
  spaceId: 'space-1', runAt: 1000,
  periodStart: 0, periodEnd: 1000,
  scores: { accuracy: 0.95 }, sampleSize: 100,
  metadata: { version: 1 },
}

describe('MetricsWriter', () => {
  beforeEach(() => {
    resetDbMock()
  })

  // ── init ───────────────────────────────────────────────

  it('init calls getDatabase to verify tables exist', () => {
    writer.init()
    // getDatabase() was called (no error thrown)
    expect(dbMock.prepare).not.toHaveBeenCalled()
  })

  // ── writeTrace ─────────────────────────────────────────

  it('writeTrace inserts trace with correct SQL and params', () => {
    writer.writeTrace(sampleTrace)

    expect(dbMock.prepare).toHaveBeenCalledTimes(1)
    const sql = dbMock.prepare.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO traces')
    expect(sql).toContain('id, trace_type, correlation_id')

    expect(dbMock.run).toHaveBeenCalledWith(
      'trace-1', 'llm_call', 'corr-1', 'user-1', 'space-1',
      1000, 500, 'success', null,
      JSON.stringify({ model: 'gpt-4' }),
    )
  })

  it('writeTrace handles null correlationId and userId', () => {
    writer.writeTrace({ ...sampleTrace, correlationId: null, userId: null, errorMessage: 'err' })

    expect(dbMock.run).toHaveBeenCalled()
    const params = dbMock.run.mock.calls[0]
    expect(params[2]).toBeNull()  // correlationId
    expect(params[3]).toBeNull()  // userId
    expect(params[8]).toBe('err') // errorMessage
  })

  it('writeTrace catches DB error and does not throw', () => {
    dbMock.prepare.mockImplementation(() => { throw new Error('DB locked') })

    expect(() => writer.writeTrace(sampleTrace)).not.toThrow()
  })

  // ── writeSpans ─────────────────────────────────────────

  it('writeSpans does nothing when array is empty', () => {
    writer.writeSpans([])

    expect(dbMock.prepare).not.toHaveBeenCalled()
  })

  it('writeSpans inserts each span in a transaction', () => {
    writer.writeSpans([sampleSpan, { ...sampleSpan, id: 'span-2' }])

    expect(dbMock.transaction).toHaveBeenCalled()
    expect(dbMock.prepare).toHaveBeenCalledTimes(1)
    const sql = dbMock.prepare.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO trace_spans')

    expect(dbMock.run).toHaveBeenCalledTimes(2)
    const firstCall = dbMock.run.mock.calls[0]
    expect(firstCall[0]).toBe('span-1')
    expect(firstCall[1]).toBe('trace-1')
    expect(firstCall[4]).toBe(1000)
    expect(firstCall[6]).toBe('success')
  })

  it('writeSpans handles null token counts', () => {
    writer.writeSpans([{ ...sampleSpan, inputTokens: null, outputTokens: null }])

    const params = dbMock.run.mock.calls[0]
    expect(params[7]).toBeNull()  // inputTokens
    expect(params[8]).toBeNull()  // outputTokens
  })

  // ── writeMetrics ───────────────────────────────────────

  it('writeMetrics does nothing when array is empty', () => {
    writer.writeMetrics([])

    expect(dbMock.prepare).not.toHaveBeenCalled()
  })

  it('writeMetrics inserts each point in a transaction', () => {
    writer.writeMetrics([sampleMetric, { ...sampleMetric, name: 'llm_tokens', value: 150 }])

    expect(dbMock.transaction).toHaveBeenCalled()
    expect(dbMock.prepare).toHaveBeenCalledTimes(1)
    const sql = dbMock.prepare.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO metrics')
    expect(sql).toContain('name, value, tags')

    expect(dbMock.run).toHaveBeenCalledTimes(2)
    expect(dbMock.run.mock.calls[0][0]).toBe('llm_latency_ms')
    expect(dbMock.run.mock.calls[0][1]).toBe(450)
    expect(dbMock.run.mock.calls[1][0]).toBe('llm_tokens')
    expect(dbMock.run.mock.calls[1][1]).toBe(150)
  })

  it('writeMetrics serializes tags as JSON string', () => {
    writer.writeMetrics([sampleMetric])

    const params = dbMock.run.mock.calls[0]
    expect(params[2]).toBe(JSON.stringify({ model: 'gpt-4' }))
  })

  it('writeMetrics uses empty object for undefined tags', () => {
    writer.writeMetrics([{ ...sampleMetric, tags: undefined }])

    const params = dbMock.run.mock.calls[0]
    expect(params[2]).toBe('{}')
  })

  // ── writeEvalResult ────────────────────────────────────

  it('writeEvalResult inserts eval result with correct params', () => {
    writer.writeEvalResult(sampleEval)

    expect(dbMock.prepare).toHaveBeenCalledTimes(1)
    const sql = dbMock.prepare.mock.calls[0][0]
    expect(sql).toContain('INSERT INTO eval_results')

    expect(dbMock.run).toHaveBeenCalledWith(
      'eval-1', 'weekly', 'space-1', 1000, 0, 1000,
      JSON.stringify({ accuracy: 0.95 }), 100,
      JSON.stringify({ version: 1 }),
    )
  })

  it('writeEvalResult handles null spaceId', () => {
    writer.writeEvalResult({ ...sampleEval, spaceId: null })

    expect(dbMock.run.mock.calls[0][2]).toBeNull()
  })
})
