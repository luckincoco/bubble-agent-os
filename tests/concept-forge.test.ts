import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import type { EventBus } from '../src/event/event-bus.js'
import type { LLMProvider } from '../src/shared/types.js'
import type { OrientationSnapshot, OrientationNode } from '../src/cognition/orientation-graph.js'

// ── Mock bubble/model.js ──────────────────────────────────────────

const { mockCreateBubble } = vi.hoisted(() => ({
  mockCreateBubble: vi.fn().mockReturnValue({ id: 'mock-concept-bubble' }),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
}))

// ── Mock bubble/links.js ──────────────────────────────────────────

const { mockAddLink } = vi.hoisted(() => ({
  mockAddLink: vi.fn(),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { ConceptForge } from '../src/cognition/concept-forge.js'
import type { OrientationGraph } from '../src/cognition/orientation-graph.js'

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string
let forge: ConceptForge
let llm: LLMProvider
let mockOrientGraph: { getSnapshot: ReturnType<typeof vi.fn> }

function makeLLM(found = false): LLMProvider {
  const content = found
    ? JSON.stringify({ found: true, type: 'isomorphism', name: '供需价格联动', description: '供需变化驱动价格波动', confidence: 0.75 })
    : '{"found":false}'
  return {
    chat: vi.fn().mockResolvedValue({ content, usage: { promptTokens: 50, completionTokens: 20 } }),
    chatStream: vi.fn(),
  } as unknown as LLMProvider
}

function makeNode(id: string, overrides: Partial<OrientationNode> = {}): OrientationNode {
  return {
    observationId: id,
    domain: `领域${id}`,
    band: 'exploring',
    gapScore: 0.5,
    freshness: 5,
    dependsOn: [],
    contradicts: [],
    ...overrides,
  }
}

function makeSnapshot(nodes: OrientationNode[]): OrientationSnapshot {
  return {
    spaceId: 'space-1',
    builtAt: Date.now(),
    nodes,
    frontiers: [...nodes].sort((a, b) => b.gapScore - a.gapScore).slice(0, 3),
    tensions: [],
  }
}

/** Insert a bubble into the real DB for computeTrendAlignment queries */
function insertBubble(id: string, confidence: number, type = 'observation'): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, type, `测试${id}`, '内容',
    '{}', JSON.stringify(['observation']),
    'reflector', confidence, 0.1, 0,
    Date.now(), Date.now(), Date.now(),
    'space-1', 0, 'summary',
  )
}

function makeEventBus(): EventBus {
  return { emitFireAndForget: vi.fn() } as unknown as EventBus
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'concept-forge-test-'))
  initDatabase(tmpDir, 'test-pass')
  llm = makeLLM()
  mockOrientGraph = { getSnapshot: vi.fn() }
  forge = new ConceptForge(llm, mockOrientGraph as unknown as OrientationGraph)
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────

