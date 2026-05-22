import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Bubble, LLMProvider } from '../src/shared/types.js'

// ── Mock bubble/model.js ──────────────────────────────────────────

const { mockFindBubblesByType } = vi.hoisted(() => ({
  mockFindBubblesByType: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  findBubblesByType: mockFindBubblesByType,
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { CausalEvaluator } from '../src/cognition/causal-evaluator.js'

// ── Helpers ────────────────────────────────────────────────────────

function makeLLM(): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({
        impactType: 'confirms',
        affectedObservations: [{ id: 'obs-1', relationship: 'strengthens', delta: 0.1 }],
        causalChain: '新信息与已有观察一致',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'medium',
        informationDepth: 'pattern',
      }),
      usage: { promptTokens: 100, completionTokens: 50 },
    }),
    chatStream: vi.fn(),
  } as unknown as LLMProvider
}

function makeBubble(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id,
    type: 'observation',
    title: `观察${id}`,
    content: '这是一个观察内容的详细描述，用于测试因果评估',
    metadata: {},
    tags: ['observation', 'auto-discovered', '钢价'],
    links: [],
    createdAt: Date.now() - 100000,
    updatedAt: Date.now() - 50000,
    accessedAt: Date.now() - 50000,
    source: 'reflector',
    confidence: 0.6,
    decayRate: 0.1,
    pinned: false,
    spaceId: 'space-1',
    abstractionLevel: 0,
    ...overrides,
  }
}

