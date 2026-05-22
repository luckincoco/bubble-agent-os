import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calcSurprise, MemoryManager } from '../src/memory/manager.js'
import type { LLMProvider, Bubble } from '../src/shared/types.js'

// ── Module mocks (all synchronous, no vi.hoisted) ────────────────

vi.mock('../src/memory/extractor.js', () => ({
  MemoryExtractor: vi.fn().mockImplementation(function () {
    return { extract: vi.fn() }
  }),
}))

vi.mock('../src/bubble/aggregator.js', () => ({
  BubbleAggregator: vi.fn().mockImplementation(function () {
    return {
      aggregateSummaries: vi.fn(),
      loadFullBubbles: vi.fn(),
      aggregate: vi.fn(),
      setEmbeddingProvider: vi.fn(),
    }
  }),
}))

vi.mock('../src/memory/contradiction-resolver.js', () => ({
  ContradictionResolver: vi.fn().mockImplementation(function () {
    return { detect: vi.fn(), resolve: vi.fn() }
  }),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: vi.fn().mockReturnValue({ id: 'mock-bubble' }),
  getAllMemoryBubbles: vi.fn(),
  searchBubbles: vi.fn(),
  updateBubble: vi.fn(),
  rowToBubble: (row: any) => ({
    id: row.id,
    type: row.type,
    title: row.title ?? '',
    content: row.content ?? '',
    metadata: JSON.parse(row.metadata || '{}'),
    tags: JSON.parse(row.tags || '[]'),
    embedding: undefined,
    source: row.source,
    confidence: row.confidence,
    decayRate: row.decay_rate,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    spaceId: row.space_id ?? undefined,
    abstractionLevel: row.abstraction_level ?? 0,
    summary: row.summary ?? undefined,
  }),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: vi.fn(),
}))

vi.mock('../src/bubble/entity-extractor.js', () => ({
  indexBubbleEntities: vi.fn(),
}))

vi.mock('../src/memory/focus-tracker.js', () => ({
  FocusTracker: vi.fn().mockImplementation(function () {
    return {
      record: vi.fn(),
      computeFocusBoost: vi.fn(),
      getTopTerms: vi.fn().mockReturnValue([]),
      getWindowSize: vi.fn().mockReturnValue(0),
      getActiveUserIds: vi.fn().mockReturnValue([]),
      loadFromDatabase: vi.fn(),
      persistToDatabase: vi.fn(),
    }
  }),
  tokenize: (text: string) => new Set(
    text.split(/[\s,，。？！、；：""''（）()\[\]{}·\-—]+/).filter((t: string) => t.length >= 2),
  ),
}))

vi.mock('../src/shared/tokens.js', () => ({
  estimateTokens: vi.fn(),
  truncateToTokenBudget: vi.fn(),
  TOKEN_LIMITS: { MEMORY_BUDGET: 2000, SINGLE_BUBBLE_MAX: 1000 },
}))

// Now import mocked modules
import { MemoryExtractor } from '../src/memory/extractor.js'
import { BubbleAggregator } from '../src/bubble/aggregator.js'
import { ContradictionResolver } from '../src/memory/contradiction-resolver.js'
import { createBubble, searchBubbles, updateBubble, getAllMemoryBubbles } from '../src/bubble/model.js'
import { addLink } from '../src/bubble/links.js'
import { indexBubbleEntities } from '../src/bubble/entity-extractor.js'
import { estimateTokens, truncateToTokenBudget } from '../src/shared/tokens.js'

const dummyLLM: LLMProvider = { chat: vi.fn(), chatStream: vi.fn() }

let tmpDir: string
let spaceId: string

