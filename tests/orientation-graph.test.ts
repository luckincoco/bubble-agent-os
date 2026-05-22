import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import type { Bubble, BubbleLink } from '../src/shared/types.js'
import type { EventBus } from '../src/event/event-bus.js'
import type { LLMProvider } from '../src/shared/types.js'

// ── Mock bubble/model.js ──────────────────────────────────────────

const { mockFindBubblesByType, mockSearchBubbles } = vi.hoisted(() => ({
  mockFindBubblesByType: vi.fn(),
  mockSearchBubbles: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  findBubblesByType: mockFindBubblesByType,
  searchBubbles: mockSearchBubbles,
}))

// ── Mock bubble/links.js ──────────────────────────────────────────

const { mockFindLinksByRelation, mockAddLink } = vi.hoisted(() => ({
  mockFindLinksByRelation: vi.fn(),
  mockAddLink: vi.fn(),
}))

vi.mock('../src/bubble/links.js', () => ({
  findLinksByRelation: mockFindLinksByRelation,
  addLink: mockAddLink,
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { OrientationGraph } from '../src/cognition/orientation-graph.js'

// ── Helpers ────────────────────────────────────────────────────────

const TENANT = 'default'
let tmpDir: string
let graph: OrientationGraph
let llm: LLMProvider

function makeLLM(): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      content: '{"found":false}',
      usage: { promptTokens: 10, completionTokens: 5 },
    }),
    chatStream: vi.fn(),
  } as unknown as LLMProvider
}

function makeEventBus(): EventBus {
  return { emitFireAndForget: vi.fn() } as unknown as EventBus
}

function makeObs(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id,
    type: 'observation',
    title: `测试观察${id}`,
    content: `${id} 的详细内容`,
    metadata: {},
    tags: ['observation', 'auto-discovered'],
    links: [],
    createdAt: Date.now() - 100000,
    updatedAt: Date.now() - 50000,
    accessedAt: Date.now() - 50000,
    source: 'reflector',
    confidence: 0.5,
    decayRate: 0.1,
    pinned: false,
    spaceId: 'space-1',
    abstractionLevel: 0,
    ...overrides,
  }
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orient-graph-test-'))
  initDatabase(tmpDir, 'test-pass')
  llm = makeLLM()
  graph = new OrientationGraph(llm)
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────

