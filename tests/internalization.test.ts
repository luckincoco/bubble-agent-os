import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import type { EventBus } from '../src/event/event-bus.js'
import type { CausalVerdict } from '../src/cognition/causal-evaluator.js'
import type { OrientationGraph } from '../src/cognition/orientation-graph.js'

// ── Mock bubble/model.js ──────────────────────────────────────────

const { mockCreateBubble, mockUpdateBubble } = vi.hoisted(() => ({
  mockCreateBubble: vi.fn().mockReturnValue({ id: 'mock-proposal-bubble' }),
  mockUpdateBubble: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
  updateBubble: mockUpdateBubble,
}))

// ── Mock bubble/links.js ──────────────────────────────────────────

const { mockAddLink, mockFindLinksByRelation } = vi.hoisted(() => ({
  mockAddLink: vi.fn(),
  mockFindLinksByRelation: vi.fn().mockReturnValue([]),
}))

vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
  findLinksByRelation: mockFindLinksByRelation,
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { InternalizationEngine, type InternalizationProposal } from '../src/cognition/internalization.js'

// ── Helpers ────────────────────────────────────────────────────────

let tmpDir: string
let engine: InternalizationEngine

function makeVerdict(overrides: Partial<CausalVerdict> = {}): CausalVerdict {
  return {
    impactType: 'confirms',
    affectedObservations: [{ observationId: 'obs-1', relationship: 'strengthens', delta: 0.15 }],
    causalChain: 'test-chain',
    confidence: 0.7,
    dimension: 'market_dynamics',
    urgency: 'medium',
    informationDepth: 'phenomenon',
    ...overrides,
  }
}

function makeEventBus(): EventBus {
  return { emitFireAndForget: vi.fn() } as unknown as EventBus
}

function makeOrientGraph(): OrientationGraph {
  return { applyFeedback: vi.fn() } as unknown as OrientationGraph
}

/** Insert an observation bubble into the real DB. */
function insertObservation(id: string, overrides: {
  confidence?: number
  decayRate?: number
  metadata?: Record<string, unknown>
  tags?: string[]
  title?: string
  content?: string
} = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, 'observation',
    overrides.title || `观察${id}`,
    overrides.content || '内容',
    JSON.stringify(overrides.metadata || {}),
    JSON.stringify(overrides.tags || ['observation']),
    'reflector',
    overrides.confidence ?? 0.5,
    overrides.decayRate ?? 0.1,
    0, Date.now(), Date.now(), Date.now(),
    'space-1', 0, 'summary',
  )
}

/** Insert a dependency link into bubble_links. */
function insertLink(sourceId: string, targetId: string, relation = 'cognitively_depends_on'): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO bubble_links (source_id, target_id, relation, weight, link_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sourceId, targetId, relation, 0.5, 'system', Date.now())
}

// ── Setup / Teardown ──────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'internalization-test-'))
  initDatabase(tmpDir, 'test-pass')
  engine = new InternalizationEngine()
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.clearAllMocks()
})

// ── Tests ─────────────────────────────────────────────────────────

