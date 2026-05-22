import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ContradictionResolver } from '../src/memory/contradiction-resolver.js'
import type { Bubble } from '../src/shared/types.js'

const mockUpdateBubble = vi.fn()
const mockAddLink = vi.fn()

vi.mock('../src/bubble/model.js', () => ({
  updateBubble: (...args: unknown[]) => mockUpdateBubble(...args),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: (...args: unknown[]) => mockAddLink(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const resolver = new ContradictionResolver()

function bubble(content: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id: 'b1',
    type: 'observation',
    title: '测试',
    content,
    metadata: {},
    tags: ['observation'],
    embedding: undefined,
    source: 'user',
    confidence: 0.8,
    decayRate: 0.1,
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    accessedAt: 1000,
    spaceId: 's1',
    abstractionLevel: 1,
    summary: null,
    ...overrides,
  }
}

// Comma-separated tokens ensure tokenize() creates multiple overlapping tokens.
// The overlap ratio must exceed thresholds: numeric 0.4, negation 0.35, temporal 0.4.

// ── detect — 跳过条件 ─────────────────────────────────────────────

describe('detect — 跳过条件', () => {
  it('空 existingBubbles 返回 no contradiction', () => {
    const result = resolver.detect('新内容', [])
    expect(result.contradicts).toBe(false)
    expect(result.type).toBe('none')
  })

  it('低重叠度返回 no contradiction', () => {
    const existing = [bubble('话题A，信息X，记录Y，内容Z')]
    const result = resolver.detect('话题B，数据M，结果N，结论P', existing)
    expect(result.contradicts).toBe(false)
  })
})

// ── detect — 数值矛盾 ────────────────────────────────────────────

describe('detect — 数值矛盾', () => {
  it('相同上下文不同数字检测为 numeric', () => {
    // Avoid field-name keywords (价格/金额/数量/状态 etc.) that trigger state_change
    const existing = [bubble('记录，库存 500，预算 100，确认，审核')]
    const result = resolver.detect('记录，库存 550，预算 120，确认，审核', existing)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('numeric')
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.details).toContain('数值变化')
  })

  it('相同数字不触发矛盾', () => {
    const existing = [bubble('记录，库存 500，预算 100，确认，审核')]
    const result = resolver.detect('记录，库存 500，预算 100，确认，审核', existing)
    expect(result.contradicts).toBe(false)
  })
})

// ── detect — 否定模式 ────────────────────────────────────────────

describe('detect — 否定模式', () => {
  it('是 vs 不是 检测为 negation', () => {
    // overlap: tokens [确认, 审核, 完成] in common, 0.75 ratio > 0.35
    const existing = [bubble('确认，是，审核，完成，通过')]
    const result = resolver.detect('确认，不是，审核，完成，通过', existing)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('negation')
    expect(result.details).toContain('否定模式')
  })

  it('通过 vs 没通过 检测为 negation', () => {
    const existing = [bubble('确认，通过，审核，完成，状态')]
    const result = resolver.detect('确认，没通过，审核，完成，状态', existing)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('negation')
  })
})

// ── detect — 状态变更 ────────────────────────────────────────────

describe('detect — 状态变更', () => {
  it('字段值变化检测为 state_change', () => {
    const existing = [bubble('确认，状态：正常，审核通过，完成')]
    const result = resolver.detect('确认，状态：异常，审核通过，完成', existing)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('state_change')
  })
})

// ── detect — 时间矛盾 ────────────────────────────────────────────

describe('detect — 时间矛盾', () => {
  it('相同上下文不同日期检测为 temporal', () => {
    const common = '，确认，审核，订单，商品，状态，正常，记录'
    const existing = [bubble('日期 2024-01-15' + common)]
    const result = resolver.detect('日期 2024-06-15' + common, existing)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('temporal')
    expect(result.details).toContain('日期变更')
  })
})

// ── detect — 优先级 ──────────────────────────────────────────────

describe('detect — 优先级', () => {
  it('numeric > negation > state_change > temporal 优先级', () => {
    const existing = [bubble('确认，预算 100，通过，审核，记录，核算')]
    const result = resolver.detect('确认，预算 200，不是通过，审核，记录，核算', existing)
    // numeric should win (checked first)
    expect(result.contradicts).toBe(true)
    expect(result.type).toBe('numeric')
  })
})

// ── resolve ──────────────────────────────────────────────────────

describe('resolve', () => {
  it('降低旧 bubble 置信度并添加 superseded 标签', () => {
    const oldBubble = bubble('旧内容', { confidence: 0.9, tags: ['observation', 'contradiction'] })
    resolver.resolve('new-123', oldBubble, 'numeric')

    expect(mockUpdateBubble).toHaveBeenCalledWith('b1', expect.objectContaining({
      confidence: 0.27, // 0.9 * 0.3
      decayRate: 0.3,
      tags: ['observation', 'superseded'], // 'contradiction' removed, 'superseded' added
    }))
  })

  it('创建 superseded_by 链接', () => {
    resolver.resolve('new-456', bubble('旧'), 'negation')
    expect(mockAddLink).toHaveBeenCalledWith('b1', 'new-456', 'superseded_by', 1.0, 'system')
  })
})
