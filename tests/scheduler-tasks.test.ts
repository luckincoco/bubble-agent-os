import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects for vi.mock factories ────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

const mockCreateBubble = vi.hoisted(() => vi.fn(() => ({ id: 'b-' + Date.now() })))
const mockSearchBubbles = vi.hoisted(() => vi.fn(() => []))
const mockFindBubblesByType = vi.hoisted(() => vi.fn(() => []))
const mockUpdateBubble = vi.hoisted(() => vi.fn())
const mockGetBubble = vi.hoisted(() => vi.fn())
const mockAddLink = vi.hoisted(() => vi.fn())

const mockCompact = vi.hoisted(() => vi.fn())
const mockCompactSetEventBus = vi.hoisted(() => vi.fn())
const mockRun = vi.hoisted(() => vi.fn())
const mockGetQualitySignals = vi.hoisted(() => vi.fn(() => ({})))
const mockValidateSynthesis = vi.hoisted(() => vi.fn())
const mockSetDraftMode = vi.hoisted(() => vi.fn())
const mockSetOrientationGraph = vi.hoisted(() => vi.fn())
const mockEvaluate = vi.hoisted(() => vi.fn())
const mockDetectScan = vi.hoisted(() => vi.fn())
const mockCompress = vi.hoisted(() => vi.fn())

const mockStmt = vi.hoisted(() => ({
  all: vi.fn(() => []),
  get: vi.fn(() => undefined),
  run: vi.fn(() => ({ changes: 3 })),
}))
const mockDb = vi.hoisted(() => ({
  prepare: vi.fn(() => mockStmt),
}))

const mockFetchFn = vi.hoisted(() => vi.fn())
const mockMetricsWriterInit = vi.hoisted(() => vi.fn())

const mockCreateHash = vi.hoisted(() => vi.fn(() => ({
  update: vi.fn(() => ({ digest: vi.fn(() => 'mock-hash-1234') })),
})))
const mockXMLParserParse = vi.hoisted(() => vi.fn(() => ({})))

// ── Module-level mocks ───────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
  searchBubbles: mockSearchBubbles,
  findBubblesByType: mockFindBubblesByType,
  updateBubble: mockUpdateBubble,
  getBubble: mockGetBubble,
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
}))

vi.mock('../src/shared/config.js', () => ({
  getConfig: vi.fn(() => ({
    features: { draftObservations: false },
  })),
}))

// Constructor mocks: use regular functions (not arrow) so `new` works
vi.mock('../src/memory/compactor.js', () => ({
  BubbleCompactor: function () { return { compact: mockCompact, setEventBus: mockCompactSetEventBus } },
}))

vi.mock('../src/memory/reflector.js', () => ({
  Reflector: function () { return { run: mockRun, getQualitySignals: mockGetQualitySignals, validateSynthesis: mockValidateSynthesis, setDraftMode: mockSetDraftMode, setOrientationGraph: mockSetOrientationGraph } },
}))

vi.mock('../src/memory/manager.js', () => ({
  calcSurprise: vi.fn(() => ({ score: 0.1, contradicts: false, nearDuplicate: null })),
}))

vi.mock('../src/memory/surprise-detector.js', () => ({
  SurpriseDetector: function () { return { scanMessage: mockDetectScan } },
}))

vi.mock('../src/memory/causal-evaluator.js', () => ({
  CausalEvaluator: function () { return { evaluate: mockEvaluate } },
}))

vi.mock('../src/memory/session-compressor.js', () => ({
  SessionCompressor: function () { return { compress: mockCompress } },
}))

vi.mock('../src/connector/biz/structured-store.js', () => ({
  getConcentrationMetrics: vi.fn(() => ({
    supplierConcentration: { topN: 3, topNShare: 50, totalAmount: 100000, warning: false, topItems: [] },
    customerConcentration: { topN: 3, topNShare: 40, totalAmount: 80000, warning: false, topItems: [] },
    threshold: 60,
  })),
}))

vi.mock('../src/connector/tools/obscura-client.js', () => ({
  isObscuraAvailable: vi.fn(() => false),
  renderPage: vi.fn(),
}))

vi.mock('../src/observability/metrics-writer.js', () => ({
  MetricsWriter: function () { return { init: mockMetricsWriterInit } },
}))

vi.mock('../src/observability/eval/observation-eval.js', () => ({
  runObservationEval: vi.fn(() => ({
    scores: { survivalRate: 0.85, totalDiscovered: 10, currentActive: 8 },
  })),
}))