describe('ConceptForge', () => {
  describe('computeTrendAlignment', () => {
    it('returns ~1.0 when confidences are close', () => {
      insertBubble('a', 0.7)
      insertBubble('b', 0.72)
      const nodeA = makeNode('a')
      const nodeB = makeNode('b')
      const score = (forge as any).computeTrendAlignment(nodeA, nodeB)
      expect(score).toBeCloseTo(0.98, 1)
    })

    it('returns low score when confidences differ significantly', () => {
      insertBubble('a', 0.9)
      insertBubble('b', 0.1)
      const nodeA = makeNode('a')
      const nodeB = makeNode('b')
      const score = (forge as any).computeTrendAlignment(nodeA, nodeB)
      expect(score).toBeCloseTo(0.2, 1)
    })
  })

  describe('computeTemporalCooccurrence', () => {
    it('returns 1.0 when freshness gap <= 2', () => {
      const a = makeNode('a', { freshness: 3 })
      const b = makeNode('b', { freshness: 4 })
      expect((forge as any).computeTemporalCooccurrence(a, b)).toBe(1.0)
    })

    it('returns 0.7 when freshness gap <= 7', () => {
      const a = makeNode('a', { freshness: 1 })
      const b = makeNode('b', { freshness: 6 })
      expect((forge as any).computeTemporalCooccurrence(a, b)).toBe(0.7)
    })

    it('returns 0.4 when freshness gap <= 14', () => {
      const a = makeNode('a', { freshness: 0 })
      const b = makeNode('b', { freshness: 10 })
      expect((forge as any).computeTemporalCooccurrence(a, b)).toBe(0.4)
    })

    it('returns 0.1 when freshness gap > 14', () => {
      const a = makeNode('a', { freshness: 0 })
      const b = makeNode('b', { freshness: 20 })
      expect((forge as any).computeTemporalCooccurrence(a, b)).toBe(0.1)
    })
  })

  describe('computeEvidenceShapeSim', () => {
    it('scores high when dependency/contradiction counts are similar', () => {
      const a = makeNode('a', { dependsOn: ['x', 'y'], contradicts: ['z'] })
      const b = makeNode('b', { dependsOn: ['p'], contradicts: ['q'] })
      const snapshot = makeSnapshot([a, b])
      const score = (forge as any).computeEvidenceShapeSim(a, b, snapshot)
      // Both have 2 deps vs 1 dep: depSim = 1 - |2-1|/3 = 0.67
      // Both have 1 con: conSim = 1.0
      // Both have contradictions: tensionBonus = 0.2
      // => (0.67 + 1.0) / 2 + 0.2 = 1.035 -> min(1, ...) = 1.0
      expect(score).toBeGreaterThanOrEqual(0.8)
    })
  })

  describe('computeBandCompatibility', () => {
    it('returns 1.0 for same band', () => {
      const a = makeNode('a', { band: 'grounded' })
      const b = makeNode('b', { band: 'grounded' })
      expect((forge as any).computeBandCompatibility(a, b)).toBe(1.0)
    })

    it('returns 0.7 for adjacent bands', () => {
      const a = makeNode('a', { band: 'frontier' })
      const b = makeNode('b', { band: 'exploring' })
      expect((forge as any).computeBandCompatibility(a, b)).toBe(0.7)
    })

    it('returns 0.3 for bands far apart', () => {
      const a = makeNode('a', { band: 'frontier' })
      const b = makeNode('b', { band: 'established' })
      expect((forge as any).computeBandCompatibility(a, b)).toBe(0.3)
    })
  })

  describe('computePreScore', () => {
    it('combines components with correct weights', () => {
      insertBubble('a', 0.6)
      insertBubble('b', 0.6) // same conf => trendAlignment ≈ 1.0
      const a = makeNode('a', { freshness: 5, dependsOn: ['x'], contradicts: [] })
      const b = makeNode('b', { freshness: 6, dependsOn: ['y'], contradicts: [] })
      const snapshot = makeSnapshot([a, b])

      const components = (forge as any).computePreScore(a, b, snapshot)
      expect(components.trendAlignment).toBeGreaterThan(0.9)
      expect(components.temporalCooccurrence).toBe(1.0) // gap = 1
      // band: both exploring => 1.0
      expect(components.bandCompatibility).toBe(1.0)

      const preScore =
        0.40 * components.trendAlignment +
        0.25 * components.temporalCooccurrence +
        0.20 * components.evidenceShapeSim +
        0.15 * components.bandCompatibility

      expect(preScore).toBeGreaterThan(0.7)
    })
  })

  describe('generateCandidates', () => {
    it('excludes same-domain pairs', () => {
      const nodes = [
        makeNode('a', { domain: '钢价趋势', band: 'frontier', gapScore: 0.8 }),
        makeNode('b', { domain: '钢价趋势', band: 'exploring', gapScore: 0.5 }),
        makeNode('c', { domain: '供应商可靠性', band: 'grounded', gapScore: 0.3 }),
      ]
      const snapshot = makeSnapshot(nodes)

      const candidates = (forge as any).generateCandidates(snapshot)
      // Only cross-domain pairs: (a,c) and (b,c)
      const uniquePairs = new Set(candidates.map((c: any) => [c.nodeA.observationId, c.nodeB.observationId].sort().join('|')))
      expect(uniquePairs.has('a|b')).toBe(false)
      expect(uniquePairs.has('a|c')).toBe(true)
      expect(uniquePairs.has('b|c')).toBe(true)
    })
  })

  describe('forge', () => {
    it('returns empty when snapshot has < 4 nodes', async () => {
      mockOrientGraph.getSnapshot.mockReturnValue(makeSnapshot([
        makeNode('a'), makeNode('b'), makeNode('c'),
      ]))
      const result = await forge.forge()
      expect(result).toHaveLength(0)
    })

    it('returns forged concepts from full pipeline', async () => {
      insertBubble('n1', 0.7)
      insertBubble('n2', 0.3)
      insertBubble('n3', 0.5)
      insertBubble('n4', 0.9)
      insertBubble('n5', 0.6)

      mockOrientGraph.getSnapshot.mockReturnValue(makeSnapshot([
        makeNode('n1', { domain: '钢价趋势', freshness: 2 }),
        makeNode('n2', { domain: '供应商可靠性', freshness: 5 }),
        makeNode('n3', { domain: '客户模式', freshness: 10 }),
        makeNode('n4', { domain: '财务敞口', freshness: 3 }),
        makeNode('n5', { domain: '利润分析', freshness: 7 }),
      ]))

      // Create LLM that returns found for the first pair
      llm = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({ found: true, type: 'isomorphism', name: '供需价格联动', description: '供需驱动价格', confidence: 0.75 }),
          usage: { promptTokens: 50, completionTokens: 20 },
        }),
        chatStream: vi.fn(),
      } as unknown as LLMProvider
      forge = new ConceptForge(llm, mockOrientGraph as unknown as OrientationGraph)
      forge.setEventBus(makeEventBus())

      const result = await forge.forge()

      expect(result.length).toBeGreaterThanOrEqual(1)
      expect(result[0].name).toBeTruthy()
      expect(result[0].structureType).toBe('isomorphism')
      // materialize should be called: confidence 0.75 >= 0.5 -> queued
      expect(mockCreateBubble).toHaveBeenCalled()
    })

    it('handles LLM returning not found gracefully', async () => {
      insertBubble('n1', 0.7)
      insertBubble('n2', 0.3)
      insertBubble('n3', 0.5)
      insertBubble('n4', 0.9)
      insertBubble('n5', 0.6)

      mockOrientGraph.getSnapshot.mockReturnValue(makeSnapshot([
        makeNode('n1', { domain: '钢价趋势' }),
        makeNode('n2', { domain: '供应商可靠性' }),
        makeNode('n3', { domain: '客户模式' }),
        makeNode('n4', { domain: '财务敞口' }),
        makeNode('n5', { domain: '利润分析' }),
      ]))

      // LLM returns not found for all pairs
      llm = {
        chat: vi.fn().mockResolvedValue({
          content: '{"found":false}',
          usage: { promptTokens: 10, completionTokens: 5 },
        }),
        chatStream: vi.fn(),
      } as unknown as LLMProvider
      forge = new ConceptForge(llm, mockOrientGraph as unknown as OrientationGraph)

      const result = await forge.forge()

      expect(result).toHaveLength(0)
      // LLM was called (some pairs passed pre-filter) but returned not-found
      expect(llm.chat).toHaveBeenCalled()
    })
  })

  describe('detectStructure', () => {
    it('returns ForgedConcept when LLM finds structure', async () => {
      insertBubble('a', 0.7)
      insertBubble('b', 0.5)
      const a = makeNode('a', { domain: '钢价趋势' })
      const b = makeNode('b', { domain: '供应商可靠性' })
      const snapshot = makeSnapshot([a, b])

      llm = {
        chat: vi.fn().mockResolvedValue({
          content: JSON.stringify({ found: true, type: 'analogy', name: '钢价供应商联动', description: '钢价波动影响供应商行为', confidence: 0.6 }),
          usage: { promptTokens: 50, completionTokens: 20 },
        }),
        chatStream: vi.fn(),
      } as unknown as LLMProvider
      forge = new ConceptForge(llm, mockOrientGraph as unknown as OrientationGraph)

      const concept = await (forge as any).detectStructure({ nodeA: a, nodeB: b, preScore: 0.7, components: {} }, snapshot)
      expect(concept).not.toBeNull()
      expect(concept.name).toBe('钢价供应商联动')
      expect(concept.structureType).toBe('analogy')
    })

    it('returns null when LLM returns not found', async () => {
      insertBubble('a', 0.7)
      insertBubble('b', 0.5)
      const a = makeNode('a', { domain: '钢价趋势' })
      const b = makeNode('b', { domain: '供应商可靠性' })
      const snapshot = makeSnapshot([a, b])

      const concept = await (forge as any).detectStructure({ nodeA: a, nodeB: b, preScore: 0.7, components: {} }, snapshot)
      expect(concept).toBeNull()
    })
  })

  describe('materialize', () => {
    it('auto-creates bubble for high confidence (>0.85)', async () => {
      const concept = {
        name: '供需规律',
        description: '描述',
        structureType: 'isomorphism' as const,
        sourceNodes: ['a', 'b'] as [string, string],
        confidence: 0.9,
      }
      const spaceId = 'space-1'

      await (forge as any).materialize(concept, spaceId)

      expect(mockCreateBubble).toHaveBeenCalled()
      const input = mockCreateBubble.mock.calls[0][0]
      expect(input.type).toBe('synthesis')
      expect(input.title).toContain('供需规律')
      expect(input.metadata.pendingApproval).toBeFalsy()
      // addLink called for abstracted_from
      expect(mockAddLink).toHaveBeenCalled()
    })

    it('queues for approval at medium confidence (0.5-0.85)', async () => {
      const concept = {
        name: '供需规律',
        description: '描述',
        structureType: 'duality' as const,
        sourceNodes: ['a', 'b'] as [string, string],
        confidence: 0.6,
      }

      await (forge as any).materialize(concept, 'space-1')

      expect(mockCreateBubble).toHaveBeenCalled()
      const input = mockCreateBubble.mock.calls[0][0]
      expect(input.metadata.pendingApproval).toBe(true)
    })

    it('discards low confidence concepts', async () => {
      const concept = {
        name: '噪声',
        description: '无意义',
        structureType: 'analogy' as const,
        sourceNodes: ['a', 'b'] as [string, string],
        confidence: 0.3,
      }

      await (forge as any).materialize(concept, 'space-1')

      expect(mockCreateBubble).not.toHaveBeenCalled()
      expect(mockAddLink).not.toHaveBeenCalled()
    })
  })

  describe('setEventBus / setInternalizationEngine', () => {
    it('setEventBus stores the bus', () => {
      const bus = makeEventBus()
      forge.setEventBus(bus)
      expect((forge as any).eventBus).toBe(bus)
    })

    it('setInternalizationEngine stores the engine', () => {
      const engine = {} as any
      forge.setInternalizationEngine(engine)
      expect((forge as any).internalizationEngine).toBe(engine)
    })
  })
})
