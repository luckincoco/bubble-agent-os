import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObservationRecorder, type ObservationEvent } from '../src/memory/observation-recorder.js'

vi.mock('../src/bubble/model.js', () => ({
  createBubble: vi.fn(() => ({ id: 'mock-obs' })),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: vi.fn(),
}))

import { createBubble } from '../src/bubble/model.js'
import { addLink } from '../src/bubble/links.js'

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Helpers ────────────────────────────────────────────────────────

/** High-value tool result >= 30 chars to pass all filters */
const LONG_RESULT = '今日北京天气晴朗，气温25到28度，适合户外活动，空气质量优。' // 34 chars
/** Non-high-value tool result >= 100 chars */
const VERY_LONG_RESULT = 'x'.repeat(100)

// ── record: 跳过逻辑 ──────────────────────────────────────────────

describe('record — 跳过逻辑', () => {
  it('SKIP_TOOLS 返回 null', () => {
    const r = new ObservationRecorder()
    expect(r.record({ action: 'get_time', args: {}, result: '现在是下午3点' })).toBeNull()
    expect(r.record({ action: 'get_weather', args: {}, result: '今日晴天' })).toBeNull()
    expect(createBubble).not.toHaveBeenCalled()
  })

  it('空结果返回 null', () => {
    const r = new ObservationRecorder()
    expect(r.record({ action: 'web_search', args: { query: 'test' }, result: '' })).toBeNull()
    expect(createBubble).not.toHaveBeenCalled()
  })

  it('短结果（< 30 字符）返回 null', () => {
    const r = new ObservationRecorder()
    expect(r.record({ action: 'web_search', args: { query: 'test' }, result: 'OK' })).toBeNull()
    expect(createBubble).not.toHaveBeenCalled()
  })

  it('非高价值工具且结果 < 100 字符返回 null', () => {
    const r = new ObservationRecorder()
    const result = r.record({ action: 'custom_tool', args: {}, result: 'x'.repeat(50) })
    expect(result).toBeNull()
    expect(createBubble).not.toHaveBeenCalled()
  })
})

// ── record: 记录逻辑 ──────────────────────────────────────────────

describe('record — 记录逻辑', () => {
  it('高价值工具记录并返回 ID', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValue({ id: 'obs-rec-1' })

    const result = r.record({ action: 'web_search', args: { query: '天气' }, result: LONG_RESULT })
    expect(result).toBe('obs-rec-1')
    expect(createBubble).toHaveBeenCalledTimes(1)
  })

  it('非高价值工具结果 >= 100 字符可记录', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValue({ id: 'obs-rec-2' })

    const result = r.record({ action: 'custom_tool', args: {}, result: VERY_LONG_RESULT })
    expect(result).toBe('obs-rec-2')
    expect(createBubble).toHaveBeenCalledTimes(1)
  })

  it('createBubble 入参 — 高价值工具 confidence=0.9 decayRate=0.08', () => {
    const r = new ObservationRecorder()
    r.record({ action: 'web_search', args: { query: '上海天气' }, result: LONG_RESULT, spaceId: 's1' })

    const args = createBubble.mock.calls[0][0]
    expect(args.type).toBe('observation')
    expect(args.title).toContain('web_search')
    expect(args.title).toContain('上海天气')
    expect(args.tags).toEqual(expect.arrayContaining(['auto-observation', 'tool:web_search', 'assertion:fact']))
    expect(args.confidence).toBe(0.9)
    expect(args.decayRate).toBe(0.08)
    expect(args.spaceId).toBe('s1')
    expect(args.source).toBe('tool_call')
  })

  it('createBubble 入参 — 非高价值工具 confidence=0.7 decayRate=0.15', () => {
    const r = new ObservationRecorder()
    r.record({ action: 'custom_tool', args: { keyword: '测试' }, result: VERY_LONG_RESULT })

    const args = createBubble.mock.calls[0][0]
    expect(args.title).toContain('custom_tool')
    expect(args.confidence).toBe(0.7)
    expect(args.decayRate).toBe(0.15)
  })

  it('无 query/keyword 参数时 title 使用默认格式', () => {
    const r = new ObservationRecorder()
    r.record({ action: 'some_action', args: { id: 42 }, result: VERY_LONG_RESULT })

    const args = createBubble.mock.calls[0][0]
    expect(args.title).toBe('some_action 调用结果')
  })

  it('content 包含 action、args 和截断后的结果', () => {
    const r = new ObservationRecorder()
    r.record({ action: 'query_excel', args: { filename: 'report.xlsx' }, result: 'a'.repeat(600) })

    const args = createBubble.mock.calls[0][0]
    expect(args.content).toContain('[query_excel]')
    expect(args.content).toContain('report.xlsx')
    expect(args.content).toContain('结果:')
    // Result should be capped at 500 chars
    expect(args.content.length).toBeLessThan(600)
  })
})

