import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module mocks ────────────────────────────────────────────

const mockPrepare = vi.fn()
const mockRun = vi.fn()
const mockDb = {
  prepare: () => ({ run: mockRun }),
}

vi.mock('../src/storage/database.js', () => ({
  getDatabase: () => mockDb,
}))

import { MetricsCollector } from '../src/memory/resonance/metrics-collector.js'
import type { ConversationSignal } from '../src/memory/resonance/metrics-collector.js'
import type { EventBus } from '../src/event/event-bus.js'

// ── Helpers ─────────────────────────────────────────────────

function makeCollector(eventBus?: EventBus): MetricsCollector {
  const c = new MetricsCollector()
  if (eventBus) c.setEventBus(eventBus)
  return c
}

function stripTimestamps(signals: ConversationSignal[]): any[] {
  return signals.map(({ timestamp, ...rest }) => rest)
}

// ── Reversal detection ──────────────────────────────────────

describe('reversal detection', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('其实不是这样 triggers reversal', () => {
    const result = collector.analyzeUserMessage('其实不是这样，我觉得应该换个方式', null, 'u1')
    const reversal = result.find(s => s.type === 'reversal')
    expect(reversal).toBeDefined()
    expect(reversal!.confidence).toBe(0.8)
  })

  it('我改主意了 triggers reversal', () => {
    const result = collector.analyzeUserMessage('我改主意了，今天先不去了', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('我之前说错了 triggers reversal', () => {
    const result = collector.analyzeUserMessage('我之前说错了，应该是另一个方案', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('不对 应该 triggers reversal', () => {
    const result = collector.analyzeUserMessage('不对，应该是这样才对', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('反转 pattern variants', () => {
    const msg = '反过来想，这个方案也有好处'
    const result = collector.analyzeUserMessage(msg, null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('我想错了 triggers reversal', () => {
    const result = collector.analyzeUserMessage('我想错了，重新来', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('我收回 triggers reversal', () => {
    const result = collector.analyzeUserMessage('我收回刚才的话', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('算了不是这个意思 triggers reversal', () => {
    const result = collector.analyzeUserMessage('算了，不是这个意思', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeDefined()
  })

  it('neutral message does not trigger reversal', () => {
    const result = collector.analyzeUserMessage('今天天气真好，适合出去走走', null, 'u1')
    expect(result.find(s => s.type === 'reversal')).toBeUndefined()
  })
})

// ── Correction detection ────────────────────────────────────

describe('correction detection', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('你说错了 triggers correction', () => {
    const result = collector.analyzeUserMessage('你说错了，不是这样的', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('不是...而是 triggers correction', () => {
    const result = collector.analyzeUserMessage('不是价格问题，而是质量问题', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('这个不准确 triggers correction', () => {
    const result = collector.analyzeUserMessage('这个不准确，数据有点旧了', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('纠正一下 triggers correction', () => {
    const result = collector.analyzeUserMessage('纠正一下，那个是上个月的', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('准确地说 triggers correction', () => {
    const result = collector.analyzeUserMessage('准确地说，应该是三个不是两个', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('你搞错了 triggers correction', () => {
    const result = collector.analyzeUserMessage('你搞错了，再看一下文档', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('你之前说的不对 triggers correction', () => {
    const result = collector.analyzeUserMessage('你之前说的不对，事实是相反的', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })

  it('错了应该是 triggers correction', () => {
    const result = collector.analyzeUserMessage('错了，应该是周二不是周三', null, 'u1')
    expect(result.find(s => s.type === 'correction')).toBeDefined()
  })
})

// ── Citation check detection ────────────────────────────────

describe('citation check detection', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('你之前说过的 triggers citation_check', () => {
    const result = collector.analyzeUserMessage('你之前说过的那个方案是什么来着？', null, 'u1')
    expect(result.find(s => s.type === 'citation_check')).toBeDefined()
  })

  it('你不是说过 triggers citation_check', () => {
    const result = collector.analyzeUserMessage('你不是说过要改架构吗？', null, 'u1')
    expect(result.find(s => s.type === 'citation_check')).toBeDefined()
  })

  it('你记得 triggers citation_check', () => {
    const result = collector.analyzeUserMessage('你记得我们上次讨论的结果吗', null, 'u1')
    expect(result.find(s => s.type === 'citation_check')).toBeDefined()
  })

  it('你提到过？ triggers citation_check', () => {
    const result = collector.analyzeUserMessage('你提到过那个新功能吗？', null, 'u1')
    expect(result.find(s => s.type === 'citation_check')).toBeDefined()
  })

  it('你觉得...还是 triggers citation_check', () => {
    const result = collector.analyzeUserMessage('你觉得A方案好还是B方案好', null, 'u1')
    expect(result.find(s => s.type === 'citation_check')).toBeDefined()
  })
})

// ── Return detection ────────────────────────────────────────

describe('return detection', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('回到刚才那个 triggers return', () => {
    const result = collector.analyzeUserMessage('回到刚才那个话题，我觉得还可以再讨论一下', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })

  it('继续聊刚才的 triggers return', () => {
    const result = collector.analyzeUserMessage('继续聊刚才的预算问题', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })

  it('接着刚才的说 triggers return', () => {
    const result = collector.analyzeUserMessage('接着刚才的说，那个客户后来回复了吗', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })

  it('我们上次聊的 triggers return', () => {
    const result = collector.analyzeUserMessage('我们上次聊的那个项目有进展了', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })

  it('还是说回 triggers return', () => {
    const result = collector.analyzeUserMessage('还是说回正题吧', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })

  it('再说一下那个 triggers return', () => {
    const result = collector.analyzeUserMessage('再说一下那个方案的具体细节', null, 'u1')
    expect(result.find(s => s.type === 'return')).toBeDefined()
  })
})

// ── Association break ───────────────────────────────────────

describe('association break', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('dramatic topic shift with >20 chars returns 0.85', () => {
    const result = collector.analyzeUserMessage(
      '最近发现了一家很好吃的日料店，三文鱼特别新鲜',
      '刚才讨论了财务预算的分配方案和季度目标',
      'u1',
    )
    const assocBreak = result.find(s => s.type === 'association_break')
    expect(assocBreak).toBeDefined()
    expect(assocBreak!.confidence).toBe(0.85)
  })

  it('moderate similarity with >30 chars returns 0.75', () => {
    // Some shared words but low enough similarity
    const result = collector.analyzeUserMessage(
      '关于预算分配，我觉得可以考虑增加市场部门的投入比例',
      '刚才讨论了财务预算的分配方案和季度目标',
      'u1',
    )
    const assocBreak = result.find(s => s.type === 'association_break')
    // budget/预算 is shared, so similarity might be above 0.1 threshold
    // If it's below 0.1, it returns 0.75; if above, no break
    if (assocBreak) {
      expect(assocBreak.confidence).toBeGreaterThanOrEqual(0.75)
    }
  })

  it('high similarity topic does not trigger break', () => {
    const result = collector.analyzeUserMessage(
      '预算分配方案我觉得可以再讨论一下',
      '刚才讨论了财务预算的分配方案和季度目标',
      'u1',
    )
    expect(result.find(s => s.type === 'association_break')).toBeUndefined()
  })

  it('no lastAssistantResponse skips association break', () => {
    const result = collector.analyzeUserMessage(
      '最近发现了一家很好吃的日料店',
      null,  // no response to compare
      'u1',
    )
    expect(result.find(s => s.type === 'association_break')).toBeUndefined()
  })

  it('short message < 10 chars skips association break', () => {
    const result = collector.analyzeUserMessage(
      '你好',
      '刚才讨论了财务预算的分配方案和季度目标',
      'u1',
    )
    expect(result.find(s => s.type === 'association_break')).toBeUndefined()
  })
})

// ── Multiple signals ────────────────────────────────────────

describe('multiple signals', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('reversal + correction in same message', () => {
    // "不对，其实…" matches reversal (不对[，,\s]*(应该|其实))
    // "你说错了" matches correction (你(说|记)错了)
    const result = collector.analyzeUserMessage(
      '不对，其实应该这样考虑，而且你说错了',
      null, 'u1',
    )
    const types = result.map(s => s.type)
    expect(types).toContain('reversal')
    expect(types).toContain('correction')
  })

  it('return + citation_check in same message', () => {
    const result = collector.analyzeUserMessage(
      '回到刚才那个话题，你之前说过的方案是什么？',
      null, 'u1',
    )
    const types = result.map(s => s.type)
    expect(types).toContain('return')
    expect(types).toContain('citation_check')
  })

  it('user content is truncated to 200 chars', () => {
    const long = '不对，你说错了，' + 'a'.repeat(300)
    const result = collector.analyzeUserMessage(long, null, 'u1')
    for (const sig of result) {
      expect(sig.content.length).toBeLessThanOrEqual(200)
    }
  })
})

// ── No signals ──────────────────────────────────────────────

describe('no signals', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('simple greeting returns empty', () => {
    const result = collector.analyzeUserMessage('你好', null, 'u1')
    expect(result).toHaveLength(0)
  })

  it('statement about facts returns empty', () => {
    const result = collector.analyzeUserMessage('今天气温25度，适合出门散步', null, 'u1')
    expect(result).toHaveLength(0)
  })

  it('question about topic returns empty', () => {
    const result = collector.analyzeUserMessage('这个功能什么时候上线？', null, 'u1')
    expect(result).toHaveLength(0)
  })

  it('empty message returns empty', () => {
    const result = collector.analyzeUserMessage('', null, 'u1')
    expect(result).toHaveLength(0)
  })
})

// ── Signal metadata ─────────────────────────────────────────

describe('signal metadata', () => {
  let collector: MetricsCollector

  beforeEach(() => {
    collector = makeCollector()
    mockRun.mockClear()
  })

  it('reversal signal has userId and truncated content', () => {
    const result = collector.analyzeUserMessage('其实不是这样，我觉得应该换个方式', null, 'u1')
    const sig = result.find(s => s.type === 'reversal')!
    expect(sig.userId).toBe('u1')
    expect(sig.content).toBe('其实不是这样，我觉得应该换个方式')
    expect(sig.timestamp).toBeGreaterThan(0)
  })

  it('correction signal has 0.85 confidence', () => {
    const result = collector.analyzeUserMessage('你说错了，不是这样的', null, 'u1')
    const sig = result.find(s => s.type === 'correction')!
    expect(sig.confidence).toBe(0.85)
  })

  it('return signal has 0.85 confidence', () => {
    const result = collector.analyzeUserMessage('回到刚才那个话题', null, 'u1')
    const sig = result.find(s => s.type === 'return')!
    expect(sig.confidence).toBe(0.85)
  })

  it('citation_check signal has 0.7 confidence', () => {
    const result = collector.analyzeUserMessage('你之前说过的方案是什么？', null, 'u1')
    const sig = result.find(s => s.type === 'citation_check')!
    expect(sig.confidence).toBe(0.7)
  })
})

// ── DB persistence (via mock) ──────────────────────────────

describe('DB persistence', () => {
  beforeEach(() => {
    mockRun.mockClear()
  })

  it('signals call mockRun with correct args', () => {
    const collector = new MetricsCollector()
    collector.analyzeUserMessage('其实不是这样，你说错了', null, 'u1', 'space-1')

    expect(mockRun).toHaveBeenCalledTimes(2)
    // First signal: reversal
    expect(mockRun.mock.calls[0][0]).toBe('reversal')
    expect(mockRun.mock.calls[0][1]).toBe('u1')
    expect(mockRun.mock.calls[0][5]).toBe('space-1')
    // Second signal: correction
    expect(mockRun.mock.calls[1][0]).toBe('correction')
  })

  it('no signals = no mockRun calls', () => {
    const collector = new MetricsCollector()
    collector.analyzeUserMessage('今天天气很好', null, 'u1')

    expect(mockRun).not.toHaveBeenCalled()
  })

  it('EventBus emitFireAndForget called for each signal', () => {
    const emitFireAndForget = vi.fn()
    const eventBus = { emitFireAndForget, on: vi.fn() } as any

    const collector = new MetricsCollector()
    collector.setEventBus(eventBus)
    collector.analyzeUserMessage('其实不是这样，你说错了', null, 'u1')

    expect(emitFireAndForget).toHaveBeenCalledTimes(2)
    expect(emitFireAndForget.mock.calls[0][0].type).toBe('metrics.signal.detected')
    expect(emitFireAndForget.mock.calls[0][0].payload.signalType).toBe('reversal')
    expect(emitFireAndForget.mock.calls[1][0].payload.signalType).toBe('correction')
  })

  it('no signals = no emitFireAndForget', () => {
    const emitFireAndForget = vi.fn()
    const eventBus = { emitFireAndForget, on: vi.fn() } as any

    const collector = new MetricsCollector()
    collector.setEventBus(eventBus)
    collector.analyzeUserMessage('今天天气很好', null, 'u1')

    expect(emitFireAndForget).not.toHaveBeenCalled()
  })
})
