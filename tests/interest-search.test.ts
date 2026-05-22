import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── vi.hoisted: shared mock objects for vi.mock factories ────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

const mockCreateBubble = vi.hoisted(() => vi.fn(() => ({ id: 'b-' + Date.now() })))
const mockSearchBubbles = vi.hoisted(() => vi.fn(() => []))
const mockFindBubblesByType = vi.hoisted(() => vi.fn(() => []))
const mockUpdateBubble = vi.hoisted(() => vi.fn())
const mockAddLink = vi.hoisted(() => vi.fn())

const mockStmt = vi.hoisted(() => ({
  all: vi.fn(() => []),
  get: vi.fn(() => undefined),
  run: vi.fn(() => ({ changes: 1 })),
}))
const mockDb = vi.hoisted(() => ({
  prepare: vi.fn(() => mockStmt),
}))

const mockCalcSurprise = vi.hoisted(() => vi.fn(() => ({
  score: 0.1, contradicts: false, nearDuplicate: null,
})))

const mockIsObscuraAvailable = vi.hoisted(() => vi.fn(() => false))
const mockRenderPage = vi.hoisted(() => vi.fn())

// ── Module-level mocks ──────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
  searchBubbles: mockSearchBubbles,
  findBubblesByType: mockFindBubblesByType,
  updateBubble: mockUpdateBubble,
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
}))

vi.mock('../src/memory/manager.js', () => ({
  calcSurprise: mockCalcSurprise,
}))

vi.mock('../src/connector/tools/obscura-client.js', () => ({
  isObscuraAvailable: mockIsObscuraAvailable,
  renderPage: mockRenderPage,
}))

// ── Imports ─────────────────────────────────────────────────────

import type { TaskDeps } from '../src/scheduler/scheduler.js'
import { executeInterestSearch } from '../src/scheduler/tasks/interest-search.js'

// ── Helpers ─────────────────────────────────────────────────────

function mockDeps(overrides: Partial<TaskDeps> = {}): TaskDeps {
  return {
    brain: {} as any,
    memory: {
      getActiveFocusUserIds: vi.fn(() => ['user-1']),
      getRecentTopics: vi.fn(() => [
        { term: 'AI', freq: 5 },
        { term: 'steel', freq: 3 },
      ]),
    } as any,
    tools: { execute: vi.fn().mockResolvedValue('搜索结果: 钢材市场新闻 价格3800') } as any,
    llm: { chat: vi.fn().mockResolvedValue({ content: '["AI latest breakthroughs", "steel market trends"]' }) } as any,
    llmRouter: undefined,
    feishu: undefined,
    eventBus: undefined,
    config: undefined,
    orientationGraph: undefined,
    causalEvaluator: undefined,
    internalizationEngine: undefined,
    ...overrides,
  }
}

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  for (const fn of [
    mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug,
    mockCreateBubble, mockSearchBubbles, mockFindBubblesByType, mockUpdateBubble, mockAddLink,
    mockCalcSurprise, mockIsObscuraAvailable, mockRenderPage,
    mockStmt.all, mockStmt.get, mockStmt.run, mockDb.prepare,
  ]) {
    fn.mockClear()
  }

  // Ensure TAVILY_API_KEY is set by default
  process.env.TAVILY_API_KEY = 'test-key'

  // Default stmt returns
  mockStmt.all.mockReset()
  mockStmt.all.mockReturnValue([])
  mockStmt.get.mockReset()
  mockStmt.get.mockReturnValue(undefined)
  mockStmt.run.mockReset()
  mockStmt.run.mockReturnValue({ changes: 1 })

  mockCreateBubble.mockReturnValue({ id: 'b-' + Date.now() })
  mockSearchBubbles.mockReset()
  mockSearchBubbles.mockReturnValue([])
})

afterEach(() => {
  // Restore env if we deleted it in a test
  if (!process.env.TAVILY_API_KEY) {
    process.env.TAVILY_API_KEY = 'test-key'
  }
})

// ══════════════════════════════════════════════════════════════════
//  Interest Search
// ══════════════════════════════════════════════════════════════════