// ── record: 去重 ──────────────────────────────────────────────────

describe('record — 去重', () => {
  it('5 分钟内相同 tool+args 去重', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValue({ id: 'obs-dedup' })

    r.record({ action: 'web_search', args: { query: '北京天气' }, result: LONG_RESULT })
    expect(createBubble).toHaveBeenCalledTimes(1)

    const result = r.record({ action: 'web_search', args: { query: '北京天气' }, result: LONG_RESULT })
    expect(result).toBeNull()
    expect(createBubble).toHaveBeenCalledTimes(1)
  })

  it('不同 args 不受去重影响', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValue({ id: 'obs-dedup' })

    r.record({ action: 'web_search', args: { query: '北京' }, result: LONG_RESULT })
    r.record({ action: 'web_search', args: { query: '上海' }, result: LONG_RESULT })

    expect(createBubble).toHaveBeenCalledTimes(2)
  })
})

// ── recordBatch ───────────────────────────────────────────────────

describe('recordBatch', () => {
  it('返回所有成功记录的 ID', () => {
    const r = new ObservationRecorder()
    createBubble
      .mockReturnValueOnce({ id: 'batch-1' })
      .mockReturnValueOnce({ id: 'batch-2' })

    const result = r.recordBatch([
      { action: 'web_search', args: { query: 'a' }, result: LONG_RESULT },
      { action: 'web_search', args: { query: 'b' }, result: LONG_RESULT },
    ])

    expect(result).toEqual(['batch-1', 'batch-2'])
  })

  it('跳过不符合条件的项目', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValueOnce({ id: 'batch-1' })

    const result = r.recordBatch([
      { action: 'get_time', args: {}, result: '现在是3点' },
      { action: 'web_search', args: { query: 'a' }, result: LONG_RESULT },
    ])

    expect(result).toEqual(['batch-1'])
    expect(createBubble).toHaveBeenCalledTimes(1)
  })

  it('多个记录建立 co_observed 链接', () => {
    const r = new ObservationRecorder()
    createBubble
      .mockReturnValueOnce({ id: 'obs-1' })
      .mockReturnValueOnce({ id: 'obs-2' })
      .mockReturnValueOnce({ id: 'obs-3' })

    r.recordBatch([
      { action: 'web_search', args: { query: 'a' }, result: LONG_RESULT },
      { action: 'web_search', args: { query: 'b' }, result: LONG_RESULT },
      { action: 'web_search', args: { query: 'c' }, result: LONG_RESULT },
    ])

    expect(addLink).toHaveBeenCalledTimes(3)
    expect(addLink).toHaveBeenCalledWith('obs-1', 'obs-2', 'co_observed', 0.6, 'system')
    expect(addLink).toHaveBeenCalledWith('obs-1', 'obs-3', 'co_observed', 0.6, 'system')
    expect(addLink).toHaveBeenCalledWith('obs-2', 'obs-3', 'co_observed', 0.6, 'system')
  })

  it('单个记录不建立链接', () => {
    const r = new ObservationRecorder()
    createBubble.mockReturnValueOnce({ id: 'obs-1' })

    r.recordBatch([
      { action: 'web_search', args: { query: 'a' }, result: LONG_RESULT },
    ])

    expect(addLink).not.toHaveBeenCalled()
  })
})
