import { describe, it, expect, vi, beforeEach } from 'vitest'
import { detectTeachIntent, type TeachAction } from '../src/connector/teach/detector.js'

// ═══════════════════════════════════════════════════════════
// Part 1: TeachDetector — pure regex, zero mocks
// ═══════════════════════════════════════════════════════════

describe('detectTeachIntent', () => {
  // ── Remember action ─────────────────────────────────────
  it('detects "泡泡记住：" with Chinese colon', () => {
    const r = detectTeachIntent('泡泡记住：桂鑫没有盘螺产品')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
    expect(r.bodyText).toBe('桂鑫没有盘螺产品')
  })

  it('detects "泡泡记住:" with English colon', () => {
    const r = detectTeachIntent('泡泡记住:桂鑫没有盘螺产品')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  it('detects "泡泡记下：" as remember', () => {
    const r = detectTeachIntent('泡泡记下：马台联系人是张三')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  it('detects "泡泡学习：" as remember', () => {
    const r = detectTeachIntent('泡泡学习：汉浦路项目需要特别注意回款')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  it('detects "泡泡知道：" as remember', () => {
    const r = detectTeachIntent('泡泡知道：明天有客户来访需要准备')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  // ── Note action ─────────────────────────────────────────
  it('detects "泡泡注意：" as note', () => {
    const r = detectTeachIntent('泡泡注意：汉浦路项目回款一直拖延')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('note')
    expect(r.bodyText).toBe('汉浦路项目回款一直拖延')
  })

  it('detects "泡泡留意：" as note', () => {
    const r = detectTeachIntent('泡泡留意：最近钢材价格波动很大')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('note')
  })

  it('detects "泡泡小心：" as note', () => {
    const r = detectTeachIntent('泡泡小心：这个客户经常拖延付款')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('note')
  })

  // ── Update action ───────────────────────────────────────
  it('detects "泡泡更新：" as update', () => {
    const r = detectTeachIntent('泡泡更新：马台联系人换成张总了')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('update')
    expect(r.bodyText).toBe('马台联系人换成张总了')
  })

  it('detects "泡泡修改：" as update', () => {
    const r = detectTeachIntent('泡泡修改：桂鑫的电话变更为13800138000')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('update')
  })

  it('detects "泡泡改一下：" as update', () => {
    const r = detectTeachIntent('泡泡改一下：上次说的价格不对应该是4500')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('update')
  })

  it('detects "泡泡纠正：" as update', () => {
    const r = detectTeachIntent('泡泡纠正：桂鑫其实有盘螺产品了')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('update')
  })

  // ── Forget action ───────────────────────────────────────
  it('detects "泡泡忘记：" as forget', () => {
    const r = detectTeachIntent('泡泡忘记：桂鑫没有盘螺这个事')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
    expect(r.bodyText).toBe('桂鑫没有盘螺这个事')
  })

  it('detects "泡泡忘掉：" as forget', () => {
    const r = detectTeachIntent('泡泡忘掉：之前记录的错误信息')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
  })

  it('detects "泡泡删除：" as forget', () => {
    const r = detectTeachIntent('泡泡删除：关于马台的旧联系人信息')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
  })

  it('detects "泡泡取消：" as forget', () => {
    const r = detectTeachIntent('泡泡取消：上次教你的错误规则')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
  })

  it('detects "泡泡别记：" as forget', () => {
    const r = detectTeachIntent('泡泡别记：那个客户的临时电话')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('forget')
  })

  // ── Whitespace tolerance ────────────────────────────────
  it('handles spaces between 泡泡 and verb', () => {
    const r = detectTeachIntent('泡泡 记住：桂鑫没有盘螺产品')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  it('handles spaces between verb and colon', () => {
    const r = detectTeachIntent('泡泡记住 ：桂鑫没有盘螺产品')
    expect(r.detected).toBe(true)
    expect(r.action).toBe('remember')
  })

  it('handles leading/trailing whitespace', () => {
    const r = detectTeachIntent('  泡泡记住：桂鑫没有盘螺产品  ')
    expect(r.detected).toBe(true)
    expect(r.bodyText).toBe('桂鑫没有盘螺产品')
  })

  // ── Rejection cases ─────────────────────────────────────
  it('rejects empty string', () => {
    expect(detectTeachIntent('').detected).toBe(false)
  })

  it('rejects text too short (< 6 chars)', () => {
    expect(detectTeachIntent('泡泡记').detected).toBe(false)
  })

  it('rejects text too long (> 500 chars)', () => {
    const long = '泡泡记住：' + '测'.repeat(500)
    expect(detectTeachIntent(long).detected).toBe(false)
  })

  it('rejects text without 泡泡', () => {
    expect(detectTeachIntent('记住：桂鑫没有盘螺产品').detected).toBe(false)
  })

  it('rejects text with 泡泡 but no action verb', () => {
    expect(detectTeachIntent('泡泡你好啊今天天气怎么样').detected).toBe(false)
  })

  it('rejects text with 泡泡 and verb but no colon', () => {
    expect(detectTeachIntent('泡泡记住桂鑫没有盘螺产品').detected).toBe(false)
  })

  it('rejects when body text is too short (< 4 chars)', () => {
    expect(detectTeachIntent('泡泡记住：好的').detected).toBe(false)
  })

  it('returns no action/bodyText when not detected', () => {
    const r = detectTeachIntent('今天天气怎么样')
    expect(r.detected).toBe(false)
    expect(r.action).toBeUndefined()
    expect(r.bodyText).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════
// Part 2: TeachParser — mock LLM
// ═══════════════════════════════════════════════════════════

// Mock the logger to suppress output during tests
vi.mock('../src/shared/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { TeachParser, type TeachRecord } from '../src/connector/teach/parser.js'
import type { LLMProvider, LLMResponse, LLMMessage } from '../src/shared/types.js'

function createMockLLM(responseContent: string): LLMProvider {
  return {
    async chat(_messages: LLMMessage[]): Promise<LLMResponse> {
      return { content: responseContent }
    },
  }
}

describe('TeachParser', () => {
  it('parses a complete supplier knowledge record', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      attribute: '产品线',
      value: '无盘螺',
      factText: '桂鑫没有盘螺产品',
      tags: ['桂鑫', '盘螺', '产品线'],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('桂鑫没有盘螺产品', 'remember', '泡泡记住：桂鑫没有盘螺产品')

    expect(record).not.toBeNull()
    expect(record!.entityName).toBe('桂鑫')
    expect(record!.entityType).toBe('supplier')
    expect(record!.attribute).toBe('产品线')
    expect(record!.value).toBe('无盘螺')
    expect(record!.factText).toBe('桂鑫没有盘螺产品')
    expect(record!.action).toBe('remember')
    expect(record!.tags).toContain('桂鑫')
    expect(record!.rawInput).toBe('泡泡记住：桂鑫没有盘螺产品')
  })

  it('parses record from markdown code block response', async () => {
    const llm = createMockLLM('```json\n' + JSON.stringify({
      entityName: '马台',
      entityType: 'customer',
      attribute: '联系人',
      value: '张总',
      factText: '马台的联系人是张总',
      tags: ['马台', '联系人'],
    }) + '\n```')

    const parser = new TeachParser(llm)
    const record = await parser.parse('马台联系人是张总', 'remember', '泡泡记住：马台联系人是张总')

    expect(record).not.toBeNull()
    expect(record!.entityName).toBe('马台')
    expect(record!.entityType).toBe('customer')
  })

  it('falls back to "other" for invalid entityType', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '某规则',
      entityType: 'invalid_type',
      factText: '这是一个通用规则',
      tags: ['规则'],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('这是一个通用规则', 'remember', '泡泡记住：这是一个通用规则')

    expect(record).not.toBeNull()
    expect(record!.entityType).toBe('other')
  })

  it('returns null if entityName is missing', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityType: 'supplier',
      factText: '没有实体名',
      tags: [],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('某些知识', 'remember', '泡泡记住：某些知识')

    expect(record).toBeNull()
  })

  it('returns null if factText is missing', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      tags: ['桂鑫'],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('桂鑫相关信息', 'remember', '泡泡记住：桂鑫相关信息')

    expect(record).toBeNull()
  })

  it('returns null if LLM returns non-JSON', async () => {
    const llm = createMockLLM('我不理解你的意思')

    const parser = new TeachParser(llm)
    const record = await parser.parse('混乱的输入', 'remember', '泡泡记住：混乱的输入')

    expect(record).toBeNull()
  })

  it('returns null if LLM throws an error', async () => {
    const llm: LLMProvider = {
      async chat(): Promise<LLMResponse> {
        throw new Error('Network error')
      },
    }

    const parser = new TeachParser(llm)
    const record = await parser.parse('网络测试', 'remember', '泡泡记住：网络测试')

    expect(record).toBeNull()
  })

  it('preserves action from input', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      factText: '桂鑫的信息需要更新',
      tags: ['桂鑫'],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('桂鑫的信息需要更新', 'update', '泡泡更新：桂鑫的信息需要更新')

    expect(record).not.toBeNull()
    expect(record!.action).toBe('update')
  })

  it('handles tags as non-array gracefully', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      factText: '桂鑫信息',
      tags: 'not_an_array',
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('桂鑫信息', 'remember', '泡泡记住：桂鑫信息')

    expect(record).not.toBeNull()
    expect(record!.tags).toEqual([])
  })

  it('filters non-string entries from tags', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      factText: '桂鑫信息',
      tags: ['桂鑫', 123, null, '盘螺'],
    }))

    const parser = new TeachParser(llm)
    const record = await parser.parse('桂鑫信息', 'remember', '泡泡记住：桂鑫信息')

    expect(record).not.toBeNull()
    expect(record!.tags).toEqual(['桂鑫', '盘螺'])
  })

  it('accepts all valid entityTypes', async () => {
    const validTypes = ['supplier', 'customer', 'project', 'product', 'person', 'rule', 'other'] as const
    for (const entityType of validTypes) {
      const llm = createMockLLM(JSON.stringify({
        entityName: '测试',
        entityType,
        factText: '测试事实',
        tags: [],
      }))
      const parser = new TeachParser(llm)
      const record = await parser.parse('测试', 'remember', '泡泡记住：测试')
      expect(record).not.toBeNull()
      expect(record!.entityType).toBe(entityType)
    }
  })
})

// ═══════════════════════════════════════════════════════════
// Part 3: TeachStore — mock bubble model
// ═══════════════════════════════════════════════════════════

vi.mock('../src/bubble/model.js', () => ({
  createBubble: vi.fn((input: Record<string, unknown>) => ({
    id: 'test-bubble-id',
    type: input.type,
    title: input.title,
    content: input.content,
    metadata: input.metadata || {},
    tags: input.tags || [],
    links: [],
    source: input.source || 'system',
    confidence: input.confidence ?? 1.0,
    decayRate: input.decayRate ?? 0.1,
    pinned: input.pinned ?? false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessedAt: Date.now(),
    abstractionLevel: input.abstractionLevel ?? 0,
  })),
  updateBubble: vi.fn(),
  searchBubbles: vi.fn(() => []),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: vi.fn(),
}))

import { TeachStore } from '../src/connector/teach/store.js'
import { createBubble, updateBubble, searchBubbles } from '../src/bubble/model.js'
import { addLink } from '../src/bubble/links.js'

const mockedCreateBubble = vi.mocked(createBubble)
const mockedUpdateBubble = vi.mocked(updateBubble)
const mockedSearchBubbles = vi.mocked(searchBubbles)

describe('TeachStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedSearchBubbles.mockReturnValue([])
  })

  const baseRecord: TeachRecord = {
    action: 'remember',
    entityName: '桂鑫',
    entityType: 'supplier',
    attribute: '产品线',
    value: '无盘螺',
    factText: '桂鑫没有盘螺产品',
    tags: ['桂鑫', '盘螺'],
    rawInput: '泡泡记住：桂鑫没有盘螺产品',
  }

  it('creates a pinned entity bubble for remember action', async () => {
    const store = new TeachStore()
    const result = await store.store(baseRecord)

    expect(result.bubbleId).toBe('test-bubble-id')
    expect(result.action).toBe('remember')
    expect(result.expired).toEqual([])
    expect(result.confirmation).toContain('已记住')
    expect(result.confirmation).toContain('桂鑫没有盘螺产品')

    expect(mockedCreateBubble).toHaveBeenCalledOnce()
    const call = mockedCreateBubble.mock.calls[0][0]
    expect(call.type).toBe('entity')
    expect(call.pinned).toBe(true)
    expect(call.decayRate).toBe(0.01)
    expect(call.abstractionLevel).toBe(1)
    expect(call.source).toBe('teach')
    expect(call.confidence).toBe(1.0)
    expect(call.content).toBe('桂鑫没有盘螺产品')
    expect(call.title).toBe('知识: 桂鑫 - 产品线')
    expect(call.tags).toContain('知识')
    expect(call.tags).toContain('教学')
    expect(call.tags).toContain('供应商')
    expect(call.tags).toContain('桂鑫')
    expect((call.metadata as Record<string, unknown>).source).toBe('teach')
  })

  it('creates title without attribute when attribute is not set', async () => {
    const store = new TeachStore()
    const recordNoAttr = { ...baseRecord, attribute: undefined }
    await store.store(recordNoAttr)

    const call = mockedCreateBubble.mock.calls[0][0]
    expect(call.title).toBe('知识: 桂鑫')
  })

  it('returns "已标记注意" confirmation for note action', async () => {
    const store = new TeachStore()
    const noteRecord = { ...baseRecord, action: 'note' as TeachAction }
    const result = await store.store(noteRecord)

    expect(result.confirmation).toContain('已标记注意')
  })

  it('returns "已更新" confirmation for update action', async () => {
    const store = new TeachStore()
    const updateRecord = { ...baseRecord, action: 'update' as TeachAction }
    const result = await store.store(updateRecord)

    expect(result.confirmation).toContain('已更新')
  })

  it('expires conflicting pinned teach bubbles', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'old-bubble-1',
        type: 'entity',
        title: '知识: 桂鑫 - 产品线',
        content: '旧的知识',
        metadata: { source: 'teach', attribute: '产品线' },
        tags: ['桂鑫', '知识'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.01,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 1,
      },
    ] as any)

    const store = new TeachStore()
    const result = await store.store(baseRecord)

    expect(result.expired).toEqual(['old-bubble-1'])
    expect(mockedUpdateBubble).toHaveBeenCalledWith('old-bubble-1', { pinned: false })
    expect(result.confirmation).not.toContain('旧记录') // remember doesn't mention replacement
  })

  it('update action mentions replaced records count', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'old-1',
        type: 'entity',
        title: '知识: 桂鑫',
        content: '旧知识',
        metadata: { source: 'teach', attribute: '产品线' },
        tags: ['桂鑫'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.01,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 1,
      },
    ] as any)

    const store = new TeachStore()
    const updateRecord = { ...baseRecord, action: 'update' as TeachAction }
    const result = await store.store(updateRecord)

    expect(result.confirmation).toContain('已更新')
    expect(result.confirmation).toContain('已替换 1 条旧记录')
  })

  it('does not expire non-entity bubbles', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'memory-bubble',
        type: 'memory',  // not entity
        title: '桂鑫相关记忆',
        content: '...',
        metadata: { source: 'teach' },
        tags: ['桂鑫'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.1,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 0,
      },
    ] as any)

    const store = new TeachStore()
    await store.store(baseRecord)

    expect(mockedUpdateBubble).not.toHaveBeenCalled()
  })

  it('does not expire non-pinned entity bubbles', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'unpinned-bubble',
        type: 'entity',
        title: '知识: 桂鑫',
        content: '...',
        metadata: { source: 'teach' },
        tags: ['桂鑫'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.1,
        pinned: false,  // not pinned
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 1,
      },
    ] as any)

    const store = new TeachStore()
    await store.store(baseRecord)

    expect(mockedUpdateBubble).not.toHaveBeenCalled()
  })

  it('does not expire bubbles from non-teach source', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'other-source-bubble',
        type: 'entity',
        title: '桂鑫',
        content: '...',
        metadata: { source: 'excel-import' },  // not teach
        tags: ['桂鑫'],
        links: [],
        source: 'excel-import',
        confidence: 1.0,
        decayRate: 0.1,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 0,
      },
    ] as any)

    const store = new TeachStore()
    await store.store(baseRecord)

    expect(mockedUpdateBubble).not.toHaveBeenCalled()
  })

  // ── Forget tests ────────────────────────────────────────
  it('handles forget by accelerating decay', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'to-forget-1',
        type: 'entity',
        title: '知识: 桂鑫',
        content: '桂鑫没有盘螺产品',
        metadata: { source: 'teach' },
        tags: ['桂鑫'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.01,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 1,
      },
    ] as any)

    const store = new TeachStore()
    const forgetRecord: TeachRecord = {
      ...baseRecord,
      action: 'forget',
      attribute: undefined,  // forget without specific attribute → match all
    }
    const result = await store.store(forgetRecord)

    expect(result.action).toBe('forget')
    expect(result.expired).toEqual(['to-forget-1'])
    expect(result.bubbleId).toBe('')
    expect(result.confirmation).toContain('已遗忘')
    expect(result.confirmation).toContain('桂鑫')
    expect(result.confirmation).toContain('1 条知识')

    expect(mockedUpdateBubble).toHaveBeenCalledWith('to-forget-1', { pinned: false, decayRate: 0.5 })
    expect(mockedCreateBubble).not.toHaveBeenCalled() // forget doesn't create new bubbles
  })

  it('forget returns "没有找到" when no matching records exist', async () => {
    mockedSearchBubbles.mockReturnValue([])

    const store = new TeachStore()
    const forgetRecord: TeachRecord = {
      ...baseRecord,
      action: 'forget',
    }
    const result = await store.store(forgetRecord)

    expect(result.expired).toEqual([])
    expect(result.confirmation).toContain('没有找到')
    expect(result.confirmation).toContain('桂鑫')
  })

  it('passes spaceId to searchBubbles and createBubble', async () => {
    const store = new TeachStore()
    await store.store(baseRecord, 'space-123')

    expect(mockedSearchBubbles).toHaveBeenCalledWith('桂鑫', 20, ['space-123'])

    const createCall = mockedCreateBubble.mock.calls[0][0]
    expect(createCall.spaceId).toBe('space-123')
  })

  it('deduplicates tags', async () => {
    const store = new TeachStore()
    const recordDupTags: TeachRecord = {
      ...baseRecord,
      tags: ['桂鑫', '知识', '供应商', '桂鑫'], // 桂鑫 appears twice
    }
    await store.store(recordDupTags)

    const call = mockedCreateBubble.mock.calls[0][0]
    const tagSet = new Set(call.tags)
    expect(tagSet.size).toBe(call.tags!.length) // no duplicates
  })
})

