import { describe, it, expect, vi } from 'vitest'
import { ContextBudget } from '../src/memory/context-budget.js'
import type { WorkingMemory } from '../src/memory/working-memory.js'
import type { Bubble } from '../src/shared/types.js'

// Constants from context-budget.ts (replicated for test assertions)
const SYSTEM_PROMPT_RESERVE = 1500
const HISTORY_RESERVE = 2000
const TOOL_RESULT_RESERVE = 1000
const TOTAL_RESERVED = SYSTEM_PROMPT_RESERVE + HISTORY_RESERVE + TOOL_RESULT_RESERVE // 4500

function mockWM(status?: Partial<ReturnType<WorkingMemory['getStatus']>>): WorkingMemory {
  return {
    getStatus: vi.fn().mockReturnValue({
      hotCount: 5,
      hotTokens: 2000,
      warmCount: 10,
      coldCount: 20,
      budgetTotal: 8000,
      budgetUsed: 2000,
      ...status,
    }),
  } as unknown as WorkingMemory
}

// ── getReport ──────────────────────────────────────────────────────

describe('getReport', () => {
  it('计算正确的预算分解和利用率', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm, 8000)
    const report = budget.getReport('s1')

    expect(report.totalBudget).toBe(8000)
    expect(report.availableForMemory).toBe(8000 - TOTAL_RESERVED) // 3500
    expect(report.currentUsage).toBe(2000)
    expect(report.remainingCapacity).toBe(3500 - 2000) // 1500
    expect(report.utilizationPercent).toBe(Math.round(2000 / 3500 * 100)) // 57
    expect(report.hotItemCount).toBe(5)
    expect(report.canLoadMore).toBe(true) // 1500 > 200
  })

  it('低使用量时 utilizationPercent 为 0', () => {
    const wm = mockWM({ hotTokens: 0, hotCount: 0 })
    const budget = new ContextBudget(wm)
    const report = budget.getReport('s1')

    expect(report.currentUsage).toBe(0)
    expect(report.utilizationPercent).toBe(0)
    expect(report.canLoadMore).toBe(true)
  })

  it('高使用量时 canLoadMore 为 false', () => {
    const wm = mockWM({ hotTokens: 3400 }) // 剩余 = 3500 - 3400 = 100 <= 200
    const budget = new ContextBudget(wm)
    const report = budget.getReport('s1')

    expect(report.remainingCapacity).toBe(100)
    expect(report.canLoadMore).toBe(false)
  })

  it('超过可用容量时 remainingCapacity 为 0', () => {
    const wm = mockWM({ hotTokens: 4000 }) // 超过 3500
    const budget = new ContextBudget(wm)
    const report = budget.getReport('s1')

    expect(report.remainingCapacity).toBe(0)
    expect(report.canLoadMore).toBe(false)
  })
})

// ── canLoad ────────────────────────────────────────────────────────

describe('canLoad', () => {
  it('bubble 在剩余容量内可加载', () => {
    const wm = mockWM({ hotTokens: 500 }) // 剩余 = 3000
    const budget = new ContextBudget(wm)

    const bubble = { content: '短文本' } as Bubble
    expect(budget.canLoad('s1', bubble)).toBe(true)
  })

  it('bubble 超出剩余容量不可加载', () => {
    const wm = mockWM({ hotTokens: 3490 }) // 剩余 = 10
    const budget = new ContextBudget(wm)

    // Use CJK text: each CJK char ≈ 1.5 tokens, 10 chars = 15 tokens > 10 remaining
    const bubble = { content: '这是一段超过剩余容量的中文文本用于测试' } as Bubble
    expect(budget.canLoad('s1', bubble)).toBe(false)
  })

  it('利用 summary 参与 token 估算', () => {
    const wm = mockWM({ hotTokens: 3498 }) // 剩余 = 2
    const budget = new ContextBudget(wm)

    // content 本身很小但 summary 很大 → 仍超过容量
    const bubble = { content: '小', summary: '这是一段非常长的中文摘要文本用于测试预算限制的边界条件' } as Bubble
    expect(budget.canLoad('s1', bubble)).toBe(false)
  })
})

// ── estimateRemainingSlots ─────────────────────────────────────────

describe('estimateRemainingSlots', () => {
  it('按平均 token 数估算剩余槽位', () => {
    const wm = mockWM({ hotTokens: 500 }) // 剩余 = 3000
    const budget = new ContextBudget(wm)

    expect(budget.estimateRemainingSlots('s1', 300)).toBe(10) // 3000/300
    expect(budget.estimateRemainingSlots('s1', 500)).toBe(6)  // 3000/500
    expect(budget.estimateRemainingSlots('s1', 1000)).toBe(3) // 3000/1000
  })

  it('无剩余容量时返回 0', () => {
    const wm = mockWM({ hotTokens: 3500 }) // 剩余 = 0
    const budget = new ContextBudget(wm)

    expect(budget.estimateRemainingSlots('s1')).toBe(0)
  })
})

// ── formatForSystemPrompt ──────────────────────────────────────────

describe('formatForSystemPrompt', () => {
  it('包含 Working Memory 状态和 top items', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm)

    const result = budget.formatForSystemPrompt('s1', [
      { title: '需求文档', relevance: 0.95, pinned: false },
      { title: '架构图', relevance: 0.85, pinned: true },
    ])

    expect(result).toContain('[Working Memory Status]')
    expect(result).toContain('5 items')
    expect(result).toContain('2000/3500 tokens')
    expect(result).toContain('需求文档')
    expect(result).toContain('relevance: 0.95')
    expect(result).toContain('架构图')
    expect(result).toContain('pinned')
  })

  it('超过 5 个时截断并显示剩余数量', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm)

    const items = Array.from({ length: 7 }, (_, i) => ({
      title: `item-${i + 1}`,
      relevance: 1.0 - i * 0.1,
      pinned: false,
    }))

    const result = budget.formatForSystemPrompt('s1', items)

    expect(result).toContain('item-1')   // rank 1
    expect(result).toContain('item-5')   // rank 5
    expect(result).toContain('... and 2 more') // 7-5=2
    expect(result).not.toContain('item-6') // truncated
    expect(result).not.toContain('item-7') // truncated
  })

  it('空列表时不显示 ... and', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm)

    const result = budget.formatForSystemPrompt('s1', [])
    expect(result).toContain('[Working Memory Status]')
    expect(result).not.toContain('... and')
  })
})

// ── formatForSystemPrompt ──────────────────────────────────────────

describe('自定义 totalBudget', () => {
  it('较小 budget 时 availableForMemory 相应减少', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm, 6000)
    const report = budget.getReport('s1')

    expect(report.totalBudget).toBe(6000)
    expect(report.availableForMemory).toBe(6000 - TOTAL_RESERVED) // 1500
  })

  it('budget 低于预留总值时 availableForMemory 为负', () => {
    const wm = mockWM()
    const budget = new ContextBudget(wm, 3000)
    const report = budget.getReport('s1')

    expect(report.availableForMemory).toBeLessThan(0)
  })
})