vi.mock('../src/observability/eval/system-health.js', () => ({
  runSystemHealthEval: vi.fn(() => ({
    scores: { llmLatencyP50: 120, llmLatencyP95: 500, taskSuccessRate: 0.95 },
  })),
}))

vi.mock('node:crypto', () => ({
  createHash: mockCreateHash,
}))

vi.mock('fast-xml-parser', () => ({
  XMLParser: function () { return { parse: mockXMLParserParse } },
}))

// ── Imports ──────────────────────────────────────────────────────

import type { TaskDeps } from '../src/scheduler/scheduler.js'

import { executeBubbleCompaction } from '../src/scheduler/tasks/bubble-compaction.js'
import { executeCausalEval } from '../src/scheduler/tasks/causal-eval.js'
import { executeConcentrationScan } from '../src/scheduler/tasks/concentration-scan.js'
import { executeConceptForge } from '../src/scheduler/tasks/concept-forge.js'
import { executeDailyDigest } from '../src/scheduler/tasks/daily-digest.js'
import { executeEvalObservation } from '../src/scheduler/tasks/eval-observation.js'
import { executeEvalSystemHealth } from '../src/scheduler/tasks/eval-system-health.js'
import { executeFeedWatcher } from '../src/scheduler/tasks/feed-watcher.js'
import { executeKeywordMonitor } from '../src/scheduler/tasks/keyword-monitor.js'
import { executeLearningDigest } from '../src/scheduler/tasks/learning-digest.js'
import { executeMemoryDecay } from '../src/scheduler/tasks/memory-decay.js'
import { executeMetricsRollup } from '../src/scheduler/tasks/metrics-rollup.js'
import { executeObsidianIngest } from '../src/scheduler/tasks/obsidian-ingest.js'
import { executeOrientationSnapshot } from '../src/scheduler/tasks/orientation-snapshot.js'
import { executePressureSim } from '../src/scheduler/tasks/pressure-sim.js'
import { executeReflection } from '../src/scheduler/tasks/reflection.js'
import { executeSelfDialogue } from '../src/scheduler/tasks/self-dialogue.js'
import { executeSelfEvolution } from '../src/scheduler/tasks/self-evolution.js'
import { executeSessionCompression } from '../src/scheduler/tasks/session-compression.js'
import { executeSilenceScan } from '../src/scheduler/tasks/silence-scan.js'
import { executeSteelPrice } from '../src/scheduler/tasks/steel-price.js'
import { executeInterestSearch } from '../src/scheduler/tasks/interest-search.js'
import { executeQuestionGenerator } from '../src/scheduler/tasks/question-generator.js'

// ── Helpers ──────────────────────────────────────────────────────

function mockDeps(overrides: Partial<TaskDeps> = {}): TaskDeps {
  return {
    brain: { think: vi.fn().mockResolvedValue({ response: '思考结果' }) } as any,
    memory: { getActiveFocusUserIds: vi.fn().mockResolvedValue([]), getRecentTopics: vi.fn().mockResolvedValue('') } as any,
    tools: { execute: vi.fn().mockResolvedValue('搜索结果') } as any,
    llm: { chat: vi.fn().mockResolvedValue({ content: 'LLM响应内容' }) } as any,
    llmRouter: undefined,
    feishu: undefined,
    eventBus: undefined,
    config: undefined,
    orientationGraph: undefined,
    causalEvaluator: undefined,
    internalizationEngine: undefined,
    conceptForge: undefined,
    obsidianIngest: undefined,
    ...overrides,
  }
}

// ── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  // Reset mock call history without clearing implementations
  // (clearAllMocks in vitest 4.x can reset mockReturnValue on hoisted mocks)
  for (const fn of [mockCompact, mockCompactSetEventBus, mockRun, mockEvaluate, mockDetectScan, mockCompress, mockMetricsWriterInit, mockValidateSynthesis, mockGetQualitySignals, mockSetDraftMode, mockSetOrientationGraph, mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug, mockCreateBubble, mockSearchBubbles, mockFindBubblesByType, mockUpdateBubble, mockGetBubble, mockAddLink, mockFetchFn, mockCreateHash, mockXMLParserParse, mockStmt.run, mockStmt.all, mockStmt.get, mockDb.prepare]) {
    fn.mockClear()
  }
  mockCreateBubble.mockReturnValue({ id: 'b-' + Date.now() })
  global.fetch = mockFetchFn as any
  mockFetchFn.mockResolvedValue({
    ok: true,
    text: vi.fn().mockResolvedValue('<html><title>Test</title><body>价格 3800 元/吨</body></html>'),
  })

  // Reset + re-set shared stmt mocks (use reset to clear mockReturnValueOnce queue)
  mockStmt.all.mockReset()
  mockStmt.all.mockReturnValue([{ space_id: 's-1' }])
  mockStmt.get.mockReset()
  mockStmt.get.mockReturnValue(undefined)
  mockStmt.run.mockReset()
  mockStmt.run.mockReturnValue({ changes: 3 })
})

