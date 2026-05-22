import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects for vi.mock factories ────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

const mockCreateBubble = vi.hoisted(() => vi.fn(() => ({ id: 'b-' + Date.now() })))
const mockSearchBubbles = vi.hoisted(() => vi.fn(() => []))
const mockAddLink = vi.hoisted(() => vi.fn())

const mockStmt = vi.hoisted(() => ({
  all: vi.fn(() => []),
  get: vi.fn(() => undefined),
  run: vi.fn(() => ({ changes: 1 })),
}))
const mockDb = vi.hoisted(() => ({
  prepare: vi.fn(() => mockStmt),
}))

// ── Module-level mocks ──────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
  searchBubbles: mockSearchBubbles,
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
}))

// ── Imports ─────────────────────────────────────────────────────

import type { TaskDeps } from '../src/scheduler/scheduler.js'
import { executeQuestionGenerator } from '../src/scheduler/tasks/question-generator.js'

// ── Helpers ─────────────────────────────────────────────────────

function mockDeps(overrides: Partial<TaskDeps> = {}): TaskDeps {
  return {
    brain: {} as any,
    memory: {} as any,
    tools: {} as any,
    llm: { chat: vi.fn().mockResolvedValue({ content: '[]' }) } as any,
    llmRouter: undefined,
    feishu: undefined,
    eventBus: undefined,
    config: undefined,
    orientationGraph: undefined,
    ...overrides,
  }
}

// ── Setup ───────────────────────────────────────────────────────