function makeBubble(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id, type: 'memory' as const, title: '', content: '',
    metadata: {}, tags: [], embedding: undefined, source: 'dialogue',
    confidence: 0.8, decayRate: 0.1, pinned: false,
    createdAt: 1000, updatedAt: 1000, accessedAt: 1000,
    spaceId, abstractionLevel: 0, summary: null,
    ...overrides,
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-mgr-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

beforeEach(() => {
  vi.clearAllMocks()
  const db = getDatabase()
  db.prepare('DELETE FROM bubbles').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

function insertBubble(overrides: Record<string, unknown> = {}): string {
  const db = getDatabase()
  const id = (overrides.id as string) || `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  db.prepare(`INSERT INTO bubbles
    (id, type, title, content, metadata, tags, source, confidence, decay_rate,
     pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, 0.1, 0, ?, ?, ?, ?, ?)`)
    .run(
      id,
      overrides.type as string || 'memory',
      overrides.title as string || '测试',
      overrides.content as string || '测试内容',
      JSON.stringify((overrides.tags as string[]) || []),
      overrides.source as string || 'dialogue',
      overrides.confidence ?? 0.8,
      now, now, now,
      overrides.space_id as string || spaceId,
      overrides.abstraction_level ?? 0,
    )
  return id
}

// Helper: get the mock instance created by a mocked constructor
function getMockInstance<T>(ctor: { mock: { results: Array<{ value: T }> } }): T | undefined {
  return ctor.mock.results[0]?.value
}

// ── calcSurprise ──────────────────────────────────────────────────

describe('calcSurprise', () => {
  it('空 existing 返回 score=0.8 且 contradicts=false', () => {
    const r = calcSurprise('新信息内容', [])
    expect(r.score).toBe(0.8)
    expect(r.contradicts).toBe(false)
    expect(r.nearDuplicate).toBeNull()
  })

  it('高重叠度返回 nearDuplicate 且 score=0.1', () => {
    const existing = [makeBubble('e1', { content: '这是一条测试记忆内容用于验证' })]
    const r = calcSurprise('这是一条测试记忆内容用于验证', existing)
    expect(r.score).toBe(0.1)
    expect(r.nearDuplicate).not.toBeNull()
  })

  it('相同文本不同数字检测为 contradicts', () => {
    const existing = [makeBubble('e1', {
      content: '库存 500 个 目前 仓库 数量',
      source: 'user' as const,
    })]
    const r = calcSurprise('库存 800 个 目前 仓库 数量', existing)
    expect(r.contradicts).toBe(true)
    expect(r.score).toBe(1.0)
  })

  it('中等重叠返回 score=0.4', () => {
    const existing = [makeBubble('e1', {
      content: '天气 很好 适合 出门 运动 学习 休息',
      source: 'user' as const,
    })]
    const r = calcSurprise('天气 很好 适合 在家 学习 休息', existing)
    expect(r.score).toBe(0.4)
  })

  it('完全不同内容返回 score=0.8', () => {
    const existing = [makeBubble('e1', { content: '财务数据汇总报告', source: 'user' as const })]
    const r = calcSurprise('今天小明去上学生物课很有趣', existing)
    expect(r.score).toBe(0.8)
    expect(r.nearDuplicate).toBeNull()
  })
})

// ── getKnowledgeStats ─────────────────────────────────────────────

describe('getKnowledgeStats', () => {
  it('空 DB 返回全零统计', () => {
    const mgr = new MemoryManager(dummyLLM)
    expect(mgr.getKnowledgeStats()).toMatchObject({ total: 0, byType: {}, bySource: {} })
  })

  it('返回正确的分布统计', () => {
    insertBubble({ id: 'b1', type: 'memory', source: 'dialogue' })
    insertBubble({ id: 'b2', type: 'observation', source: 'user', abstraction_level: 1 })
    insertBubble({ id: 'b3', type: 'memory', source: 'dialogue' })

    const mgr = new MemoryManager(dummyLLM)
    const stats = mgr.getKnowledgeStats()
    expect(stats.total).toBe(3)
    expect(stats.byType).toEqual({ memory: 2, observation: 1 })
    expect(stats.bySource).toEqual({ dialogue: 2, user: 1 })
  })
})

// ── getKnowledgeIndex ─────────────────────────────────────────────

describe('getKnowledgeIndex', () => {
  it('分页返回正确', () => {
    for (let i = 0; i < 5; i++) insertBubble({ id: `b${i}`, title: `知识${i}` })

    const mgr = new MemoryManager(dummyLLM)
    const page1 = mgr.getKnowledgeIndex(undefined, undefined, 1, 2)
    expect(page1.items).toHaveLength(2)
    expect(page1.total).toBe(5)
    expect(page1.page).toBe(1)
  })

  it('按 type 过滤', () => {
    insertBubble({ id: 'b1', type: 'memory' })
    insertBubble({ id: 'b2', type: 'observation' })

    const mgr = new MemoryManager(dummyLLM)
    const result = mgr.getKnowledgeIndex(undefined, { types: ['memory'] })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('b1')
  })
})

// ── extractAndStore ───────────────────────────────────────────────

describe('extractAndStore', () => {
  function makeMgr() {
    return new MemoryManager(dummyLLM)
  }

  it('提取并存储记忆，创建 same_turn 链接', async () => {
    searchBubbles.mockReturnValue([])
    createBubble
      .mockReturnValueOnce({ id: 'b1' })
      .mockReturnValueOnce({ id: 'b2' })

    const mgr = new MemoryManager(dummyLLM)
    // Set mocks AFTER constructor so mock.results[0] exists
    vi.mocked(MemoryExtractor).mock.results[0].value.extract = vi.fn().mockResolvedValue([
      { title: '记忆A', content: '内容A', tags: ['tag1'], confidence: 0.8, decayRate: 0.1, sourceType: 'observation' as const },
      { title: '记忆B', content: '内容B', tags: ['tag2'], confidence: 0.7, decayRate: 0.1, sourceType: 'observation' as const },
    ])
    vi.mocked(ContradictionResolver).mock.results[0].value.detect = vi.fn().mockReturnValue({
      contradicts: false, type: 'none' as const, confidence: 0, details: '', oldBubble: undefined,
    })

    await mgr.extractAndStore('用户消息', '助手回复', spaceId)

    expect(createBubble).toHaveBeenCalledTimes(2)
    expect(addLink).toHaveBeenCalledWith('b1', 'b2', 'same_turn', 0.8, 'system')
    expect(indexBubbleEntities).toHaveBeenCalledTimes(2)
  })

  it('重复内容跳过存储', async () => {
    searchBubbles.mockReturnValue([
      { id: 'existing', type: 'memory', content: '相同内容' },
    ])

    const mgr = new MemoryManager(dummyLLM)
    vi.mocked(MemoryExtractor).mock.results[0].value.extract = vi.fn().mockResolvedValue([
      { title: '重复', content: '相同内容', tags: [], confidence: 0.8, decayRate: 0.1, sourceType: 'observation' as const },
    ])

    await mgr.extractAndStore('用户消息', '助手回复')
    expect(createBubble).not.toHaveBeenCalled()
  })
})

// ── getContextForQuery ─────────────────────────────────────────────

describe('getContextForQuery', () => {
  it('无 summaryHits 返回空 context', async () => {
    const mgr = new MemoryManager(dummyLLM)
    getMockInstance(BubbleAggregator)!.aggregateSummaries = vi.fn().mockResolvedValue([])

    const result = await mgr.getContextForQuery('查询', [spaceId])
    expect(result.context).toBe('')
    expect(result.sources).toHaveLength(0)
  })

  it('组装 context 包含来源', async () => {
    estimateTokens.mockReturnValue(50)
    truncateToTokenBudget.mockImplementation((s: string) => s)

    const mgr = new MemoryManager(dummyLLM)
    getMockInstance(BubbleAggregator)!.aggregateSummaries = vi.fn().mockResolvedValue([
      { id: 'b1', title: '记忆1', content: '记忆内容1', type: 'memory', tags: [], source: 'dialogue' },
    ])
    getMockInstance(BubbleAggregator)!.loadFullBubbles = vi.fn().mockReturnValue([
      makeBubble('b1', { title: '记忆1', content: '记忆内容1' }),
    ])

    const result = await mgr.getContextForQuery('查询', [spaceId])
    expect(result.context).toContain('记忆内容1')
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].title).toBe('记忆1')
  })
})

// ── search / delegation ───────────────────────────────────────────

describe('search / delegation', () => {
  it('search 使用 aggregator', async () => {
    const mgr = new MemoryManager(dummyLLM)
    getMockInstance(BubbleAggregator)!.aggregate = vi.fn().mockResolvedValue([
      makeBubble('b1', { title: '搜索结果' }),
    ])

    const results = await mgr.search('查询', 10, [spaceId])
    expect(results).toHaveLength(1)
  })

  it('listMemories 委托到 getAllMemoryBubbles', () => {
    getAllMemoryBubbles.mockReturnValue([makeBubble('b1')])
    const mgr = new MemoryManager(dummyLLM)
    const result = mgr.listMemories([spaceId])
    expect(getAllMemoryBubbles).toHaveBeenCalledWith([spaceId])
    expect(result).toHaveLength(1)
  })
})