afterEach(() => {
  delete (global as any).fetch
})

// ══════════════════════════════════════════════════════════════════
//  Scheduler Tasks
// ══════════════════════════════════════════════════════════════════

describe('executeBubbleCompaction', () => {
  it('returns success with summary message', async () => {
    mockCompact.mockResolvedValue({
      synthesized: 3, portrayed: 1, clustersFound: 2, skipped: 0, newBubbleIds: ['b1'],
    })
    mockValidateSynthesis.mockReturnValue({ quality: 'good', score: 0.8 })

    const result = await executeBubbleCompaction({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('泡泡蒸馏')
  })

  it('handles errors per space without failing the task', async () => {
    mockCompact.mockRejectedValue(new Error('compaction error'))

    const result = await executeBubbleCompaction({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockLogger.error).toHaveBeenCalled()
  })
})

describe('executeCausalEval', () => {
  it('returns success with evaluation counts', async () => {
    mockEvaluate.mockResolvedValue({ evaluated: 5, contradicts: 1, extends: 2 })

    const result = await executeCausalEval({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('因果评估')
    expect(result.message).toContain('5')
  })

  it('handles empty spaces', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeCausalEval({}, mockDeps())
    expect(result.success).toBe(true)
  })
})

describe('executeConcentrationScan', () => {
  it('returns success when no warnings', async () => {
    const result = await executeConcentrationScan({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未发现过度集中')
  })

  it('creates warning bubbles when threshold exceeded', async () => {
    const { getConcentrationMetrics } = await import('../src/connector/biz/structured-store.js')
    vi.mocked(getConcentrationMetrics).mockReturnValue({
      supplierConcentration: {
        topN: 3, topNShare: 85, totalAmount: 1000000, warning: true,
        topItems: [{ name: '供应商A', amount: 500000, share: 50 }],
      },
      customerConcentration: {
        topN: 3, topNShare: 40, totalAmount: 80000, warning: false,
        topItems: [],
      },
      threshold: 60,
    })

    const result = await executeConcentrationScan({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalled()
  })
})

describe('executeConceptForge', () => {
  it('returns skipped when conceptForge not available', async () => {
    const result = await executeConceptForge({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未启用')
  })

  it('forges concepts when deps.conceptForge is set', async () => {
    const result = await executeConceptForge({}, mockDeps({ conceptForge: { forge: vi.fn().mockResolvedValue([{ name: 'Isomorphism A', confidence: 0.9, bubbleId: 'b-1' }]) } as any }))
    expect(result.success).toBe(true)
    expect(result.message).toContain('Isomorphism A')
  })
})

describe('executeDailyDigest', () => {
  it('returns message when no data in last 24h', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeDailyDigest({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('没有新数据')
  })

  it('generates digest with bubbles and LLM summary', async () => {
    mockStmt.all.mockReturnValue([
      { type: 'event', title: '钢材价格', content: '3800', confidence: 0.9 },
    ])
    const result = await executeDailyDigest({}, mockDeps({ feishu: { pushMessage: vi.fn(), getAdminChatId: vi.fn(() => 'chat-1') } as any }))
    expect(result.success).toBe(true)
    expect(result.message).toContain('生成摘要')
    expect(mockCreateBubble).toHaveBeenCalled()
  })

  it('falls back to mechanical summary when LLM fails', async () => {
    mockStmt.all.mockReturnValue([
      { type: 'event', title: '钢材价格', content: '3800', confidence: 0.9 },
    ])
    const result = await executeDailyDigest({}, mockDeps({ llm: { chat: vi.fn().mockRejectedValue(new Error('down')) } as any }))
    expect(result.success).toBe(true)
    expect(result.message).toContain('生成摘要')
  })
})

describe('executeEvalObservation', () => {
  it('returns eval scores', async () => {
    const result = await executeEvalObservation({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('survival rate')
    expect(mockMetricsWriterInit).toHaveBeenCalled()
  })

  it('handles no observations', async () => {
    const { runObservationEval } = await import('../src/observability/eval/observation-eval.js')
    vi.mocked(runObservationEval).mockReturnValue(null)
    const result = await executeEvalObservation({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('No observations')
  })
})

describe('executeEvalSystemHealth', () => {
  it('returns health scores', async () => {
    const result = await executeEvalSystemHealth({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('System health')
    expect(mockMetricsWriterInit).toHaveBeenCalled()
  })

  it('handles no data', async () => {
    const { runSystemHealthEval } = await import('../src/observability/eval/system-health.js')
    vi.mocked(runSystemHealthEval).mockReturnValue(null)
    const result = await executeEvalSystemHealth({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('No data')
  })
})

describe('executeFeedWatcher', () => {
  it('skips when no enabled feeds', async () => {
    const result = await executeFeedWatcher({ feeds: [] }, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('无启用的信息源')
  })

  it('processes one feed item', async () => {
    mockXMLParserParse.mockReturnValue({
      rss: { channel: { item: [{ title: 'AI News', description: 'Content', link: 'https://ex.com' }] } },
    })
    mockFetchFn.mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue('<rss><channel><item><title>AI</title></item></channel></rss>'),
    })
    mockStmt.all.mockReturnValue([]) // no dedup hits
    mockStmt.get.mockReturnValue(undefined)

    const { calcSurprise } = await import('../src/memory/manager.js')
    vi.mocked(calcSurprise).mockReturnValue({ score: 0.8, contradicts: false, nearDuplicate: null })

    const result = await executeFeedWatcher({
      feeds: [{ id: 'f1', name: 'F1', type: 'rss', url: 'https://ex.com/rss', tags: ['ai'], enabled: true }],
      maxItemsPerFeed: 5, maxContentLength: 2000, surpriseThreshold: 0.3,
    }, mockDeps())

    expect(result.success).toBe(true)
  })

  it('handles fetch errors gracefully', async () => {
    mockFetchFn.mockRejectedValue(new Error('Network error'))

    const result = await executeFeedWatcher({
      feeds: [{ id: 'f1', name: 'F1', type: 'rss', url: 'https://ex.com/bad', tags: [], enabled: true }],
      maxItemsPerFeed: 5, maxContentLength: 2000, surpriseThreshold: 0.3,
    }, mockDeps())

    // errorCount=1, checkedCount=1 → errors=1, checked=1 → 1<1 is false → success=false
    expect(result.success).toBe(false)
    expect(result.message).toContain('错误')
  })
})

describe('executeKeywordMonitor', () => {
  it('skips when no keywords', async () => {
    const result = await executeKeywordMonitor({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未配置')
  })

  it('searches and creates bubbles', async () => {
    const result = await executeKeywordMonitor({ keywords: ['螺纹钢'] }, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalled()
  })

  it('skips when result has no findings', async () => {
    const deps = mockDeps({ tools: { execute: vi.fn().mockResolvedValue('未找到相关结果') } as any })
    const result = await executeKeywordMonitor({ keywords: ['xyz'] }, deps)
    expect(result.success).toBe(true)
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })
})

describe('executeLearningDigest', () => {
  it('returns skip when no auto-produced bubbles in 24h', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeLearningDigest({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('无自动产出')
  })

  it('generates digest from auto-produced bubbles', async () => {
    mockStmt.all
      .mockReturnValue([{ id: 'b-1', type: 'event', title: '发现', content: 'new', source: 'interest-search', tags: '["trending"]', confidence: 0.9, created_at: Date.now() }])
    mockStmt.get.mockReturnValue(undefined) // no last digest
    mockCreateBubble.mockReturnValue({ id: 'digest-1' })

    const result = await executeLearningDigest({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('学习日报')
    expect(mockCreateBubble).toHaveBeenCalled()
  })
})

describe('executeMemoryDecay', () => {
  it('runs deletion and decay queries', async () => {
    mockStmt.run.mockReturnValue({ changes: 5 })
    const result = await executeMemoryDecay({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('清理')
    expect(mockDb.prepare).toHaveBeenCalled()
  })
})

describe('executeMetricsRollup', () => {
  it('deletes old metrics, spans, traces', async () => {
    const result = await executeMetricsRollup({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('Rollup')
    expect(mockStmt.run).toHaveBeenCalledTimes(3)
  })
})

describe('executeObsidianIngest', () => {
  it('skips when obsidianIngest not available', async () => {
    const result = await executeObsidianIngest({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未启用')
  })

  it('ingests when obsidianIngest is set', async () => {
    const deps = mockDeps({ obsidianIngest: { ingest: vi.fn().mockResolvedValue({ created: 2, updated: 1, staled: 0, skipped: 3, denied: 0 }) } as any })
    const result = await executeObsidianIngest({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('新增 2')
  })
})

describe('executeOrientationSnapshot', () => {
  it('skips when orientationGraph not available', async () => {
    const result = await executeOrientationSnapshot({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未启用')
  })

  it('builds snapshot and creates wiki', async () => {
    mockStmt.all.mockReturnValue([{ space_id: 's-1' }])
    mockStmt.get.mockReturnValue(undefined)
    const deps = mockDeps({ orientationGraph: { buildSnapshot: vi.fn().mockResolvedValue({ spaceId: 's-1', nodes: [], frontiers: [], tensions: [] }) } as any })
    const result = await executeOrientationSnapshot({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('认知快照')
  })

  it('emits tension events when eventBus present', async () => {
    const mockEventBus = { emitFireAndForget: vi.fn() }
    const deps = mockDeps({
      orientationGraph: { buildSnapshot: vi.fn().mockResolvedValue({ spaceId: 's-1', nodes: [{ observationId: 'o-1', domain: 'steel', band: 'established', gapScore: 0.2, freshness: 3, dependsOn: [] }], frontiers: [], tensions: [{ a: 'o-1', b: 'o-2', reason: 'conflict' }] }) } as any,
      eventBus: mockEventBus as any,
    })
    await executeOrientationSnapshot({}, deps)
    expect(mockEventBus.emitFireAndForget).toHaveBeenCalled()
  })
})

describe('executePressureSim', () => {
  it('runs scenarios and returns check results', async () => {
    mockCreateBubble.mockReturnValue({ id: 'pb-' + Date.now() })
    mockFindBubblesByType.mockReturnValue([])
    mockSearchBubbles.mockReturnValue([])
    const result = await executePressureSim({}, mockDeps())
    expect(result.message).toContain('压力模拟')
  })
})

describe('executeReflection', () => {
  it('returns success with discovery counts', async () => {
    mockRun.mockResolvedValue({ discovered: 2, validated: 1, staled: 0 })
    const result = await executeReflection({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('反思引擎')
  })

  it('handles empty spaces', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeReflection({}, mockDeps())
    expect(result.success).toBe(true)
  })
})

describe('executeSelfDialogue', () => {
  it('returns message when no spaces exist', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeSelfDialogue({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('自对话')
  })

  it('answers unanswered questions', async () => {
    mockFindBubblesByType.mockReturnValue([{ id: 'q-1', title: 'Why?', content: 'why', metadata: { answered: false }, source: 'user', createdAt: Date.now() - 3600000, spaceId: 's-1' }])
    mockStmt.all.mockReturnValue([])
    const result = await executeSelfDialogue({}, mockDeps())
    expect(result.success).toBe(true)
  })

  it('generates new question when none to answer', async () => {
    mockStmt.all.mockReturnValueOnce([{ space_id: 's-1' }]).mockReturnValueOnce([
      { id: 'm-1', type: 'memory', title: '钢材', content: '价格3800', space_id: 's-1' },
      { id: 'm-2', type: 'memory', title: '混凝土', content: 'C30', space_id: 's-1' },
      { id: 'm-3', type: 'observation', title: '观察', content: '需求降', space_id: 's-1' },
    ])
    mockFindBubblesByType.mockReturnValue([])
    const result = await executeSelfDialogue({}, mockDeps())
    expect(result.success).toBe(true)
  })
})

describe('executeSelfEvolution', () => {
  const origEnv = process.env.SELF_EVOLUTION

  afterEach(() => { process.env.SELF_EVOLUTION = origEnv })

  it('skips when SELF_EVOLUTION not enabled', async () => {
    process.env.SELF_EVOLUTION = 'false'
    const result = await executeSelfEvolution({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未启用')
  })

  it('skips when no un-evaluated candidates', async () => {
    process.env.SELF_EVOLUTION = 'true'
    mockStmt.all.mockReturnValue([])
    const result = await executeSelfEvolution({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('无未评估')
  })
})

describe('executeSessionCompression', () => {
  it('returns skip when no stale sessions', async () => {
    const deps = mockDeps({ brain: { think: vi.fn(), drainStaleSessions: vi.fn(() => []) } as any })
    const result = await executeSessionCompression({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('无空闲 session')
  })

  it('compresses stale sessions', async () => {
    mockCompress.mockResolvedValue({ bubbleId: 'c-1' })
    const deps = mockDeps({ brain: { think: vi.fn(), drainStaleSessions: vi.fn(() => [{ userId: 'u-1', history: [{ role: 'user', content: 'hi' }] }]) } as any })
    const result = await executeSessionCompression({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('压缩')
    expect(result.bubbleIds).toContain('c-1')
  })
})

describe('executeSilenceScan', () => {
  it('returns all-clear when no silent counterparties', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeSilenceScan({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('活跃正常')
  })

  it('detects silent counterparties', async () => {
    const pastDate = new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10)
    mockStmt.all.mockReturnValueOnce([{ space_id: 's-1' }]).mockReturnValueOnce([
      { counterparty_id: 'cp-1', last_date: pastDate, cnt: 10, first_date: '2024-01-01' },
    ])
    mockStmt.get.mockReturnValue({ id: 'cp-1', name: '旧客户', type: 'customer' })
    mockSearchBubbles.mockReturnValue([])
    const result = await executeSilenceScan({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('沉默')
    expect(mockCreateBubble).toHaveBeenCalled()
  })
})

describe('executeSteelPrice', () => {
  it('fetches and stores steel price', async () => {
    const result = await executeSteelPrice({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('钢材价格')
    expect(mockCreateBubble).toHaveBeenCalled()
  })

  it('handles fetch failure', async () => {
    mockFetchFn.mockResolvedValue({ ok: false, status: 503 })
    const result = await executeSteelPrice({}, mockDeps())
    expect(result.success).toBe(false)
  })

  it('handles network error', async () => {
    mockFetchFn.mockRejectedValue(new Error('timeout'))
    const result = await executeSteelPrice({}, mockDeps())
    expect(result.success).toBe(false)
  })

  it('handles empty page content', async () => {
    mockFetchFn.mockResolvedValue({ ok: true, text: vi.fn().mockResolvedValue('<html><script></script></html>') })
    const result = await executeSteelPrice({}, mockDeps())
    expect(result.success).toBe(false)
    expect(result.message).toContain('页面内容为空')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Interest Search — brief smoke (dedicated file has deeper tests)
// ══════════════════════════════════════════════════════════════════

describe('executeInterestSearch', () => {
  it('skips when TAVILY_API_KEY not set', async () => {
    const orig = process.env.TAVILY_API_KEY
    delete process.env.TAVILY_API_KEY
    const result = await executeInterestSearch({}, mockDeps())
    expect(result.success).toBe(true)
    if (orig !== undefined) process.env.TAVILY_API_KEY = orig
  })

  it('skips when no active users', async () => {
    process.env.TAVILY_API_KEY = 'mock-key'
    const getActiveFocusUserIds = vi.fn(() => [])
    const getRecentTopics = vi.fn(() => [])
    const deps = mockDeps({ memory: { getActiveFocusUserIds, getRecentTopics } as any })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('无活跃用户')
  })
})

// ══════════════════════════════════════════════════════════════════
//  Question Generator — brief smoke (dedicated file has deeper tests)
// ══════════════════════════════════════════════════════════════════

describe('executeQuestionGenerator', () => {
  it('returns no-new-questions when DB returns nothing', async () => {
    mockStmt.all.mockReturnValue([])
    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未发现新问题')
  })

  it('generates anomaly question from steel-price drift', async () => {
    const yesterday = Date.now() - 86400000
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'p-1', type: 'event', title: '价格1', content: '价格 3800 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: Date.now(), space_id: 's-1' },
        { id: 'p-2', type: 'event', title: '价格2', content: '价格 3600 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: yesterday, space_id: 's-1' },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce({ cnt: 10 })
      .mockReturnValueOnce({ cnt: 20 })
      .mockReturnValueOnce([])
    mockSearchBubbles.mockReturnValue([])
    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalled()
  })
})