function makeInput(overrides: Record<string, any> = {}): any {
  return {
    bubbleId: 'input-1',
    content: '今日螺纹钢期货价格下跌2.3%，现货市场跟随走弱',
    source: 'interest-search',
    tags: ['钢价', '期货'],
    spaceId: 'space-1',
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('CausalEvaluator (cognition)', () => {
  let evaluator: CausalEvaluator
  let llm: LLMProvider

  beforeEach(() => {
    llm = makeLLM()
    evaluator = new CausalEvaluator(llm)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('shouldEvaluate', () => {
    it('returns false for memory type bubbles', () => {
      expect(evaluator.shouldEvaluate(makeBubble('m1', { type: 'memory' as any }))).toBe(false)
    })

    it('returns false when content is too short', () => {
      const bubble = makeBubble('s1', { title: '短', content: '短' })
      expect(evaluator.shouldEvaluate(bubble)).toBe(false)
    })

    it('returns false when no observations exist', () => {
      mockFindBubblesByType.mockReturnValue([])
      const bubble = makeBubble('b1', {
        title: '足够长的标题内容',
        content: '以及足够长的内容文本来通过长度检查',
      })
      expect(evaluator.shouldEvaluate(bubble)).toBe(false)
    })

    it('returns false when no tag overlap with observations', () => {
      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', 'auto-discovered', '供应商'] }),
      ])
      const bubble = makeBubble('b2', {
        tags: ['interest-search', '财务'],
        title: '足够长的标题内容用于测试通过长度检查阈值',
        content: '以及足够长的内容文本来通过长度检查确保超过五十字阈值验证通过用于测试',
      })
      expect(evaluator.shouldEvaluate(bubble)).toBe(false)
    })

    it('returns true when tag overlap exists', () => {
      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', 'auto-discovered', '钢价'] }),
      ])
      const bubble = makeBubble('b3', {
        tags: ['interest-search', '钢价'],
        title: '足够长的标题内容用于测试通过长度检查阈值',
        content: '以及足够长的内容文本来通过长度检查确保超过五十字阈值验证通过用于测试',
      })
      expect(evaluator.shouldEvaluate(bubble)).toBe(true)
    })
  })

  describe('getRelevantObservations', () => {
    it('returns scored observations sorted by relevance', () => {
      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-high', { tags: ['observation', '钢价'], confidence: 0.9 }),
        makeBubble('obs-low', { tags: ['observation', '供应商'], confidence: 0.5 }),
      ])

      const result = (evaluator as any).getRelevantObservations(['钢价', '期货'], '内容')
      // Both score > 0; obs-high has tag overlap (2*1+0.9=2.9), obs-low has only confidence (0+0.5=0.5)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe('obs-high')
    })

    it('returns observation with score from confidence even without tag overlap', () => {
      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', '供应商'] }),
      ])
      const result = (evaluator as any).getRelevantObservations(['财务', '敞口'], '内容')
      // Method returns all observations with score > 0; obs-1 has score = 0 + 0.6 (confidence)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('obs-1')
    })
  })

  describe('sanitizeVerdict', () => {
    const observations = [
      makeBubble('obs-1'),
      makeBubble('obs-2'),
      makeBubble('obs-3'),
    ]

    it('marks as novel when confidence below floor (0.3)', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [{ observationId: 'obs-1', relationship: 'strengthens', delta: 0.1 }],
        causalChain: 'test',
        confidence: 0.1,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.impactType).toBe('novel')
      expect(verdict.affectedObservations).toHaveLength(0)
    })

    it('filters invalid observation IDs', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [
          { observationId: 'obs-1', relationship: 'strengthens', delta: 0.1 },
          { observationId: 'nonexistent', relationship: 'weakens', delta: -0.1 },
        ],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.affectedObservations).toHaveLength(1)
      expect(verdict.affectedObservations[0].observationId).toBe('obs-1')
    })

    it('caps delta to [-0.25, 0.15]', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [
          { observationId: 'obs-1', relationship: 'strengthens', delta: 0.5 },
          { observationId: 'obs-2', relationship: 'weakens', delta: -0.8 },
        ],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      const deltas = verdict.affectedObservations.map(a => a.delta)
      expect(deltas).toContain(0.15)
      expect(deltas).toContain(-0.25)
    })

    it('limits affected observations to 3', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [
          { observationId: 'obs-1', relationship: 'strengthens', delta: 0.1 },
          { observationId: 'obs-2', relationship: 'strengthens', delta: 0.1 },
          { observationId: 'obs-3', relationship: 'strengthens', delta: 0.1 },
          { observationId: 'obs-4', relationship: 'strengthens', delta: 0.1 },
        ],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.affectedObservations).toHaveLength(3)
    })

    it('defaults invalid dimension to market_dynamics', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'invalid_dim',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.dimension).toBe('market_dynamics')
    })

    it('defaults invalid urgency to low', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'critical',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.urgency).toBe('low')
    })

    it('sets needsMotiveGap when informationDepth is phenomenon', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'phenomenon',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.needsMotiveGap).toBe(true)
      expect(verdict.needsPatternSupport).toBe(false)
    })

    it('sets needsPatternSupport when informationDepth is motive', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'motive',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.needsPatternSupport).toBe(true)
      expect(verdict.needsMotiveGap).toBe(false)
    })

    it('defaults invalid informationDepth to phenomenon', () => {
      const raw: any = {
        impactType: 'confirms',
        affectedObservations: [],
        causalChain: 'test',
        confidence: 0.7,
        dimension: 'market_dynamics',
        urgency: 'low',
        informationDepth: 'invalid_depth',
      }
      const verdict = (evaluator as any).sanitizeVerdict(raw, observations)
      expect(verdict.informationDepth).toBe('phenomenon')
    })
  })

  describe('evaluate', () => {
    it('returns null when rate limited', async () => {
      mockFindBubblesByType.mockReturnValue([])
      for (let i = 0; i < 5; i++) {
        ;(evaluator as any).checkRateLimit()
      }

      const result = await evaluator.evaluate(makeInput())
      expect(result).toBeNull()
    })

    it('returns novel verdict when no relevant observations', async () => {
      mockFindBubblesByType.mockReturnValue([])
      const result = await evaluator.evaluate(makeInput())
      expect(result).not.toBeNull()
      expect(result!.impactType).toBe('novel')
      expect(result!.needsMotiveGap).toBe(true)
    })

    it('returns sanitized verdict from LLM', async () => {
      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', '钢价'] }),
      ])
      const result = await evaluator.evaluate(makeInput({ tags: ['钢价'] }))
      expect(result).not.toBeNull()
      expect(result!.impactType).toBe('confirms')
      expect(result!.causalChain).toBe('新信息与已有观察一致')
    })

    it('returns null when LLM returns invalid JSON', async () => {
      llm = {
        chat: vi.fn().mockResolvedValue({ content: 'not json at all', usage: { promptTokens: 10, completionTokens: 5 } }),
        chatStream: vi.fn(),
      } as unknown as LLMProvider
      evaluator = new CausalEvaluator(llm)

      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', '钢价'] }),
      ])
      const result = await evaluator.evaluate(makeInput({ tags: ['钢价'] }))
      expect(result).toBeNull()
    })

    it('returns null when LLM throws', async () => {
      llm = {
        chat: vi.fn().mockRejectedValue(new Error('API error')),
        chatStream: vi.fn(),
      } as unknown as LLMProvider
      evaluator = new CausalEvaluator(llm)

      mockFindBubblesByType.mockReturnValue([
        makeBubble('obs-1', { tags: ['observation', '钢价'] }),
      ])
      const result = await evaluator.evaluate(makeInput({ tags: ['钢价'] }))
      expect(result).toBeNull()
    })
  })

  describe('batchEvaluate', () => {
    it('evaluates multiple inputs', async () => {
      mockFindBubblesByType.mockReturnValue([])
      const inputs = [
        makeInput({ bubbleId: 'i1' }),
        makeInput({ bubbleId: 'i2' }),
      ]
      const results = await evaluator.batchEvaluate(inputs)
      expect(results).toHaveLength(2)
      expect(results[0].input.bubbleId).toBe('i1')
      expect(results[1].input.bubbleId).toBe('i2')
      expect(results[0].verdict!.impactType).toBe('novel')
      expect(results[1].verdict!.impactType).toBe('novel')
    })
  })

  describe('checkRateLimit', () => {
    it('allows first 5 evaluations', () => {
      for (let i = 0; i < 5; i++) {
        expect((evaluator as any).checkRateLimit()).toBe(true)
      }
    })

    it('blocks after 5 evaluations', () => {
      for (let i = 0; i < 5; i++) {
        (evaluator as any).checkRateLimit()
      }
      expect((evaluator as any).checkRateLimit()).toBe(false)
    })
  })
})