beforeEach(() => {
  for (const fn of [
    mockLogger.info, mockLogger.warn, mockLogger.error, mockLogger.debug,
    mockCreateBubble, mockSearchBubbles, mockAddLink,
    mockStmt.all, mockStmt.get, mockStmt.run, mockDb.prepare,
  ]) {
    fn.mockClear()
  }

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

// ══════════════════════════════════════════════════════════════════
//  Question Generator
// ══════════════════════════════════════════════════════════════════

describe('executeQuestionGenerator', () => {
  it('returns no questions when DB is empty', async () => {
    mockStmt.all.mockReturnValue([]) // all queries return empty
    mockStmt.get.mockReturnValue({ cnt: 0 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(result.message).toContain('未发现新问题')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })

  it('detects steel price anomaly (drift > 2%)', async () => {
    // Sequential .all() calls:
    // 1. steel-price rows (2 rows with price drift)
    // 2. event rows (empty)
    // 3. entity bubbles (empty)
    // 4. project bubbles (empty)
    // 5. delivery bubbles (empty) — but only if projects > 0; since empty, skipped
    // 6. ask-framework recent rows (empty)
    const yesterday = Date.now() - 86400000
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'p-1', type: 'event', title: '价格1', content: '价格 3800 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: Date.now(), space_id: 's-1' },
        { id: 'p-2', type: 'event', title: '价格2', content: '价格 3600 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: yesterday, space_id: 's-1' },
      ])  // steel-price rows
      .mockReturnValueOnce([])  // event rows (non-steel-price)
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // ask-framework recent rows (< 5 rows → skipped)

    // Activity counts: thisWeek, lastWeek
    mockStmt.get
      .mockReturnValueOnce({ cnt: 10 })   // this week count
      .mockReturnValueOnce({ cnt: 20 })   // last week count

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalled()
    // Should create at least the anomaly question
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'question' }),
    )
  })

  it('detects steel price sustained trend (3+ days)', async () => {
    const now = Date.now()
    const day = 86400000
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'p-1', type: 'event', title: '价格1', content: '价格 3800 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: now, space_id: 's-1' },
        { id: 'p-2', type: 'event', title: '价格2', content: '价格 3650 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: now - day, space_id: 's-1' },
        { id: 'p-3', type: 'event', title: '价格3', content: '价格 3500 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: now - 2 * day, space_id: 's-1' },
      ])  // 3 descending prices
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // ask-framework

    mockStmt.get
      .mockReturnValueOnce({ cnt: 10 })
      .mockReturnValueOnce({ cnt: 20 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    // Trend detection should fire for 3+ day continuous downward trend > 3%
    expect(mockCreateBubble).toHaveBeenCalled()
    const callArgs = vi.mocked(mockCreateBubble).mock.calls.map(c => c[0])
    const trendCall = callArgs.find((a: any) => a.title && a.title.includes('连续下跌'))
    expect(trendCall).toBeTruthy()
  })

  it('detects event tag burst anomaly', async () => {
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce(Array.from({ length: 12 }, (_, i) => ({
        id: `evt-${i}`, type: 'event', title: `Event ${i}`, content: 'data',
        tags: JSON.stringify(['burst-topic', 'auto-discovered']),
        metadata: '{}', created_at: Date.now(), space_id: 's-1',
      })))  // 12 events with same tag
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // ask-framework

    mockStmt.get
      .mockReturnValueOnce({ cnt: 5 })
      .mockReturnValueOnce({ cnt: 5 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    // Tag burst > 10 → should create question
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('事件激增'),
      }),
    )
  })

  it('detects silent entities', async () => {
    const longAgo = Date.now() - 20 * 86400000  // 20 days ago
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce(Array.from({ length: 5 }, (_, i) => ({
        id: `entity-${i}`, type: 'memory', title: '合作客户公司', content: `供应商 ${i} 长期合作`,
        tags: '["供应商"]', metadata: '{}', created_at: longAgo, space_id: 's-1',
      })))  // entity/memory bubbles with supplier names
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // ask-framework

    mockStmt.get
      .mockReturnValueOnce({ cnt: 5 })
      .mockReturnValueOnce({ cnt: 5 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    // Entity with count >= 3 and lastSeen > silenceDays → silent link question
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('沉默'),
      }),
    )
  })

  it('detects information gap: projects without delivery records', async () => {
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([   // project bubbles — projects exist
        { id: 'proj-1', title: '桥梁工程', content: '进度正常', space_id: 's-1' },
        { id: 'proj-2', title: '隧道项目', content: '施工中', space_id: 's-1' },
      ])
      .mockReturnValueOnce([])  // delivery bubbles — empty! → gap detected
      .mockReturnValueOnce([])  // ask-framework

    mockStmt.get
      .mockReturnValueOnce({ cnt: 5 })
      .mockReturnValueOnce({ cnt: 5 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('配送记录'),
      }),
    )
  })

  it('detects activity drop (this week < 30% of last week)', async () => {
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // delivery bubbles (skipped since no projects)
      .mockReturnValueOnce([])  // ask-framework

    // lastWeek.cnt = 100, thisWeek.cnt = 20 → 20 < 30 → drop detected
    mockStmt.get
      .mockReturnValueOnce({ cnt: 20 })   // this week
      .mockReturnValueOnce({ cnt: 100 })  // last week

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining('数据量'),
      }),
    )
  })

  it('LLM ask-framework generates deeper questions', async () => {
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce([])  // entity bubbles
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // delivery bubbles
      .mockReturnValueOnce(Array.from({ length: 10 }, (_, i) => ({
        id: `recent-${i}`, type: 'observation', title: `Observation ${i}`,
        content: 'relevant data point', tags: '["auto-discovered"]',
        metadata: '{}', created_at: Date.now(), space_id: 's-1',
      })))  // 10 recent rows → enough for ask-framework (> 5)

    mockStmt.get
      .mockReturnValueOnce({ cnt: 5 })
      .mockReturnValueOnce({ cnt: 5 })

    const deps = mockDeps({
      llm: { chat: vi.fn().mockResolvedValue({
        content: '[{"title": "为什么趋势变了", "content": "近期模式转变值得深入追问"}]',
      }) } as any,
    })

    const result = await executeQuestionGenerator({}, deps)
    expect(result.success).toBe(true)
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.arrayContaining(['ask-framework']),
      }),
    )
  })

  it('deduplicates against existing question bubbles', async () => {
    // Return an existing question bubble from searchBubbles
    mockSearchBubbles.mockReturnValue([
      { type: 'question', createdAt: Date.now() - 86400000 },  // within 3-day dedup window
    ])

    // steel-price rows with drift → would generate anomaly question
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

    mockStmt.get
      .mockReturnValueOnce({ cnt: 10 })
      .mockReturnValueOnce({ cnt: 20 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    // All questions should be deduped → no createBubble
    expect(result.message).toContain('未发现新问题')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })

  it('DB query failure does not crash the task', async () => {
    mockStmt.all.mockImplementation(() => { throw new Error('DB connection lost') })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)  // still succeeds, logs error
    expect(mockLogger.error).toHaveBeenCalled()
  })

  it('sends Feishu notification when new questions found', async () => {
    const yesterday = Date.now() - 86400000
    const pushMessage = vi.fn()
    const getAdminChatId = vi.fn(() => 'chat-admin-1')

    mockStmt.all
      .mockReturnValueOnce([
        { id: 'p-1', type: 'event', title: '价格1', content: '价格 3800 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: Date.now(), space_id: 's-1' },
        { id: 'p-2', type: 'event', title: '价格2', content: '价格 3600 元/吨', tags: '["steel-price"]', metadata: '{}', created_at: yesterday, space_id: 's-1' },
      ])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])
      .mockReturnValueOnce([])

    mockStmt.get
      .mockReturnValueOnce({ cnt: 10 })
      .mockReturnValueOnce({ cnt: 20 })

    const result = await executeQuestionGenerator({}, mockDeps({
      feishu: { pushMessage, getAdminChatId } as any,
    }))

    expect(result.success).toBe(true)
    expect(pushMessage).toHaveBeenCalled()
    expect(mockCreateBubble).toHaveBeenCalled()
  })

  it('does not flag entities with fewer than 3 occurrences as silent', async () => {
    const longAgo = Date.now() - 20 * 86400000
    mockStmt.all
      .mockReturnValueOnce([])  // steel-price rows
      .mockReturnValueOnce([])  // event rows
      .mockReturnValueOnce([   // entity bubbles — only 1 occurrence per entity
        { id: 'ent-1', type: 'memory', title: '某供应商公司', content: '供应商 测试',
          tags: '["供应商"]', metadata: '{}', created_at: longAgo, space_id: 's-1' },
      ])
      .mockReturnValueOnce([])  // project bubbles
      .mockReturnValueOnce([])  // ask-framework

    mockStmt.get
      .mockReturnValueOnce({ cnt: 5 })
      .mockReturnValueOnce({ cnt: 5 })

    const result = await executeQuestionGenerator({}, mockDeps())
    expect(result.success).toBe(true)
    // Entity count is 1 < 3 → should NOT create silent link question
    const silentCalls = vi.mocked(mockCreateBubble).mock.calls.filter(
      c => c[0] && c[0].title && c[0].title.includes('沉默'),
    )
    expect(silentCalls).toHaveLength(0)
  })
})
