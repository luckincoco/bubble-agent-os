import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SurpriseDetector } from '../src/memory/surprise-detector.js'

const mockSearchBubbles = vi.fn()
const mockCreateBubble = vi.fn()
const mockAddLink = vi.fn()
const mockCalcSurprise = vi.fn()

vi.mock('../src/bubble/model.js', () => ({
  searchBubbles: (...args: unknown[]) => mockSearchBubbles(...args),
  createBubble: (...args: unknown[]) => mockCreateBubble(...args),
  findBubblesByType: vi.fn(),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: (...args: unknown[]) => mockAddLink(...args),
}))

vi.mock('../src/memory/manager.js', () => ({
  calcSurprise: (...args: unknown[]) => mockCalcSurprise(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateBubble.mockReturnValue({ id: 'mock-event' })
})

const detector = new SurpriseDetector()

// ── scanExcelImport — 跳过条件 ───────────────────────────────────

describe('scanExcelImport — 跳过条件', () => {
  it('无历史数据时跳过', async () => {
    mockSearchBubbles.mockReturnValue([])
    await detector.scanExcelImport([], ['col'], {}, 'Sheet1')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })

  it('有历史数据但无 numericStats 时跳过', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 's1', tags: ['excel-summary', 'Sheet1'], metadata: {} },
    ])
    await detector.scanExcelImport([], ['col'], {}, 'Sheet1')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })

  it('无异常时不创建事件', async () => {
    const stats = { 数量: { sum: 100, min: 10, max: 50, count: 5 } }
    mockSearchBubbles.mockReturnValue([
      { id: 's1', createdAt: 1000, tags: ['excel-summary', 'Sheet1'], content: '旧数据',
        metadata: { numericStats: { 数量: { sum: 100, min: 10, max: 50, count: 5 } } } },
    ])
    await detector.scanExcelImport([{ 数量: 30 }], ['数量'], stats, 'Sheet1')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })
})

// ── scanExcelImport — 异常检测 ───────────────────────────────────

describe('scanExcelImport — 异常检测', () => {
  it('最大值异常增长触发事件', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 's2', createdAt: 1000, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 数量: { sum: 100, min: 10, max: 50, count: 5 } } } },
      { id: 's1', createdAt: 500, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 数量: { sum: 100, min: 10, max: 50, count: 5 } } } },
    ])
    await detector.scanExcelImport([], ['数量'], { 数量: { sum: 100, min: 10, max: 80, count: 5 } }, 'Sheet1')

    expect(mockCreateBubble).toHaveBeenCalled()
    const call = mockCreateBubble.mock.calls[0][0]
    expect(call.tags).toContain('surprise')
    expect(call.content).toContain('最大值异常增长')
  })

  it('最小值异常下降触发事件', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 's2', createdAt: 1000, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 金额: { sum: 1000, min: 100, max: 500, count: 5 } } } },
      { id: 's1', createdAt: 500, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 金额: { sum: 1000, min: 100, max: 500, count: 5 } } } },
    ])
    await detector.scanExcelImport([], ['金额'], { 金额: { sum: 1000, min: 50, max: 500, count: 5 } }, 'Sheet1')

    expect(mockCreateBubble).toHaveBeenCalled()
    expect(mockCreateBubble.mock.calls[0][0].content).toContain('最小值异常下降')
  })

  it('总量变化超过 30% 触发事件', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 's2', createdAt: 1000, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 金额: { sum: 1000, min: 10, max: 500, count: 5 } } } },
      { id: 's1', createdAt: 500, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { 金额: { sum: 1000, min: 10, max: 500, count: 5 } } } },
    ])
    await detector.scanExcelImport([], ['金额'], { 金额: { sum: 2000, min: 10, max: 500, count: 5 } }, 'Sheet1')

    expect(mockCreateBubble).toHaveBeenCalled()
    expect(mockCreateBubble.mock.calls[0][0].content).toContain('总量增长')
  })

  it('扫描到新实体', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 's3', createdAt: 2000, tags: ['excel-summary', 'Sheet1'], content: '',
        metadata: { numericStats: { x: { sum: 100, min: 10, max: 50, count: 5 } } } },
      { id: 's2', createdAt: 1000, tags: ['excel-summary', 'Sheet1'],
        content: '旧实体列表',
        metadata: { numericStats: { x: { sum: 100, min: 10, max: 50, count: 5 } } } },
    ])
    const rows = [{ 供应商: '新公司A' }, { 供应商: '新公司B' }]
    await detector.scanExcelImport(rows, ['供应商'], { x: { sum: 100, min: 10, max: 50, count: 5 } }, 'Sheet1')

    expect(mockCreateBubble).toHaveBeenCalled()
    expect(mockCreateBubble.mock.calls[0][0].content).toContain('新公司')
  })
})