// ═══════════════════════════════════════════════════════════
// Part 4: TeachHandler — integration (detect → parse → store)
// ═══════════════════════════════════════════════════════════

import { TeachHandler } from '../src/connector/teach/handler.js'

describe('TeachHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedSearchBubbles.mockReturnValue([])
  })

  it('returns handled:false for non-teach messages', async () => {
    const llm = createMockLLM('{}')
    const handler = new TeachHandler(llm)
    const result = await handler.tryHandle('今天天气怎么样')

    expect(result.handled).toBe(false)
    expect(result.response).toBeUndefined()
  })

  it('returns handled:false when parser fails', async () => {
    // LLM returns something that can't be parsed into a valid record
    const llm = createMockLLM('我不理解')
    const handler = new TeachHandler(llm)
    const result = await handler.tryHandle('泡泡记住：桂鑫没有盘螺产品')

    expect(result.handled).toBe(false)
  })

  it('handles successful remember flow end-to-end', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      attribute: '产品线',
      value: '无盘螺',
      factText: '桂鑫没有盘螺产品',
      tags: ['桂鑫', '盘螺'],
    }))

    const handler = new TeachHandler(llm)
    const result = await handler.tryHandle('泡泡记住：桂鑫没有盘螺产品')

    expect(result.handled).toBe(true)
    expect(result.response).toContain('已记住')
    expect(result.bubbleId).toBe('test-bubble-id')
  })

  it('handles successful forget flow end-to-end', async () => {
    mockedSearchBubbles.mockReturnValue([
      {
        id: 'to-forget',
        type: 'entity',
        title: '知识: 桂鑫',
        content: '桂鑫没有盘螺产品',
        metadata: { source: 'teach' },
        tags: ['桂鑫'],
        links: [],
        source: 'teach',
        confidence: 1.0,
        decayRate: 0.01,
        pinned: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        abstractionLevel: 1,
      },
    ] as any)

    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      factText: '桂鑫没有盘螺',
      tags: ['桂鑫'],
    }))

    const handler = new TeachHandler(llm)
    const result = await handler.tryHandle('泡泡忘记：桂鑫没有盘螺这个事')

    expect(result.handled).toBe(true)
    expect(result.response).toContain('已遗忘')
  })

  it('passes spaceId through the full flow', async () => {
    const llm = createMockLLM(JSON.stringify({
      entityName: '桂鑫',
      entityType: 'supplier',
      factText: '桂鑫没有盘螺产品',
      tags: ['桂鑫'],
    }))

    const handler = new TeachHandler(llm)
    await handler.tryHandle('泡泡记住：桂鑫没有盘螺产品', 'space-abc')

    expect(mockedSearchBubbles).toHaveBeenCalledWith('桂鑫', 20, ['space-abc'])
    const createCall = mockedCreateBubble.mock.calls[0][0]
    expect(createCall.spaceId).toBe('space-abc')
  })
})