describe('executeInterestSearch', () => {
  it('skips when TAVILY_API_KEY not set', async () => {
    delete process.env.TAVILY_API_KEY
    const result = await executeInterestSearch({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未配置')
  })

  it('skips when no active users', async () => {
    const deps = mockDeps({
      memory: {
        getActiveFocusUserIds: vi.fn(() => []),
        getRecentTopics: vi.fn(() => []),
      } as any,
    })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('无活跃用户')
  })

  it('skips when all focus terms are stop words', async () => {
    const deps = mockDeps({
      memory: {
        getActiveFocusUserIds: vi.fn(() => ['user-1']),
        getRecentTopics: vi.fn(() => [
          { term: '的', freq: 10 },
          { term: '了', freq: 8 },
          { term: '你好', freq: 3 },
        ]),
      } as any,
    })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('无可搜索')
  })

  it('pre-flight dedup skips when all focus terms covered by recent searches', async () => {
    mockStmt.all.mockReturnValue([
      { metadata: JSON.stringify({ query: 'AI news' }) },
      { metadata: JSON.stringify({ query: 'steel price 2025' }) },
    ])
    const deps = mockDeps({
      memory: {
        getActiveFocusUserIds: vi.fn(() => ['user-1']),
        getRecentTopics: vi.fn(() => [
          { term: 'AI', freq: 5 },
          { term: 'steel', freq: 3 },
        ]),
      } as any,
    })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('已全部搜索过')
  })

  it('LLM generates queries, searches web, and creates bubbles', async () => {
    mockCalcSurprise.mockReturnValue({ score: 0.5, contradicts: false, nearDuplicate: null })

    const result = await executeInterestSearch({}, mockDeps())

    expect(result.success).toBe(true)
    // Should have created at least one bubble
    expect(mockCreateBubble).toHaveBeenCalled()
    // Should have called web_search
    const tools = mockDeps().tools as any
    expect(result.message).toContain('新增')
  })

  it('returns skip when LLM returns empty queries', async () => {
    const deps = mockDeps({
      llm: { chat: vi.fn().mockResolvedValue({ content: '[]' }) } as any,
    })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(result.message).toContain('无搜索价值')
  })

  it('handles LLM failure gracefully', async () => {
    const deps = mockDeps({
      llm: { chat: vi.fn().mockRejectedValue(new Error('LLM down')) } as any,
    })
    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(false)
    expect(result.message).toContain('LLM')
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('24h dedup filters recently searched queries', async () => {
    // Pre-flight: return some queries that don't cover all terms
    // Dedup: return overlapping query to trigger dedup
    mockStmt.all
      .mockReturnValueOnce([{ metadata: JSON.stringify({ query: 'unrelated topic' }) }])  // pre-flight — doesn't cover 'AI' or 'steel'
      .mockReturnValueOnce([{ metadata: JSON.stringify({ query: 'AI latest breakthroughs' }) }])  // dedup — overlaps with LLM query
      .mockReturnValueOnce([])  // counter-search

    const result = await executeInterestSearch({}, mockDeps())
    expect(result.success).toBe(true)
    // 'AI latest breakthroughs' should be deduped, only 'steel market trends' searched
    expect(result.message).toContain('去重')
  })

  it('creates contradiction links when conflicting info found', async () => {
    mockCalcSurprise.mockReturnValue({
      score: 0.8, contradicts: true,
      nearDuplicate: { id: 'existing-1' },
    })

    const result = await executeInterestSearch({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockAddLink).toHaveBeenCalled()
    expect(result.message).toContain('矛盾')
  })

  it('performs deep read for high-surprise results via Obscura', async () => {
    mockCalcSurprise.mockReturnValue({ score: 0.7, contradicts: false, nearDuplicate: null })
    mockIsObscuraAvailable.mockReturnValue(true)
    mockRenderPage.mockResolvedValue({ text: 'Deep content about steel industry trends and market analysis 2025 outlook and beyond. This is a much longer text that should easily exceed the 200 character threshold required for the deep read to be considered valid. The analysis covers multiple aspects of the industry including supply chain dynamics, pricing mechanisms, and global trade patterns that affect the steel market.' })
    // Search result must contain a URL for extractUrlsFromSearchResult to find it
    const deps = mockDeps({
      tools: { execute: vi.fn().mockResolvedValue('关键发现: https://example.com/steel-report 价格3800') } as any,
    })

    const result = await executeInterestSearch({}, deps)
    expect(result.success).toBe(true)
    expect(mockRenderPage).toHaveBeenCalled()
    expect(result.message).toContain('深度阅读')
  })

  it('counter-search creates challenge bubbles for high-confidence knowledge', async () => {
    // First two .all() calls (pre-flight, dedup) return [].
    // Third .all() (counter-search) returns a high-confidence bubble.
    mockStmt.all
      .mockReturnValueOnce([])  // pre-flight
      .mockReturnValueOnce([])  // dedup
      .mockReturnValueOnce([{   // counter-search target
        id: 'b-high',
        title: 'Steel Price Theory',
        content: 'Steel prices always rise in Q2',
        metadata: '{}',
        abstraction_level: 1,
        confidence: 0.9,
      }])

    // LLM returns queries + counter-query
    const llmMock = vi.fn()
    llmMock
      .mockResolvedValueOnce({ content: '["steel price trends"]' })   // query generation
      .mockResolvedValueOnce({ content: '{"counterQuery": "steel price drops Q2 evidence"}' })  // counter-query

    const result = await executeInterestSearch({}, mockDeps({
      llm: { chat: llmMock } as any,
    }))
    expect(result.success).toBe(true)
    expect(mockAddLink).toHaveBeenCalled()
    expect(result.message).toContain('反向验证')
  })

  it('handles search tool failure gracefully', async () => {
    const deps = mockDeps({
      tools: { execute: vi.fn().mockRejectedValue(new Error('API error')) } as any,
    })
    // calcSurprise not called because search throws before that
    const result = await executeInterestSearch({}, deps)
    // LLM generated queries, but search failed → should still be success
    expect(result.success).toBe(true)
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('epistemic gate blocks queries with sufficient existing knowledge', async () => {
    // Need >= 2 high-confidence observations meeting criteria for epistemic gate to block
    mockSearchBubbles.mockReturnValue([
      {
        abstractionLevel: 2,
        confidence: 0.9,
        type: 'observation',
        title: 'AI development trends obs1',
      },
      {
        abstractionLevel: 1,
        confidence: 0.85,
        type: 'observation',
        title: 'AI development trends obs2',
      },
    ])

    const result = await executeInterestSearch({}, mockDeps())
    expect(result.success).toBe(true)
    // Epistemic gate blocks → no search performed → still success
    expect(result.message).toContain('充分认知覆盖')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })
})