describe('OrientationGraph', () => {
  describe('classifyBand', () => {
    it('returns frontier for confidence < 0.3', () => {
      expect((graph as any).classifyBand(0.0)).toBe('frontier')
      expect((graph as any).classifyBand(0.29)).toBe('frontier')
    })

    it('returns exploring for confidence 0.3–0.59', () => {
      expect((graph as any).classifyBand(0.3)).toBe('exploring')
      expect((graph as any).classifyBand(0.5)).toBe('exploring')
    })

    it('returns grounded for confidence 0.6–0.84', () => {
      expect((graph as any).classifyBand(0.6)).toBe('grounded')
      expect((graph as any).classifyBand(0.84)).toBe('grounded')
    })

    it('returns established for confidence >= 0.85', () => {
      expect((graph as any).classifyBand(0.85)).toBe('established')
      expect((graph as any).classifyBand(1.0)).toBe('established')
    })
  })

  describe('inferDomain', () => {
    it('returns domain from STEEL_DOMAIN_MAP when tag matches', () => {
      const obs = makeObs('obs-1', { tags: ['observation', '钢价'] })
      expect((graph as any).inferDomain(obs)).toBe('钢价趋势')
    })

    it('returns domain when title contains keyword', () => {
      const obs = makeObs('obs-2', { title: '今日螺纹钢价格走势', tags: ['observation'] })
      expect((graph as any).inferDomain(obs)).toBe('钢价趋势')
    })

    it('returns domain when content contains keyword', () => {
      const obs = makeObs('obs-3', {
        tags: ['observation'],
        title: '无关键词标题',
        content: '关于发货时效的最新情况',
      })
      expect((graph as any).inferDomain(obs)).toBe('供应商交期')
    })

    it('falls back to first meaningful tag when no domain match', () => {
      const obs = makeObs('obs-4', { tags: ['observation', '自定义领域'] })
      expect((graph as any).inferDomain(obs)).toBe('自定义领域')
    })

    it('falls back to truncated title when no meaningful tags', () => {
      const obs = makeObs('obs-5', { tags: ['observation'] })
      expect((graph as any).inferDomain(obs)).toBe('测试观察obs-')
    })
  })

  describe('getGuidanceForSearch', () => {
    it('returns empty guidance when no snapshot', () => {
      const guidance = graph.getGuidanceForSearch('space-1')
      expect(guidance.frontiers).toHaveLength(0)
      expect(guidance.tensions).toHaveLength(0)
      expect(guidance.avoidDomains).toHaveLength(0)
    })

    it('returns guidance from existing snapshot', () => {
      // Manually set snapshot via buildSnapshot with controlled mocks
      mockFindBubblesByType.mockReturnValue([
        makeObs('o1', { confidence: 0.2, tags: ['observation', '钢价'] }),
        makeObs('o2', { confidence: 0.9, tags: ['observation', '供应商可靠性'] }),
      ])
      mockFindLinksByRelation.mockReturnValue([])

      // Need to await — this is async
      // We'll test getGuidanceForSearch via buildSnapshot in the buildSnapshot test group.
      // For now, set a partial snapshot directly
      const snapshot = {
        spaceId: 'space-1',
        builtAt: Date.now(),
        nodes: [
          {
            observationId: 'o1', domain: '钢价趋势', band: 'frontier' as const,
            gapScore: 0.8, freshness: 10, dependsOn: [], contradicts: [],
          },
          {
            observationId: 'o2', domain: '供应商可靠性', band: 'established' as const,
            gapScore: 0.05, freshness: 2, dependsOn: [], contradicts: [],
          },
        ],
        frontiers: [
          {
            observationId: 'o1', domain: '钢价趋势', band: 'frontier' as const,
            gapScore: 0.8, freshness: 10, dependsOn: [], contradicts: [],
          },
        ],
        tensions: [],
      }
      ;(graph as any).snapshot = snapshot

      const guidance = graph.getGuidanceForSearch('space-1')
      expect(guidance.frontiers).toHaveLength(1)
      expect(guidance.frontiers[0].domain).toBe('钢价趋势')
      // avoidDomains should include established + fresh (o2: established, freshness=2 < 7)
      expect(guidance.avoidDomains).toContain('供应商可靠性')
    })
  })

  describe('applyFeedback', () => {
    beforeEach(() => {
      const snapshot = {
        spaceId: 'space-1',
        builtAt: Date.now(),
        nodes: [
          {
            observationId: 'o1', domain: '钢价趋势', band: 'frontier' as const,
            gapScore: 0.8, freshness: 10, dependsOn: [], contradicts: [],
          },
          {
            observationId: 'o2', domain: '供应商可靠性', band: 'exploring' as const,
            gapScore: 0.5, freshness: 5, dependsOn: [], contradicts: [],
          },
          {
            observationId: 'o3', domain: '钢价趋势', band: 'established' as const,
            gapScore: 0.1, freshness: 3, dependsOn: [], contradicts: [],
          },
        ],
        frontiers: [],
        tensions: [],
      }
      ;(graph as any).snapshot = snapshot
    })

    it('approved reduces gapScore and upgrades band', () => {
      graph.setEventBus(makeEventBus())
      graph.applyFeedback({
        action: 'approved',
        affectedDomains: ['钢价趋势'],
        impactType: 'confirms',
        causalChain: 'test',
      })

      const nodes = (graph as any).snapshot.nodes
      const steelNode = nodes.find((n: any) => n.observationId === 'o1')
      // gapScore *= 0.7 => 0.8 * 0.7 = 0.56
      expect(steelNode.gapScore).toBeCloseTo(0.56, 5)
      // band upgrades from frontier to exploring
      expect(steelNode.band).toBe('exploring')
    })

    it('rejected increases gapScore and keeps exploring band (minimum level)', () => {
      graph.applyFeedback({
        action: 'rejected',
        affectedDomains: ['供应商可靠性'],
        impactType: 'contradicts',
        causalChain: 'test',
      })

      const nodes = (graph as any).snapshot.nodes
      const node = nodes.find((n: any) => n.observationId === 'o2')
      // gapScore = 0.5 * 1.3 + 0.1 = 0.75
      expect(node.gapScore).toBeCloseTo(0.75, 5)
      // exploring does NOT downgrade further on rejection (only grounded->exploring, established->grounded)
      expect(node.band).toBe('exploring')
    })

    it('downgrades established to grounded on rejection', () => {
      graph.applyFeedback({
        action: 'rejected',
        affectedDomains: ['钢价趋势'],
        impactType: 'contradicts',
        causalChain: 'test',
      })

      const nodes = (graph as any).snapshot.nodes
      const node = nodes.find((n: any) => n.observationId === 'o3')
      // established -> grounded
      expect(node.band).toBe('grounded')
    })
  })

  describe('buildSnapshot', () => {
    it('returns empty snapshot when no observations', async () => {
      mockFindBubblesByType.mockReturnValue([])

      const snapshot = await graph.buildSnapshot('space-1')
      expect(snapshot.nodes).toHaveLength(0)
      expect(snapshot.frontiers).toHaveLength(0)
      expect(snapshot.tensions).toHaveLength(0)
    })

    it('builds nodes with computed metrics from observations', async () => {
      mockFindBubblesByType.mockReturnValue([
        makeObs('o1', {
          confidence: 0.2,
          tags: ['observation', '钢价'],
          updatedAt: Date.now() - 20 * 24 * 60 * 60 * 1000, // 20 days ago
        }),
        makeObs('o2', {
          confidence: 0.9,
          tags: ['observation', '供应商可靠性'],
          updatedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, // 2 days ago
        }),
      ])
      mockFindLinksByRelation.mockReturnValue([])

      const snapshot = await graph.buildSnapshot('space-1')

      expect(snapshot.nodes).toHaveLength(2)
      // o1: low confidence -> frontier
      const o1 = snapshot.nodes.find(n => n.observationId === 'o1')
      expect(o1!.band).toBe('frontier')
      expect(o1!.domain).toBe('钢价趋势')
      // o2: high confidence -> established
      const o2 = snapshot.nodes.find(n => n.observationId === 'o2')
      expect(o2!.band).toBe('established')
      expect(o2!.domain).toBe('供应商可靠性')
      // Frontiers sorted by gapScore, top 5
      expect(snapshot.frontiers.length).toBeGreaterThanOrEqual(1)
      // o1 (frontier) should be in frontiers, o2 (established) should not
      expect(snapshot.frontiers.some(f => f.observationId === 'o1')).toBe(true)
    })

    it('calls LLM when >= 3 observations', async () => {
      mockFindBubblesByType.mockReturnValue([
        makeObs('o1', { confidence: 0.3, tags: ['observation', '钢价'] }),
        makeObs('o2', { confidence: 0.7, tags: ['observation', '供应商可靠性'] }),
        makeObs('o3', { confidence: 0.5, tags: ['observation', '客户模式'] }),
      ])
      mockFindLinksByRelation.mockReturnValue([])
      llm = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            domains: [
              { id: 'o1', domain: '钢价趋势' },
              { id: 'o2', domain: '供应商可靠性' },
              { id: 'o3', domain: '客户模式' },
            ],
            tensions: [{ a: 'o1', b: 'o2', reason: '钢价涨跌影响供应商利润' }],
            dependencies: [{ from: 'o3', to: 'o1' }],
          }),
          usage: { promptTokens: 50, completionTokens: 30 },
        }),
        chatStream: vi.fn(),
      } as unknown as LLMProvider

      // Recreate graph with new LLM mock
      graph = new OrientationGraph(llm)
      graph.setEventBus(makeEventBus())

      const snapshot = await graph.buildSnapshot('space-1')

      expect(llm.chat).toHaveBeenCalledTimes(1)
      expect(snapshot.tensions).toHaveLength(1)
      expect(mockAddLink).toHaveBeenCalled()
      // addLink called for cognitively_contradicts and cognitively_depends_on
      const contradictions = mockAddLink.mock.calls.filter(
        (c: any[]) => c[2] === 'cognitively_contradicts',
      )
      expect(contradictions.length).toBeGreaterThanOrEqual(1)
    })

    it('handles LLM failure gracefully', async () => {
      mockFindBubblesByType.mockReturnValue([
        makeObs('o1', { confidence: 0.3, tags: ['observation', '钢价'] }),
        makeObs('o2', { confidence: 0.7, tags: ['observation', '供应商'] }),
        makeObs('o3', { confidence: 0.5, tags: ['observation', '客户'] }),
      ])
      mockFindLinksByRelation.mockReturnValue([])
      llm = {
        chat: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
        chatStream: vi.fn(),
      } as unknown as LLMProvider

      graph = new OrientationGraph(llm)
      graph.setEventBus(makeEventBus())

      const snapshot = await graph.buildSnapshot('space-1')

      // Should still return snapshot with nodes even if LLM fails
      expect(snapshot.nodes).toHaveLength(3)
      expect(snapshot.tensions).toHaveLength(0)
    })
  })

  describe('registerNewObservation', () => {
    it('creates cognitively_extends link when strong tag overlap exists', () => {
      // Set up snapshot with an existing observation
      const snapshot = {
        spaceId: 'space-1',
        builtAt: Date.now(),
        nodes: [
          {
            observationId: 'existing-obs', domain: '钢价趋势', band: 'grounded' as const,
            gapScore: 0.3, freshness: 5, dependsOn: [], contradicts: [],
          },
        ],
        frontiers: [],
        tensions: [],
      }
      ;(graph as any).snapshot = snapshot

      // Insert the new observation into DB for the code to query
      const db = getDatabase()
      db.prepare(`
        INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'new-obs', 'observation', '新观察', '内容',
        '{}', JSON.stringify(['observation', '钢价', '供需']),
        'reflector', 0.6, 0.1, 0, Date.now(), Date.now(), Date.now(),
        'space-1', 0, 'summary',
      )

      // Also insert the existing observation into DB so the code can read tags
      db.prepare(`
        INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'existing-obs', 'observation', '已有观察', '内容',
        '{}', JSON.stringify(['observation', '钢价', '供需']),
        'reflector', 0.8, 0.1, 0, Date.now(), Date.now(), Date.now(),
        'space-1', 0, 'summary',
      )

      graph.registerNewObservation('new-obs')

      // Should create cognitively_extends link due to 2+ tag overlap (钢价 + maybe others)
      const extendsCalls = mockAddLink.mock.calls.filter(
        (c: any[]) => c[2] === 'cognitively_extends',
      )
      expect(extendsCalls.length).toBeGreaterThanOrEqual(1)
    })

    it('does nothing when no tag overlap', () => {
      const snapshot = {
        spaceId: 'space-1',
        builtAt: Date.now(),
        nodes: [
          {
            observationId: 'existing-obs', domain: '钢价趋势', band: 'grounded' as const,
            gapScore: 0.3, freshness: 5, dependsOn: [], contradicts: [],
          },
        ],
        frontiers: [],
        tensions: [],
      }
      ;(graph as any).snapshot = snapshot

      const db = getDatabase()
      db.prepare(`
        INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'new-obs', 'observation', '不相关', '内容',
        '{}', JSON.stringify(['observation', '完全', '不同']),
        'reflector', 0.6, 0.1, 0, Date.now(), Date.now(), Date.now(),
        'space-1', 0, 'summary',
      )

      db.prepare(`
        INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'existing-obs', 'observation', '钢价观察', '内容',
        '{}', JSON.stringify(['observation', '钢价']),
        'reflector', 0.8, 0.1, 0, Date.now(), Date.now(), Date.now(),
        'space-1', 0, 'summary',
      )

      graph.registerNewObservation('new-obs')

      const extendsCalls = mockAddLink.mock.calls.filter(
        (c: any[]) => c[2] === 'cognitively_extends',
      )
      expect(extendsCalls).toHaveLength(0)
    })
  })

  describe('constructor and lifecycle', () => {
    it('getSnapshot returns null initially', () => {
      expect(graph.getSnapshot()).toBeNull()
    })

    it('setEventBus stores the bus', () => {
      const bus = makeEventBus()
      graph.setEventBus(bus)
      expect((graph as any).eventBus).toBe(bus)
    })
  })
})
