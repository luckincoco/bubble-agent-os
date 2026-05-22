import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getMemoryToolDefinitions, createMemoryToolHandlers } from '../src/memory/memory-tools.js'
import type { WorkingMemory } from '../src/memory/working-memory.js'
import type { ContextBudget } from '../src/memory/context-budget.js'

const mockGetDatabase = vi.fn()
vi.mock('../src/storage/database.js', () => ({
  getDatabase: (...args: unknown[]) => mockGetDatabase(...args),
}))

const mockSearchBubbles = vi.fn()
vi.mock('../src/bubble/model.js', () => ({
  searchBubbles: (...args: unknown[]) => mockSearchBubbles(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

// ── getMemoryToolDefinitions ─────────────────────────────────────

describe('getMemoryToolDefinitions', () => {
  it('返回 5 个工具定义', () => {
    const defs = getMemoryToolDefinitions()
    expect(defs).toHaveLength(5)
    const names = defs.map(d => d.name)
    expect(names).toEqual(['memory_status', 'memory_load', 'memory_evict', 'memory_pin', 'memory_list_notes'])
  })

  it('memory_load 有 query 参数', () => {
    const defs = getMemoryToolDefinitions()
    const load = defs.find(d => d.name === 'memory_load')!
    expect(load.parameters.query).toBeDefined()
    expect(load.parameters.query.required).toBe(true)
  })
})

// ── memory_status ─────────────────────────────────────────────────

describe('memory_status handler', () => {
  it('返回 budget/tiers/hotItems JSON', async () => {
    const wm = {
      getStatus: vi.fn().mockReturnValue({ hotCount: 3, hotTokens: 1500, warmCount: 5, coldCount: 10, budgetTotal: 8000, budgetUsed: 1500 }),
      getHotItems: vi.fn().mockReturnValue([
        { bubbleId: 'b1', priorityScore: 0.95, pinned: false, tokenCost: 500 },
        { bubbleId: 'b2', priorityScore: 0.80, pinned: true, tokenCost: 300 },
      ]),
    } as unknown as WorkingMemory
    const budget = {
      getReport: vi.fn().mockReturnValue({ availableForMemory: 3500, currentUsage: 1500, remainingCapacity: 2000, utilizationPercent: 43 }),
    } as unknown as ContextBudget
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn().mockReturnValue({
        get: vi.fn()
          .mockReturnValueOnce({ title: '记忆1', confidence: 0.9 })
          .mockReturnValueOnce({ title: '记忆2', confidence: 0.8 }),
      }),
    })

    const handlers = createMemoryToolHandlers(wm, budget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_status())

    expect(result.budget.total).toBe(3500)
    expect(result.budget.used).toBe(1500)
    expect(result.tiers.hot).toBe(3)
    expect(result.hotItems).toHaveLength(2)
    expect(result.hotItems[0].title).toBe('记忆1')
    expect(result.hotItems[0].pinned).toBe(false)
  })

  it('未知 bubble 标题显示 (unknown)', async () => {
    const wm = {
      getStatus: vi.fn().mockReturnValue({ hotCount: 1, hotTokens: 100, warmCount: 0, coldCount: 0, budgetTotal: 8000, budgetUsed: 100 }),
      getHotItems: vi.fn().mockReturnValue([{ bubbleId: 'ghost', priorityScore: 0.5, pinned: false, tokenCost: 100 }]),
    } as unknown as WorkingMemory
    const budget = {
      getReport: vi.fn().mockReturnValue({ availableForMemory: 3500, currentUsage: 100, remainingCapacity: 3400, utilizationPercent: 3 }),
    } as unknown as ContextBudget
    mockGetDatabase.mockReturnValue({
      prepare: vi.fn().mockReturnValue({ get: vi.fn().mockReturnValue(undefined) }),
    })

    const handlers = createMemoryToolHandlers(wm, budget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_status())
    expect(result.hotItems[0].title).toBe('(unknown)')
  })
})

// ── memory_load ───────────────────────────────────────────────────

describe('memory_load handler', () => {
  it('加载匹配的 bubble 到 working memory', async () => {
    const wm = {
      load: vi.fn().mockReturnValue({ tokenCost: 300 }),
    } as unknown as WorkingMemory
    mockSearchBubbles.mockReturnValue([
      { id: 'b1', title: '需求文档', confidence: 0.95 },
      { id: 'b2', title: '架构图', confidence: 0.85 },
    ])

    const handlers = createMemoryToolHandlers(wm, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_load({ query: '需求' }))

    expect(result.loaded).toBe(2)
    expect(result.items).toHaveLength(2)
    expect(result.items[0].title).toBe('需求文档')
    expect(wm.load).toHaveBeenCalledTimes(2)
  })

  it('无匹配返回 loaded=0', async () => {
    mockSearchBubbles.mockReturnValue([])
    const handlers = createMemoryToolHandlers({} as WorkingMemory, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_load({ query: '不存在' }))
    expect(result.loaded).toBe(0)
  })

  it('limit 参数控制加载数量', async () => {
    const wm = { load: vi.fn().mockReturnValue({ tokenCost: 100 }) } as unknown as WorkingMemory
    mockSearchBubbles.mockReturnValue([
      { id: 'b1', title: 'A', confidence: 0.9 },
      { id: 'b2', title: 'B', confidence: 0.8 },
      { id: 'b3', title: 'C', confidence: 0.7 },
    ])
    const handlers = createMemoryToolHandlers(wm, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_load({ query: 'test', limit: 1 }))
    expect(result.loaded).toBe(1)
    expect(result.items).toHaveLength(1)
  })
})

// ── memory_evict ──────────────────────────────────────────────────

describe('memory_evict handler', () => {
  it('调用 evict 并返回状态', async () => {
    const wm = {
      evict: vi.fn(),
      getStatus: vi.fn().mockReturnValue({ budgetTotal: 8000, hotTokens: 500 }),
    } as unknown as WorkingMemory
    const handlers = createMemoryToolHandlers(wm, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_evict({ bubble_id: 'b1' }))
    expect(wm.evict).toHaveBeenCalledWith('s1', 'b1')
    expect(result.evicted).toBe('b1')
    expect(result.remainingTokens).toBe(7500)
  })
})

// ── memory_pin ────────────────────────────────────────────────────

describe('memory_pin handler', () => {
  it('调用 pin 并返回消息', async () => {
    const wm = { pin: vi.fn() } as unknown as WorkingMemory
    const handlers = createMemoryToolHandlers(wm, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_pin({ bubble_id: 'b1' }))
    expect(wm.pin).toHaveBeenCalledWith('s1', 'b1')
    expect(result.pinned).toBe('b1')
  })
})

// ── memory_list_notes ─────────────────────────────────────────────

describe('memory_list_notes handler', () => {
  it('返回格式化笔记列表', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([
          { id: 'n1', title: '笔记1', content: '这是一条笔记内容', confidence: 0.9, created_at: 1700000000000, updated_at: 1700000000000, file_path: '/docs/note1.md' },
          { id: 'n2', title: '笔记2', content: '另一条笔记', confidence: 0.8, created_at: 1700000000000, updated_at: 1700000000000, file_path: '/docs/note2.md' },
        ]),
      }),
    }
    mockGetDatabase.mockReturnValue(mockDb)

    const handlers = createMemoryToolHandlers({} as WorkingMemory, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_list_notes())

    expect(result.count).toBe(2)
    expect(result.notes).toHaveLength(2)
    expect(result.notes[0].title).toBe('笔记1')
    expect(result.notes[0].path).toBe('/docs/note1.md')
    expect(result.notes[0].summary).toBeDefined()
  })

  it('无笔记返回 count=0', async () => {
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }),
    }
    mockGetDatabase.mockReturnValue(mockDb)

    const handlers = createMemoryToolHandlers({} as WorkingMemory, {} as ContextBudget, 's1', 'space-1')
    const result = JSON.parse(await handlers.memory_list_notes())

    expect(result.count).toBe(0)
    expect(result.message).toBeDefined()
  })
})
