import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

const mockUlid = vi.hoisted(() => vi.fn(() => 'eval-ulid-health'))

// Individual stmt mocks for each query
const mockTraceStmt = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn() }))
const mockMetricStmt = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn() }))
const mockTaskStmt = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn() }))
const mockWmStmt = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn() }))
const mockCompactionStmt = vi.hoisted(() => ({ all: vi.fn(), get: vi.fn() }))

const mockDb = vi.hoisted(() => ({
  prepare: vi.fn(),
}))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('ulid', () => ({ ulid: mockUlid }))

// ── Imports ────────────────────────────────────────────────

import { runSystemHealthEval } from '../src/observability/eval/system-health.js'

// ════════════════════════════════════════════════════════════
//  runSystemHealthEval
// ════════════════════════════════════════════════════════════

describe('runSystemHealthEval', () => {
  const mockWriter = { writeEvalResult: vi.fn() }

  function setupDbRouting() {
    mockDb.prepare.mockImplementation((sql: string) => {
      if (sql.includes('FROM traces')) return mockTraceStmt
      if (sql.includes('FROM metrics')) return mockMetricStmt
      if (sql.includes('scheduler.task_completed')) return mockTaskStmt
      if (sql.includes('FROM working_memory')) return mockWmStmt
      if (sql.includes('compaction.completed')) return mockCompactionStmt
      return { all: vi.fn(() => []), get: vi.fn(() => undefined) }
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockUlid.mockReturnValue('eval-ulid-health')
    mockWriter.writeEvalResult.mockReset()
    setupDbRouting()

    // Default: empty results for all queries
    mockTraceStmt.all.mockReset()
    mockTraceStmt.all.mockReturnValue([])
    mockTraceStmt.get.mockReset()
    mockTraceStmt.get.mockReturnValue(undefined)

    mockMetricStmt.all.mockReset()
    mockMetricStmt.all.mockReturnValue([])
    mockMetricStmt.get.mockReset()
    mockMetricStmt.get.mockReturnValue({ total: 0 })

    mockTaskStmt.all.mockReset()
    mockTaskStmt.all.mockReturnValue([])
    mockTaskStmt.get.mockReset()
    mockTaskStmt.get.mockReturnValue(undefined)

    mockWmStmt.all.mockReset()
    mockWmStmt.all.mockReturnValue([])
    mockWmStmt.get.mockReset()
    mockWmStmt.get.mockReturnValue({ avg_cost: null, cnt: 0 })

    mockCompactionStmt.all.mockReset()
    mockCompactionStmt.all.mockReturnValue([])
    mockCompactionStmt.get.mockReset()
    mockCompactionStmt.get.mockReturnValue(undefined)
  })

  it('returns p50=p95=0 when no traces exist', () => {
    // All defaults: empty traces, zero metrics, etc.

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.llmLatencyP50).toBe(0)
    expect(s.llmLatencyP95).toBe(0)
  })

  it('computes p50 and p95 latency from ordered traces', () => {
    // 100 latencies: 0..99
    const traces = Array.from({ length: 100 }, (_, i) => ({ duration_ms: i }))
    mockTraceStmt.all.mockReturnValue(traces)

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // p50Idx = floor(100 * 0.5) = 50 → latencies[50] = 50
    // p95Idx = floor(100 * 0.95) = 95 → latencies[95] = 95
    expect(s.llmLatencyP50).toBe(50)
    expect(s.llmLatencyP95).toBe(95)
  })

  it('estimates daily token consumption', () => {
    mockMetricStmt.get.mockReturnValue({ total: 1000 })
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 100 }]) // need at least 1 trace for sample size

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // 1000 * 5 = 5000
    expect(s.dailyTokenConsumption).toBe(5000)
  })

  it('computes task success rate with mixed results', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    mockTaskStmt.all.mockReturnValue([
      { payload: JSON.stringify({ result: 'completed' }) },
      { payload: JSON.stringify({ result: 'error' }) },
      { payload: JSON.stringify({ result: 'failed' }) },
      { payload: JSON.stringify({ result: 'completed' }) },
    ])

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // 4 tasks, 2 success (completed), 2 fail (error + failed) → 0.5
    expect(s.taskSuccessRate).toBe(0.5)
  })

  it('computes task success rate = 0 when all tasks fail', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    mockTaskStmt.all.mockReturnValue([
      { payload: JSON.stringify({ result: 'error' }) },
      { payload: JSON.stringify({ result: 'failed' }) },
    ])

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.taskSuccessRate).toBe(0)
  })

  it('returns task success rate = 1 when no task events', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    // taskStmt.default is empty array

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.taskSuccessRate).toBe(1)
  })

  it('computes working memory utilization', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    mockWmStmt.get.mockReturnValue({ avg_cost: 3000, cnt: 2 })

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // min(1, 3000 * 2 / 8000) = min(1, 0.75) = 0.75
    expect(s.avgTokenUtilization).toBe(0.75)
  })

  it('caps working memory utilization at 1.0', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    mockWmStmt.get.mockReturnValue({ avg_cost: 5000, cnt: 3 })

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // min(1, 5000 * 3 / 8000) = min(1, 1.875) = 1
    expect(s.avgTokenUtilization).toBe(1)
  })

  it('computes compaction reduction ratio', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    mockCompactionStmt.all.mockReturnValue([
      { payload: JSON.stringify({ sourceIds: ['a', 'b', 'c'] }) },
      { payload: JSON.stringify({ sourceIds: ['d', 'e'] }) },
    ])

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // totalSources = 3 + 2 = 5, events = 2 → 5/2 = 2.5
    expect(s.compactionReductionRatio).toBe(2.5)
  })

  it('returns compaction ratio = 0 when no compaction events', () => {
    mockTraceStmt.all.mockReturnValue([{ duration_ms: 0 }])
    // compactionStmt.default is empty array

    const result = runSystemHealthEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.compactionReductionRatio).toBe(0)
  })
})
