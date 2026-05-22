import { describe, it, expect, vi } from 'vitest'
import { applyViewFilter, buildViewWhereClause, viewAllowsType, isAdminView } from '../src/memory/view-projector.js'
import type { Bubble, MemoryView } from '../src/shared/types.js'

function makeBubble(overrides: Partial<Bubble> = {}): Bubble {
  return {
    id: 'b1',
    type: 'observation',
    title: '测试',
    content: '内容',
    metadata: {},
    tags: ['tag-a'],
    embedding: undefined,
    source: 'user',
    confidence: 0.9,
    decayRate: 0.1,
    pinned: false,
    createdAt: 1000,
    updatedAt: 1000,
    accessedAt: 1000,
    spaceId: 's1',
    abstractionLevel: 2,
    summary: null,
    ...overrides,
  }
}

function makeView(overrides: Partial<MemoryView> = {}): MemoryView {
  return {
    id: 'v1',
    name: '测试视图',
    rolePattern: 'supplier',
    filters: {
      allowedTypes: '*',
      maxAbstractionLevel: 10,
      tagFilter: [],
      counterpartyFilter: undefined,
      timeWindow: undefined,
    },
    priority: 10,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

// ── applyViewFilter — 类型过滤 ────────────────────────────────────

describe('applyViewFilter — 类型过滤', () => {
  it('allowedTypes=* 时不过滤', () => {
    const view = makeView({ filters: { allowedTypes: '*', maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined } })
    const bubbles = [makeBubble({ type: 'observation' }), makeBubble({ type: 'concept' })]
    expect(applyViewFilter(bubbles, { view })).toHaveLength(2)
  })

  it('只保留 allowedTypes 中的类型', () => {
    const view = makeView({ filters: { allowedTypes: ['observation'], maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined } })
    const bubbles = [makeBubble({ type: 'observation' }), makeBubble({ type: 'concept' })]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('observation')
  })
})

// ── applyViewFilter — 抽象层级 ────────────────────────────────────

describe('applyViewFilter — 抽象层级', () => {
  it('过滤超过 maxAbstractionLevel 的 bubble', () => {
    const view = makeView({ filters: { allowedTypes: '*', maxAbstractionLevel: 2, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined } })
    const bubbles = [makeBubble({ abstractionLevel: 1 }), makeBubble({ abstractionLevel: 5 })]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].abstractionLevel).toBe(1)
  })
})

// ── applyViewFilter — 时间有效性 ──────────────────────────────────

describe('applyViewFilter — 时间有效性', () => {
  it('asOfTimestamp 过滤 validFrom/validUntil', () => {
    const view = makeView()
    const now = 1000
    const bubbles = [
      // validFrom > asOf → excluded
      { ...makeBubble({ id: 'excluded-early' }), validFrom: 1100, validUntil: undefined } as Bubble,
      // validUntil < asOf → excluded
      { ...makeBubble({ id: 'excluded-late' }), validFrom: undefined, validUntil: 800 } as Bubble,
      // both within range → kept
      { ...makeBubble({ id: 'kept' }), validFrom: 500, validUntil: 2000 } as Bubble,
      // no temporal bounds → kept
      makeBubble({ id: 'no-bounds' }),
    ]
    const result = applyViewFilter(bubbles, { view, asOfTimestamp: now })
    expect(result).toHaveLength(2)
    expect(result.map(b => b.id).sort()).toEqual(['kept', 'no-bounds'])
  })

  it('无 asOfTimestamp 时默认排除有 validUntil 的 bubble', () => {
    const view = makeView()
    const bubbles = [
      makeBubble({ id: 'active' }),
      { ...makeBubble({ id: 'expired' }), validUntil: 800 } as Bubble,
    ]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('active')
  })
})

// ── applyViewFilter — 时间窗口 ────────────────────────────────────

describe('applyViewFilter — 时间窗口', () => {
  it('since 过滤早于时间点的 bubble', () => {
    const view = makeView({
      filters: {
        allowedTypes: '*',
        maxAbstractionLevel: 10,
        tagFilter: [],
        counterpartyFilter: undefined,
        timeWindow: { since: 800 },
      },
    })
    const bubbles = [
      makeBubble({ createdAt: 500 }),
      makeBubble({ createdAt: 1000 }),
    ]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].createdAt).toBe(1000)
  })

  it('until 过滤晚于时间点的 bubble', () => {
    const view = makeView({
      filters: {
        allowedTypes: '*',
        maxAbstractionLevel: 10,
        tagFilter: [],
        counterpartyFilter: undefined,
        timeWindow: { until: 800 },
      },
    })
    const bubbles = [
      makeBubble({ createdAt: 500 }),
      makeBubble({ createdAt: 1000 }),
    ]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].createdAt).toBe(500)
  })
})

