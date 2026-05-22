import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Module mocks (before any imports) ──────────────────────

const mockRecordActivation = vi.fn()
const mockShouldSuppress = vi.fn()
const mockRecordEmission = vi.fn()
const mockRecordAcknowledgement = vi.fn()
const mockFindMatchingPaths = vi.fn()

vi.mock('../src/memory/resonance/resonance-tracker.js', () => ({
  ResonanceTracker: vi.fn().mockImplementation(function () {
    return {
      recordActivation: mockRecordActivation,
      shouldSuppress: mockShouldSuppress,
      recordEmission: mockRecordEmission,
      recordAcknowledgement: mockRecordAcknowledgement,
      findMatchingPaths: mockFindMatchingPaths,
    }
  }),
  generateSignatureHash: (content: string, _type?: string) => `hash_${content.slice(0, 8)}`,
}))

const mockDbGet = vi.fn()
vi.mock('../src/storage/database.js', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => ({
      get: mockDbGet,
    }),
  }),
}))

import { ResonanceIntegration } from '../src/memory/resonance/resonance-integration.js'
import type { EventBus, EmitOptions } from '../src/event/event-bus.js'
import type { BubbleEventData } from '../src/event/event-types.js'

// ── Helpers ────────────────────────────────────────────────

function mockBus(): { bus: EventBus; handlers: Record<string, vi.Mock>; on: vi.Mock } {
  const handlers: Record<string, vi.Mock> = {}
  const on = vi.fn((type: string, handler: any) => {
    handlers[type] = handler
    return vi.fn() // unsubscriber
  })
  return { bus: { on, emitFireAndForget: vi.fn() } as any, handlers, on }
}

function makeEvent(type: string, payload: any): BubbleEventData {
  return { type, payload } as any as BubbleEventData
}

function makeOptions(overrides: Partial<EmitOptions> = {}): EmitOptions {
  return { actor: 'test', spaceId: 'space-1', metadata: {}, ...overrides } as EmitOptions
}

// ── subscribeTo ─────────────────────────────────────────────

describe('subscribeTo', () => {
  let integration: ResonanceIntegration
  let bus: EventBus
  let handlers: Record<string, vi.Mock>
  let on: vi.Mock

  beforeEach(() => {
    vi.clearAllMocks()
    const ctx = mockBus()
    bus = ctx.bus
    handlers = ctx.handlers
    on = ctx.on
    integration = new ResonanceIntegration()
  })

  afterEach(() => {
    integration.destroy()
  })

  it('subscribes to 3 event types', () => {
    integration.subscribeTo(bus)
    expect(on).toHaveBeenCalledTimes(3)
    const types = on.mock.calls.map(c => c[0])
    expect(types).toContain('memory.observation.discovered')
    expect(types).toContain('memory.compaction.completed')
    expect(types).toContain('knowledge.concept.forged')
  })

  it('memory.observation.discovered calls recordActivation', () => {
    integration.subscribeTo(bus)
    handlers['memory.observation.discovered'](
      makeEvent('memory.observation.discovered', { observationId: 'obs-1', title: '新发现' }),
      makeOptions(),
    )

    expect(mockRecordActivation).toHaveBeenCalledWith({
      triggerContext: '新发现',
      observationIds: ['obs-1'],
      spaceId: 'space-1',
    })
  })

  it('memory.compaction.completed calls recordActivation with synthesis title', () => {
    mockDbGet.mockReturnValue({ title: '合成标题' })
    integration.subscribeTo(bus)
    handlers['memory.compaction.completed'](
      makeEvent('memory.compaction.completed', { synthesisId: 'syn-1', sourceIds: ['obs-1', 'obs-2'] }),
      makeOptions(),
    )

    expect(mockDbGet).toHaveBeenCalled()
    expect(mockRecordActivation).toHaveBeenCalledWith({
      triggerContext: '合成标题',
      observationIds: ['obs-1', 'obs-2'],
      spaceId: 'space-1',
    })
  })

  it('memory.compaction.completed skips when synthesis not in DB', () => {
    mockDbGet.mockReturnValue(undefined)
    integration.subscribeTo(bus)
    handlers['memory.compaction.completed'](
      makeEvent('memory.compaction.completed', { synthesisId: 'missing', sourceIds: [] }),
      makeOptions(),
    )

    expect(mockRecordActivation).not.toHaveBeenCalled()
  })

  it('knowledge.concept.forged calls recordActivation with 模式发现 type', () => {
    integration.subscribeTo(bus)
    handlers['knowledge.concept.forged'](
      makeEvent('knowledge.concept.forged', { conceptId: 'c-1', name: '新概念', sourceNodes: ['obs-1'] }),
      makeOptions(),
    )

    expect(mockRecordActivation).toHaveBeenCalledWith({
      triggerContext: '新概念',
      observationIds: ['obs-1'],
      structureType: '模式发现',
      spaceId: 'space-1',
    })
  })

  it('ignores wrong event types', () => {
    integration.subscribeTo(bus)
    const event = makeEvent('some.other.event', {})
    // Should not throw
    handlers['memory.observation.discovered'](event, makeOptions())
    // No type check failure
  })
})

// ── Delegation methods ─────────────────────────────────────

describe('delegation methods', () => {
  let integration: ResonanceIntegration

  beforeEach(() => {
    vi.clearAllMocks()
    integration = new ResonanceIntegration()
  })

  afterEach(() => {
    integration.destroy()
  })

  it('shouldEmitPattern delegates to tracker.shouldSuppress (inverted)', () => {
    mockShouldSuppress.mockReturnValue(true)
    const result = integration.shouldEmitPattern('测试内容')
    expect(mockShouldSuppress).toHaveBeenCalledWith('hash_测试内容')
    // shouldEmitPattern returns !shouldSuppress (negation)
    expect(result).toBe(false)
  })

  it('recordPatternEmission delegates to tracker.recordEmission', () => {
    integration.recordPatternEmission('测试内容')
    expect(mockRecordEmission).toHaveBeenCalledWith('hash_测试内容')
  })

  it('recordUserAcknowledgement delegates to tracker.recordAcknowledgement', () => {
    integration.recordUserAcknowledgement('测试内容')
    expect(mockRecordAcknowledgement).toHaveBeenCalledWith('hash_测试内容')
  })

  it('findResonantPaths delegates to tracker.findMatchingPaths', () => {
    mockFindMatchingPaths.mockReturnValue([])
    const result = integration.findResonantPaths('上下文', 'space-1')
    expect(mockFindMatchingPaths).toHaveBeenCalledWith('上下文', 'space-1')
    expect(result).toEqual([])
  })
})

// ── destroy ─────────────────────────────────────────────────

describe('destroy', () => {
  it('unsubscribes all registered handlers', () => {
    const unsub1 = vi.fn()
    const unsub2 = vi.fn()
    const unsub3 = vi.fn()
    const bus = { on: vi.fn().mockReturnValueOnce(unsub1).mockReturnValueOnce(unsub2).mockReturnValueOnce(unsub3) } as any

    const integration = new ResonanceIntegration()
    integration.subscribeTo(bus)
    integration.destroy()

    expect(unsub1).toHaveBeenCalled()
    expect(unsub2).toHaveBeenCalled()
    expect(unsub3).toHaveBeenCalled()
  })

  it('double destroy does not throw', () => {
    const bus = { on: vi.fn().mockReturnValue(vi.fn()) } as any
    const integration = new ResonanceIntegration()
    integration.subscribeTo(bus)
    integration.destroy()
    integration.destroy() // should not throw
  })
})
