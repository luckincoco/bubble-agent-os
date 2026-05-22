import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock functions ────────────────────────

const mockGetLatestEvals = vi.hoisted(() => vi.fn())
const mockGetEvalHistory = vi.hoisted(() => vi.fn())
const mockGetRecentTraces = vi.hoisted(() => vi.fn())
const mockGetTraceSpans = vi.hoisted(() => vi.fn())

// ── Module-level mocks ───────────────────────────────────────

vi.mock('../src/observability/queries.js', () => ({
  getLatestEvals: mockGetLatestEvals,
  getEvalHistory: mockGetEvalHistory,
  getRecentTraces: mockGetRecentTraces,
  getTraceSpans: mockGetTraceSpans,
}))

// ── Imports ──────────────────────────────────────────────────

import { runEvalCommand } from '../src/observability/cli/eval-command.js'

// ════════════════════════════════════════════════════════════
//  Score fixtures
// ════════════════════════════════════════════════════════════

function makeObsScore(overrides: Record<string, unknown> = {}) {
  return {
    totalDiscovered: 10, reachedStable: 5, reachedStale: 2,
    avgLifespanDays: 7, survivalRate: 0.6, currentActive: 8,
    ...overrides,
  }
}

function makeHealthScore(overrides: Record<string, unknown> = {}) {
  return {
    avgTokenUtilization: 0.75, compactionReductionRatio: 2.5,
    llmLatencyP50: 50, llmLatencyP95: 95,
    dailyTokenConsumption: 5000, taskSuccessRate: 0.8,
    ...overrides,
  }
}

function makeCausalScore(overrides: Record<string, unknown> = {}) {
  return {
    totalVerdicts: 10, contradictionPrecision: 0.8,
    confirmationPrecision: 0.6, avgConfidence: 0.7,
    ...overrides,
  }
}

// ════════════════════════════════════════════════════════════
//  runEvalCommand
// ════════════════════════════════════════════════════════════

describe('runEvalCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  // ── showSummary ──────────────────────────────────────────

  it('shows "暂无评估数据" when no eval results exist', () => {
    mockGetLatestEvals.mockReturnValue(new Map())

    runEvalCommand([])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('暂无评估数据'),
    )
  })

  it('prints all 3 eval sections when all types have data', () => {
    const now = Date.now()
    mockGetLatestEvals.mockReturnValue(new Map([
      ['observation_survival', { scores: makeObsScore(), runAt: now - 86400000, sampleSize: 10 }],
      ['system_health', { scores: makeHealthScore(), runAt: now, sampleSize: 50 }],
      ['causal_accuracy', { scores: makeCausalScore(), runAt: now, sampleSize: 10 }],
    ]))

    runEvalCommand([])

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Observation Eval'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('System Health'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Causal Accuracy'))
  })

  it('prints only the eval section that has data', () => {
    mockGetLatestEvals.mockReturnValue(new Map([
      ['system_health', { scores: makeHealthScore(), runAt: Date.now(), sampleSize: 50 }],
    ]))

    runEvalCommand([])

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('System Health'))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Observation Eval'))
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Causal Accuracy'))
  })

  // ── showTypedEval ────────────────────────────────────────

  it('shows error for unknown --type', () => {
    runEvalCommand(['--type', 'foo'])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('未知类型'),
    )
  })

  it('shows typed eval details for --type observation', () => {
    mockGetLatestEvals.mockReturnValue(new Map([
      ['observation_survival', { scores: makeObsScore({ totalDiscovered: 15 }), runAt: Date.now(), sampleSize: 15 }],
    ]))

    runEvalCommand(['--type', 'observation'])

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('observation_survival'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('样本数: 15'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('totalDiscovered: 15'))
  })

  it('shows "暂无数据" when --type has no data', () => {
    mockGetLatestEvals.mockReturnValue(new Map())

    runEvalCommand(['--type', 'health'])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('暂无数据'),
    )
  })

  // ── showHistory ──────────────────────────────────────────

  it('shows history trend for --history with --type', () => {
    const today = Date.now()
    const yesterday = today - 86400000
    mockGetEvalHistory.mockReturnValue([
      { runAt: yesterday, scores: { llmLatencyP50: 45 }, sampleSize: 100 },
      { runAt: today, scores: { llmLatencyP50: 50 }, sampleSize: 100 },
    ])

    runEvalCommand(['--history', '7', '--type', 'health'])

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('llmLatencyP50'))
    expect(mockGetEvalHistory).toHaveBeenCalledWith('system_health', 7)
  })

  it('shows "无数据" when --history finds no entries', () => {
    mockGetEvalHistory.mockReturnValue([])

    runEvalCommand(['--history', '3', '--type', 'causal'])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('最近 3 天无'),
    )
  })

  // ── showTrace ────────────────────────────────────────────

  it('shows trace details when trace is found by id', () => {
    const now = Date.now()
    mockGetRecentTraces.mockReturnValue([
      { id: 'abc123', trace_type: 'think', started_at: now - 1000, duration_ms: 500, status: 'ok', metadata: '{}' },
    ])
    mockGetTraceSpans.mockReturnValue([
      { span_type: 'llm_call', name: 'gpt-4', duration_ms: 400, status: 'ok', input_tokens: 100, output_tokens: 200 },
    ])

    runEvalCommand(['--trace', 'abc123'])

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Trace abc123'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('think'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('500ms'))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('llm_call/gpt-4'))
    expect(mockGetTraceSpans).toHaveBeenCalledWith('abc123')
  })

  it('shows "未找到" when trace is not found', () => {
    mockGetRecentTraces.mockReturnValue([])

    runEvalCommand(['--trace', 'xyz999'])

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Trace xyz999 未找到'),
    )
  })
})