// ── applyViewFilter — 标签过滤 ────────────────────────────────────

describe('applyViewFilter — 标签过滤', () => {
  it('要求至少有一个匹配标签', () => {
    const view = makeView({
      filters: {
        allowedTypes: '*',
        maxAbstractionLevel: 10,
        tagFilter: ['tag-a', 'tag-b'],
        counterpartyFilter: undefined,
        timeWindow: undefined,
      },
    })
    const bubbles = [
      makeBubble({ tags: ['tag-a'] }),
      makeBubble({ tags: ['other'] }),
    ]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].tags).toContain('tag-a')
  })

  it('空 tagFilter 不过滤', () => {
    const view = makeView()
    const bubbles = [
      makeBubble({ tags: ['anything'] }),
    ]
    expect(applyViewFilter(bubbles, { view })).toHaveLength(1)
  })
})

// ── applyViewFilter — 组合过滤 ────────────────────────────────────

describe('applyViewFilter — 组合过滤', () => {
  it('多个过滤器同时生效', () => {
    const view = makeView({
      filters: {
        allowedTypes: ['concept'],
        maxAbstractionLevel: 3,
        tagFilter: ['tag-a'],
        timeWindow: { since: 500 },
        counterpartyFilter: undefined,
      },
    })
    const bubbles = [
      makeBubble({ type: 'concept', abstractionLevel: 2, tags: ['tag-a'], createdAt: 1000 }), // all pass
      makeBubble({ type: 'observation', abstractionLevel: 2, tags: ['tag-a'], createdAt: 1000 }), // wrong type
      makeBubble({ type: 'concept', abstractionLevel: 5, tags: ['tag-a'], createdAt: 1000 }), // high abstraction
      makeBubble({ type: 'concept', abstractionLevel: 2, tags: ['other'], createdAt: 1000 }), // wrong tag
      makeBubble({ type: 'concept', abstractionLevel: 2, tags: ['tag-a'], createdAt: 100 }), // before since
    ]
    const result = applyViewFilter(bubbles, { view })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b1') // only the first passes all filters
  })
})

// ── buildViewWhereClause ──────────────────────────────────────────

describe('buildViewWhereClause', () => {
  it('allowedTypes=* 不生成 type 条件', () => {
    const filters = { allowedTypes: '*', maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined }
    const { conditions, params } = buildViewWhereClause(filters)
    expect(conditions.every(c => !c.includes('type'))).toBe(true)
    expect(conditions).toContain('valid_until IS NULL')
    expect(conditions).toContain('abstraction_level <= ?')
  })

  it('allowedTypes 生成 IN 条件', () => {
    const filters = { allowedTypes: ['observation', 'concept'], maxAbstractionLevel: 5, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined }
    const { conditions, params } = buildViewWhereClause(filters)
    expect(conditions.some(c => c.includes('type IN'))).toBe(true)
    expect(params).toContain('observation')
    expect(params).toContain('concept')
  })

  it('timeWindow 生成 created_at 条件', () => {
    const filters = { allowedTypes: '*', maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: { since: 100, until: 200 } }
    const { conditions, params } = buildViewWhereClause(filters)
    expect(conditions.some(c => c.includes('created_at >='))).toBe(true)
    expect(conditions.some(c => c.includes('created_at <='))).toBe(true)
    expect(params).toContain(100)
    expect(params).toContain(200)
  })
})

// ── viewAllowsType / isAdminView ──────────────────────────────────

describe('viewAllowsType', () => {
  it('* 允许所有类型', () => {
    expect(viewAllowsType(makeView(), 'observation')).toBe(true)
    expect(viewAllowsType(makeView(), 'concept')).toBe(true)
  })

  it('特定列表只允许匹配类型', () => {
    const view = makeView({ filters: { allowedTypes: ['observation'], maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined } })
    expect(viewAllowsType(view, 'observation')).toBe(true)
    expect(viewAllowsType(view, 'concept')).toBe(false)
  })
})

describe('isAdminView', () => {
  it('rolePattern=admin 视为 admin', () => {
    expect(isAdminView(makeView({ rolePattern: 'admin' }))).toBe(true)
  })

  it('allowedTypes=* 视为 admin', () => {
    expect(isAdminView(makeView())).toBe(true)
  })

  it('普通视图返回 false', () => {
    const view = makeView({
      rolePattern: 'supplier',
      filters: { allowedTypes: ['observation'], maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined },
    })
    expect(isAdminView(view)).toBe(false)
  })
})
