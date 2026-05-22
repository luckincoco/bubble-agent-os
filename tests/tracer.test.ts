import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MetricsWriter } from '../src/observability/metrics-writer.js'
import type { MetricsCollector } from '../src/observability/metrics-collector.js'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { Tracer, TraceContext, SpanHandle } from '../src/observability/tracer.js'

// ── Helpers ──────────────────────────────────────────────────────

function makeWriter(): MetricsWriter {
  return { writeTrace: vi.fn(), writeSpans: vi.fn(), writeMetrics: vi.fn(), writeEvalResult: vi.fn() } as unknown as MetricsWriter
}

function makeMetrics(): MetricsCollector {
  return { record: vi.fn(), increment: vi.fn(), emit: vi.fn() } as unknown as MetricsCollector
}

// ── Tests ───────────────────────────────────────────────────────

describe('Tracer', () => {
  it('creates and returns tracing level', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const tracer = new Tracer(writer, metrics, 'full')

    expect(tracer.tracingLevel).toBe('full')
  })

  it('setLevel updates tracing level', () => {
    const tracer = new Tracer(makeWriter(), makeMetrics(), 'full')
    tracer.setLevel('minimal')

    expect(tracer.tracingLevel).toBe('minimal')
  })

  it('startTrace returns null when level is off', () => {
    const tracer = new Tracer(makeWriter(), makeMetrics(), 'off')

    expect(tracer.startTrace('llm_call')).toBeNull()
  })

  it('startTrace creates TraceContext', () => {
    const tracer = new Tracer(makeWriter(), makeMetrics(), 'full')
    const ctx = tracer.startTrace('llm_call', { userId: 'u1', spaceId: 's1' })

    expect(ctx).toBeInstanceOf(TraceContext)
    expect(ctx!.id).toBeTruthy()
  })
})

describe('TraceContext', () => {
  it('end persists trace and records metrics', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'llm_call', { userId: 'u1' })

    ctx.end('ok', { source: 'test' })

    expect(writer.writeTrace).toHaveBeenCalledTimes(1)
    const trace = (writer.writeTrace as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(trace.traceType).toBe('llm_call')
    expect(trace.status).toBe('ok')
    expect(trace.metadata).toEqual({ source: 'test' })
    expect(trace.userId).toBe('u1')
    expect(metrics.record).toHaveBeenCalledWith('trace.llm_call.duration_ms', expect.any(Number))
  })

  it('end records error metrics for error status', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'tool_execution')

    ctx.end('error')

    expect(metrics.increment).toHaveBeenCalledWith('trace.tool_execution.errors')
  })

  it('end is idempotent (double end no-ops)', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'llm_call')

    ctx.end('ok')
    ctx.end('error') // second call should be ignored

    expect(writer.writeTrace).toHaveBeenCalledTimes(1)
  })

  it('persists spans when level is full', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'llm_call')

    const span = ctx.startSpan('tool_call', 'search')
    span.end('ok', { inputTokens: 50, outputTokens: 100 })
    ctx.end('ok')

    expect(writer.writeSpans).toHaveBeenCalledTimes(1)
    const spans = (writer.writeSpans as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('search')
    expect(spans[0].inputTokens).toBe(50)
    expect(spans[0].outputTokens).toBe(100)
  })

  it('skips span persistence in minimal mode', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'minimal', 'llm_call')

    const span = ctx.startSpan('tool_call', 'search')
    span.end('ok')
    ctx.end('ok')

    expect(writer.writeSpans).not.toHaveBeenCalled()
  })
})

describe('SpanHandle', () => {
  it('end with inactive skips span recording', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'minimal', 'llm_call')
    const span = new SpanHandle(ctx, 'tool_call', 'search', false)

    span.end('ok')

    // The span won't be persisted because it's inactive
    ctx.end('ok')
    expect(writer.writeSpans).not.toHaveBeenCalled()
  })

  it('end is idempotent', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'llm_call')
    const span = new SpanHandle(ctx, 'tool_call', 'search', true)

    span.end('ok')
    span.end('error') // ignored

    ctx.end('ok')
    const spans = (writer.writeSpans as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(spans).toHaveLength(1)
  })

  it('extracts inputTokens/outputTokens from meta and passes rest as metadata', () => {
    const writer = makeWriter()
    const metrics = makeMetrics()
    const ctx = new TraceContext(writer, metrics, 'full', 'llm_call')
    const span = new SpanHandle(ctx, 'tool_call', 'search', true)

    span.end('ok', { inputTokens: 10, outputTokens: 20, model: 'gpt-4', temperature: 0.7 })

    ctx.end('ok')
    const spans = (writer.writeSpans as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(spans[0].inputTokens).toBe(10)
    expect(spans[0].outputTokens).toBe(20)
    expect(spans[0].metadata).toEqual({ model: 'gpt-4', temperature: 0.7 })
  })
})