describe('InternalizationEngine', () => {
  describe('lifecycle', () => {
    it('setEventBus stores the bus', () => {
      const bus = makeEventBus()
      engine.setEventBus(bus)
      expect((engine as any).eventBus).toBe(bus)
    })

    it('setOrientationGraph stores the graph', () => {
      const graph = makeOrientGraph()
      engine.setOrientationGraph(graph)
      expect((engine as any).orientationGraph).toBe(graph)
    })

    it('setApprovalMode changes requireApproval', () => {
      engine.setApprovalMode(false)
      expect((engine as any).requireApproval).toBe(false)
    })
  })

  describe('generateProposal', () => {
    it('returns null for novel impact type', () => {
      const verdict = makeVerdict({ impactType: 'novel' })
      expect(engine.generateProposal(verdict, 'ev-1')).toBeNull()
    })

    it('returns null when no affected observations', () => {
      const verdict = makeVerdict({ affectedObservations: [] })
      expect(engine.generateProposal(verdict, 'ev-1')).toBeNull()
    })

    it('creates proposal with strengthen actions for confirms', () => {
      const verdict = makeVerdict({ impactType: 'confirms' })
      const proposal = engine.generateProposal(verdict, 'ev-1')

      expect(proposal).not.toBeNull()
      expect(proposal!.actions).toHaveLength(1)
      expect(proposal!.actions[0].type).toBe('strengthen')
      expect(proposal!.actions[0].targetObservationId).toBe('obs-1')
      // createBubble was called to store the proposal
      expect(mockCreateBubble).toHaveBeenCalled()
      const bubbleInput = mockCreateBubble.mock.calls[0][0]
      expect(bubbleInput.tags).toContain('internalization-proposal')
    })

    it('generates cascade for weaken actions', () => {
      insertObservation('obs-1', { confidence: 0.5 })
      insertObservation('dep-obs', { confidence: 0.4 })
      insertLink('dep-obs', 'obs-1')

      const verdict = makeVerdict({
        impactType: 'contradicts',
        affectedObservations: [{ observationId: 'obs-1', relationship: 'weakens', delta: -0.25 }],
      })
      const proposal = engine.generateProposal(verdict, 'ev-1')

      expect(proposal).not.toBeNull()
      // First action should be weaken
      expect(proposal!.actions[0].type).toBe('weaken')
      // Should have cascade result
      expect(proposal!.cascadeResult).not.toBeNull()
    })
  })

  describe('verdictToActions', () => {
    it('confirms → strengthen with strengthening trend', () => {
      const verdict = makeVerdict({ impactType: 'confirms' })
      const actions = (engine as any).verdictToActions(verdict, 'ev-1')
      expect(actions).toHaveLength(1)
      expect(actions[0].type).toBe('strengthen')
      expect(actions[0].trendTransition).toBe('strengthening')
    })

    it('contradicts → weaken with weakening trend', () => {
      const verdict = makeVerdict({ impactType: 'contradicts' })
      const actions = (engine as any).verdictToActions(verdict, 'ev-1')
      expect(actions[0].type).toBe('weaken')
      expect(actions[0].trendTransition).toBe('weakening')
      expect(actions[0].confidenceDelta).toBe(0.15) // delta positive, applied as negative in applyAction
    })

    it('extends → merge_evidence', () => {
      const verdict = makeVerdict({ impactType: 'extends' })
      const actions = (engine as any).verdictToActions(verdict, 'ev-1')
      expect(actions[0].type).toBe('merge_evidence')
    })

    it('refines → merge_evidence', () => {
      const verdict = makeVerdict({ impactType: 'refines' })
      const actions = (engine as any).verdictToActions(verdict, 'ev-1')
      expect(actions[0].type).toBe('merge_evidence')
    })

    it('diminishing returns when evidenceCount > 5', () => {
      insertObservation('obs-high', {
        confidence: 0.8,
        metadata: { evidenceCount: 10, trend: 'strengthening' },
      })
      const verdict = makeVerdict({
        affectedObservations: [{ observationId: 'obs-high', relationship: 'strengthens', delta: 0.2 }],
      })
      const actions = (engine as any).verdictToActions(verdict, 'ev-1')
      // delta should be halved due to diminishing returns
      expect(actions[0].confidenceDelta).toBeCloseTo(0.1, 5)
    })
  })

  describe('applyAction', () => {
    it('strengthen updates confidence and decayRate, adds link, emits event', () => {
      insertObservation('obs-1', { confidence: 0.5, metadata: { trend: 'stable', evidenceCount: 3 } })
      engine.setEventBus(makeEventBus())

      const action = { type: 'strengthen' as const, targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: 0.2, trendTransition: 'strengthening' as const, reason: 'test' }
      ;(engine as any).applyAction(action, 'test-chain', 'user-1')

      expect(mockUpdateBubble).toHaveBeenCalled()
      const [id, updates] = mockUpdateBubble.mock.calls[0]
      expect(id).toBe('obs-1')
      expect(updates.confidence).toBe(0.7) // 0.5 + 0.2
      expect(updates.decayRate).toBeCloseTo(0.09, 3) // 0.1 * 0.9
      // addLink was called
      expect(mockAddLink).toHaveBeenCalledWith('obs-1', 'ev-1', 'evidence_for', 0.8, 'system')
      // event emitted
      expect((engine as any).eventBus.emitFireAndForget).toHaveBeenCalled()
    })

    it('weaken decreases confidence and increases decayRate', () => {
      insertObservation('obs-1', { confidence: 0.6, metadata: { trend: 'stable', evidenceCount: 2 } })
      engine.setEventBus(makeEventBus())

      const action = { type: 'weaken' as const, targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.3, trendTransition: 'weakening' as const, reason: 'test' }
      ;(engine as any).applyAction(action, 'test-chain', 'user-1')

      expect(mockUpdateBubble).toHaveBeenCalled()
      const [id, updates] = mockUpdateBubble.mock.calls[0]
      expect(id).toBe('obs-1')
      expect(updates.confidence).toBe(0.3) // 0.6 - 0.3
      expect(updates.decayRate).toBeCloseTo(0.13, 2) // 0.1 * 1.3
      // contradiction link
      expect(mockAddLink).toHaveBeenCalledWith('ev-1', 'obs-1', 'contradicts', 0.7, 'system')
    })

    it('kill sets confidence to 0 and records killedAt', () => {
      insertObservation('obs-1', { confidence: 0.5, metadata: { trend: 'stable', evidenceCount: 1 } })
      engine.setEventBus(makeEventBus())

      const action = { type: 'kill' as const, targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.5, trendTransition: undefined, reason: 'disproved' }
      ;(engine as any).applyAction(action, 'test-chain', 'user-1')

      expect(mockUpdateBubble).toHaveBeenCalled()
      const [id, updates] = mockUpdateBubble.mock.calls[0]
      expect(id).toBe('obs-1')
      expect(updates.confidence).toBe(0)
      expect(updates.decayRate).toBe(0.25)
      expect(updates.metadata.killedAt).toBeGreaterThan(0)
      expect(updates.metadata.killedBy).toBe('ev-1')
    })

    it('skips non-existent observation gracefully', () => {
      const action = { type: 'strengthen' as const, targetObservationId: 'nonexistent', evidenceBubbleId: 'ev-1', confidenceDelta: 0.1, trendTransition: 'strengthening' as const, reason: 'test' }
      // Should not throw
      expect(() => (engine as any).applyAction(action, 'test-chain', 'user-1')).not.toThrow()
      expect(mockUpdateBubble).not.toHaveBeenCalled()
    })
  })

  describe('executeProposal', () => {
    it('applies all actions from an approved proposal', async () => {
      insertObservation('obs-1', { confidence: 0.5, metadata: { trend: 'stable', evidenceCount: 2 } })
      engine.setEventBus(makeEventBus())
      engine.setOrientationGraph(makeOrientGraph())

      const proposal: InternalizationProposal = {
        id: 'prop_test',
        verdict: makeVerdict(),
        actions: [{ type: 'strengthen', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: 0.2, trendTransition: 'strengthening', reason: 'test' }],
        cascadeResult: null,
        status: 'pending',
        createdAt: Date.now(),
      }

      const result = await engine.executeProposal(proposal, 'user-1')
      expect(result).toBe(true)
      // Action was applied
      expect(mockUpdateBubble).toHaveBeenCalled()
    })

    it('applies cascaded actions when present', async () => {
      insertObservation('obs-1', { confidence: 0.5 })
      insertObservation('cascaded-obs', { confidence: 0.4 })
      engine.setEventBus(makeEventBus())
      engine.setOrientationGraph(makeOrientGraph())

      const proposal: InternalizationProposal = {
        id: 'prop_cascade',
        verdict: makeVerdict({ impactType: 'contradicts', affectedObservations: [{ observationId: 'obs-1', relationship: 'weakens', delta: -0.3 }] }),
        actions: [{ type: 'weaken', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.3, trendTransition: 'weakening', reason: 'test' }],
        cascadeResult: {
          primaryChange: { type: 'weaken', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.3, trendTransition: 'weakening', reason: 'test' },
          cascadedChanges: [{ type: 'weaken', targetObservationId: 'cascaded-obs', evidenceBubbleId: 'ev-1', confidenceDelta: -0.15, trendTransition: 'weakening', reason: '[cascade] dependency' }],
          newGaps: [{ domain: '测试', suggestedQueries: ['查询'] }],
          requiresApproval: false,
        },
        status: 'pending',
        createdAt: Date.now(),
      }

      const result = await engine.executeProposal(proposal, 'user-1')
      expect(result).toBe(true)
      // Both primary and cascaded actions applied → updateBubble called twice
      expect(mockUpdateBubble).toHaveBeenCalledTimes(2)
    })

    it('returns false on error', async () => {
      insertObservation('obs-1', { confidence: 0.5, metadata: { trend: 'stable', evidenceCount: 2 } })

      const proposal: InternalizationProposal = {
        id: 'prop_fail',
        verdict: makeVerdict(),
        actions: [{ type: 'strengthen' as const, targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: 0.2, trendTransition: 'strengthening', reason: 'test' }],
        cascadeResult: null,
        status: 'pending',
        createdAt: Date.now(),
      }

      // Make updateBubble throw
      mockUpdateBubble.mockImplementationOnce(() => { throw new Error('DB error') })

      const result = await engine.executeProposal(proposal, 'user-1')
      expect(result).toBe(false)
    })
  })

  describe('rejectProposal', () => {
    it('updates proposal bubble status to rejected', () => {
      const db = getDatabase()
      // Insert a proposal bubble into DB (as createBubble would have done)
      const proposalId = 'prop_rej_1'
      db.prepare(`
        INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'reject-bubble', 'event', '提案', '{}',
        JSON.stringify({ proposalId, status: 'pending' }),
        JSON.stringify(['internalization-proposal']),
        'cognition-engine', 0.7, 0.1, 0,
        Date.now(), Date.now(), Date.now(),
        'space-1', 0, 'summary',
      )

      engine.setOrientationGraph(makeOrientGraph())
      engine.rejectProposal(proposalId)

      // Check the bubble metadata was updated to 'rejected'
      const updated = db.prepare('SELECT metadata FROM bubbles WHERE id = ?').get('reject-bubble') as { metadata: string }
      const meta = JSON.parse(updated.metadata)
      expect(meta.status).toBe('rejected')
    })
  })

  describe('simulateCascade', () => {
    it('returns empty cascade for non-weaken/kill actions', () => {
      const action = { type: 'strengthen' as const, targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: 0.2, trendTransition: 'strengthening', reason: 'test' }
      const result = (engine as any).simulateCascade(action)
      expect(result.cascadedChanges).toHaveLength(0)
    })

    it('cascades to dependent observations with dampening', () => {
      insertObservation('obs-parent', { confidence: 0.5 })
      insertObservation('obs-child', { confidence: 0.4 })
      insertLink('obs-child', 'obs-parent')

      const action = { type: 'weaken' as const, targetObservationId: 'obs-parent', evidenceBubbleId: 'ev-1', confidenceDelta: -0.3, trendTransition: 'weakening', reason: 'test' }
      const result = (engine as any).simulateCascade(action)

      // obs-parent is weakened to 0.5 - 0.3 = 0.2
      // Cascade: delta -0.3 * 0.5 = -0.15 → obs-child confidence would be 0.4 - 0.15 = 0.25
      // Since 0.25 < 0.3 → weaken action created for child
      expect(result.cascadedChanges.length).toBeGreaterThanOrEqual(1)
      expect(result.cascadedChanges[0].targetObservationId).toBe('obs-child')
    })
  })

  describe('formatApprovalMessage', () => {
    it('formats message with action summary', () => {
      const proposal: InternalizationProposal = {
        id: 'prop_msg',
        verdict: makeVerdict({ causalChain: '价格趋势分析' }),
        actions: [
          { type: 'strengthen', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: 0.15, trendTransition: 'strengthening', reason: '价格与历史一致' },
        ],
        cascadeResult: null,
        status: 'pending',
        createdAt: Date.now(),
      }

      const msg = engine.formatApprovalMessage(proposal)
      expect(msg).toContain('价格趋势分析')
      expect(msg).toContain('strengthen')
      expect(msg).toContain('+0.15')
      expect(msg).toContain('approve')
      expect(msg).toContain('reject')
    })

    it('includes cascade count when present', () => {
      const proposal: InternalizationProposal = {
        id: 'prop_msg2',
        verdict: makeVerdict(),
        actions: [{ type: 'weaken', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.2, trendTransition: 'weakening', reason: '矛盾' }],
        cascadeResult: {
          primaryChange: { type: 'weaken', targetObservationId: 'obs-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.2, trendTransition: 'weakening', reason: '矛盾' },
          cascadedChanges: [{ type: 'weaken', targetObservationId: 'dep-1', evidenceBubbleId: 'ev-1', confidenceDelta: -0.1, trendTransition: 'weakening', reason: '[cascade]' }],
          newGaps: [],
          requiresApproval: false,
        },
        status: 'pending',
        createdAt: Date.now(),
      }

      const msg = engine.formatApprovalMessage(proposal)
      expect(msg).toContain('级联影响')
      expect(msg).toContain('1 个下游观察')
    })
  })
})
