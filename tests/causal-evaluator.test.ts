import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CausalEvaluator } from '../src/memory/causal-evaluator.js'
import type { LLMProvider, Bubble } from '../src/shared/types.js'

// Mock model.js — keep rowToBubble real, mock searchBubbles and updateBubble
vi.mock('../src/bubble/model.js', async (importOriginal) => {
  const mod = await importOriginal()
  return {
    ...mod,
    searchBubbles: vi.fn(),
    updateBubble: vi.fn(),
  }
})

vi.mock('../src/bubble/links.js', () => ({
  addLink: vi.fn(),
}))

import { searchBubbles, updateBubble } from '../src/bubble/model.js'
import { addLink } from '../src/bubble/links.js'

let tmpDir: string
let spaceId: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-ce-'))
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
  const id = overrides.id as string || `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  db.prepare(`INSERT INTO bubbles
    (id, type, title, content, metadata, tags, source, confidence, decay_rate,
     pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'observation', ?, ?, '{}', '[]', ?, 0.8, 0.1, 0, ?, ?, ?, ?, 0)`)
    .run(
      id,
      overrides.title as string || '测试',
      overrides.content as string || '测试内容',
      overrides.source as string || 'user',
      now, now, now,
      overrides.space_id as string || spaceId,
    )
  return id
}

function makeBubble(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id,
    type: 'observation',
    title: '已有知识',
    content: '这是已有的相关观察内容',
    metadata: {},
    tags: [],
    embedding: undefined,
    source: 'user',
    confidence: 0.8,
    decayRate: 0.1,
    pinned: false,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
    accessedAt: Date.now() - 86400000,
    spaceId,
    abstractionLevel: 1,
    summary: null,
    ...overrides,
  }
}

function makeMockLLM(response: string): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ content: response }),
    chatStream: vi.fn(),
  }
}

function makeSequentialLLM(...responses: string[]): LLMProvider {
  const mock = vi.fn()
  responses.forEach(r => mock.mockResolvedValueOnce({ content: r }))
  return {
    chat: mock,
    chatStream: vi.fn(),
  }
}

// ── evaluate — 跳过条件 ──────────────────────────────────────────

describe('evaluate — 跳过条件', () => {
  it('无未评估 bubble 时返回全零', async () => {
    const evaluator = new CausalEvaluator(makeMockLLM('{}'))
    const result = await evaluator.evaluate()

    expect(result).toEqual({ evaluated: 0, reinforces: 0, contradicts: 0, extends: 0, neutral: 0 })
    expect(updateBubble).not.toHaveBeenCalled()
  })
})

// ── evaluate — 无相关知识 ─────────────────────────────────────────

describe('evaluate — 无相关知识', () => {
  it('无相关高层知识时返回 neutral', async () => {
    insertBubble({ id: 'b1', title: '新信息', content: '新信息内容' })
    searchBubbles.mockReturnValue([])

    const evaluator = new CausalEvaluator(makeMockLLM('{}'))
    const result = await evaluator.evaluate()

    expect(result.evaluated).toBe(1)
    expect(result.neutral).toBe(1)
    expect(updateBubble).toHaveBeenCalledWith('b1', expect.objectContaining({
      metadata: expect.objectContaining({
        causalEvaluated: true,
        causalImpact: 'neutral',
      }),
    }))
    expect(addLink).not.toHaveBeenCalled()
  })
})

// ── evaluate — 因果影响 ───────────────────────────────────────────

describe('evaluate — 因果影响', () => {
  beforeEach(() => {
    // Seed unevaluated bubble in DB
    insertBubble({ id: 'b1', title: '新数据', content: '新数据显示增长趋势明显' })
    // Mock related knowledge for evaluateSingle
    searchBubbles.mockReturnValue([
      makeBubble('related-1', { title: '旧报告', content: '旧报告显示平稳' }),
    ])
  })

  it('reinforces 创建 supports 链接', async () => {
    const evaluator = new CausalEvaluator(makeMockLLM(
      JSON.stringify({ impact: 'reinforces', affectedIds: ['related-1'], confidence: 0.85, reason: '支持' }),
    ))
    const result = await evaluator.evaluate()

    expect(result.reinforces).toBe(1)
    expect(addLink).toHaveBeenCalledWith('b1', 'related-1', 'supports', 0.85, 'causal-evaluator')
  })

  it('contradicts 降低目标置信度', async () => {
    // searchBubbles needs two returns:
    // 1. evaluateSingle: related bubbles with confidence 0.8
    // 2. confidence reduction: target bubble itself
    searchBubbles
      .mockReturnValueOnce([makeBubble('related-1', { confidence: 0.8 })])
      .mockReturnValueOnce([makeBubble('related-1', { confidence: 0.8 })])

    const evaluator = new CausalEvaluator(makeSequentialLLM(
      JSON.stringify({ impact: 'contradicts', affectedIds: ['related-1'], confidence: 0.8, reason: '冲突' }),
      JSON.stringify({ patch: '修正说明', shouldRewrite: false }),
    ))
    const result = await evaluator.evaluate()

    expect(result.contradicts).toBe(1)
    expect(addLink).toHaveBeenCalledWith('b1', 'related-1', 'contradicts', 0.8, 'causal-evaluator')
    // Find the confidence reduction call among the multiple updateBubble calls
    const confidenceCall = updateBubble.mock.calls.find(
      (c: unknown[]) => c[0] === 'related-1' && typeof c[1] === 'object' && c[1] !== null && 'confidence' in c[1],
    )
    expect(confidenceCall).toBeDefined()
    expect((confidenceCall[1] as Record<string, unknown>).confidence).toBeCloseTo(0.64, 2)
  })

  it('extends 创建 extends 链接并内化', async () => {
    searchBubbles
      .mockReturnValueOnce([makeBubble('related-1')])
      .mockReturnValueOnce([makeBubble('related-1', { content: '旧内容' })])

    const evaluator = new CausalEvaluator(makeSequentialLLM(
      JSON.stringify({ impact: 'extends', affectedIds: ['related-1'], confidence: 0.8, reason: '补充' }),
      JSON.stringify({ patch: '补充说明内容', shouldRewrite: false }),
    ))
    await evaluator.evaluate()

    expect(addLink).toHaveBeenCalledWith('b1', 'related-1', 'extends', 0.8, 'causal-evaluator')
    // internalize updated the bubble content with evolution marker
    const contentCall = updateBubble.mock.calls.find(
      (c: unknown[]) => c[0] === 'related-1' && typeof c[1] === 'object' && c[1] !== null && 'content' in c[1],
    )
    expect(contentCall).toBeDefined()
    expect(contentCall[1].content).toContain('补充说明内容')
  })

  it('neutral 不创建链接', async () => {
    const evaluator = new CausalEvaluator(makeMockLLM(
      JSON.stringify({ impact: 'neutral', affectedIds: [], confidence: 0.5, reason: '无关' }),
    ))
    const result = await evaluator.evaluate()

    expect(result.neutral).toBe(1)
    expect(addLink).not.toHaveBeenCalled()
  })
})

// ── evaluate — 边界 ──────────────────────────────────────────────

describe('evaluate — 边界', () => {
  it('超过 MAX_EVAL_PER_RUN(10) 时只处理 10 个', async () => {
    for (let i = 0; i < 13; i++) {
      insertBubble({ id: `b${i}`, title: `信息${i}`, content: `内容${i}` })
    }
    searchBubbles.mockReturnValue([]) // no related knowledge → neutral

    const evaluator = new CausalEvaluator(makeMockLLM('{}'))
    const result = await evaluator.evaluate()

    expect(result.evaluated).toBe(10)
    expect(result.neutral).toBe(10)
  })
})