// ── scanMessage — 跳过条件 ───────────────────────────────────────

describe('scanMessage — 跳过条件', () => {
  it('无数字消息跳过', async () => {
    await detector.scanMessage('你好')
    expect(mockSearchBubbles).not.toHaveBeenCalled()
  })

  it('短消息跳过', async () => {
    await detector.scanMessage('是 123')
    expect(mockSearchBubbles).not.toHaveBeenCalled()
  })

  it('无匹配 bubble 跳过', async () => {
    mockSearchBubbles.mockReturnValue([])
    await detector.scanMessage('价格是 500 元足够长')
    expect(mockCalcSurprise).not.toHaveBeenCalled()
  })
})

// ── scanMessage — 矛盾检测 ───────────────────────────────────────

describe('scanMessage — 矛盾检测', () => {
  it('calcSurprise 返回 contradicts=false 跳过', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'b1', content: '旧信息' }])
    mockCalcSurprise.mockReturnValue({ score: 0.5, contradicts: false })
    await detector.scanMessage('价格是 500 元足够长')
    expect(mockCreateBubble).not.toHaveBeenCalled()
  })

  it('calcSurprise 返回 contradicts=true 创建事件', async () => {
    mockSearchBubbles.mockReturnValue([{ id: 'b1', content: '旧信息' }])
    mockCalcSurprise.mockReturnValue({ score: 0.9, contradicts: true })
    await detector.scanMessage('价格是 500 元足够长')

    expect(mockCreateBubble).toHaveBeenCalled()
    const call = mockCreateBubble.mock.calls[0][0]
    expect(call.tags).toContain('surprise')
    expect(call.tags).toContain('contradiction')
    expect(mockAddLink).toHaveBeenCalledWith('mock-event', 'b1', 'contradicts', 1.0, 'system')
  })
})

// ── checkContradictionPressure ──────────────────────────────────

describe('checkContradictionPressure', () => {
  it('< 2 个矛盾时不创建 question', async () => {
    mockSearchBubbles.mockReturnValue([]) // searchBubbles('矛盾', ...) returns empty
    mockCalcSurprise.mockReturnValue({ score: 0.9, contradicts: true })
    mockCreateBubble.mockReturnValue({ id: 'mock-event' })
    mockSearchBubbles.mockReturnValueOnce([{ id: 'b1', content: '旧' }]) // scanMessage search
    mockSearchBubbles.mockReturnValueOnce([]) // checkContradictionPressure search for '矛盾'

    await detector.scanMessage('价格是 500 元足够长')
    // The scanMessage creates the contradiction event but checkContradictionPressure
    // should not create a question because < 2 contradictions found
    // mockCreateBubble was called once for the event, not for a question
    expect(mockCreateBubble).toHaveBeenCalledTimes(1)
  })

  it('≥ 2 个矛盾且无近期 question 时创建 question', async () => {
    // Mock the three searchBubbles calls in sequence:
    // 1. scanMessage: searchBubbles(text, ...) → existing bubbles
    // 2. checkContradictionPressure: searchBubbles('矛盾', ...) → recent contradictions
    // 3. checkContradictionPressure: searchBubbles('信息矛盾', ...) → no existing question
    mockSearchBubbles
      .mockReturnValueOnce([{ id: 'b1', content: '旧信息' }]) // scanMessage search
      .mockReturnValueOnce([ // searchBubbles('矛盾', ...) — 2 recent contradictions
        { id: 'c1', type: 'event', tags: ['contradiction'], content: '矛盾1', createdAt: Date.now() - 86400000 },
        { id: 'c2', type: 'event', tags: ['contradiction'], content: '矛盾2', createdAt: Date.now() - 86400000 },
      ])
      .mockReturnValueOnce([]) // searchBubbles('信息矛盾', ...) — no recent question
    mockCalcSurprise.mockReturnValue({ score: 0.9, contradicts: true })
    mockCreateBubble.mockReturnValue({ id: 'mock-event' })

    await detector.scanMessage('价格是 500 元足够长')

    // createBubble called twice: once for the contradiction event, once for the question
    expect(mockCreateBubble).toHaveBeenCalledTimes(2)
    const questionCall = mockCreateBubble.mock.calls[1][0]
    expect(questionCall.type).toBe('question')
    expect(questionCall.tags).toContain('contradiction-pressure')
  })
})
