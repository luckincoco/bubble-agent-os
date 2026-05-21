import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/event/event-bus.js'
import { EventGate } from '../src/cognition/event-gate.js'
import type { BubbleEventData } from '../src/event/event-types.js'

/**
 * Helper: collect events emitted by EventBus for verification.
 */
function collectEvents(bus: EventBus): BubbleEventData[] {
  const events: BubbleEventData[] = []
  bus.onAll((event) => { events.push(event as BubbleEventData) })
  return events
}

describe('EventGate — insightScore 路由', () => {
  it('低分 insight 不触发 route（action = defer）', async () => {
    const bus = new EventBus()
    new EventGate(bus) // no orientationGraph
    const emitted = collectEvents(bus)

    bus.emitFireAndForget(
      {
        type: 'conversation.turn.completed',
        payload: { insightCount: 1, hasInsight: true, insightScore: 0.5, responseLength: 500, spaceId: 's1' },
      },
      { actor: 'system', spaceId: 's1', metadata: {} },
    )

    await vi.waitFor(() => {
      const gated = emitted.find(e => e.type === 'knowledge.event.gated') as BubbleEventData & { type: 'knowledge.event.gated' }
      expect(gated).toBeDefined()
      expect(gated.payload.action).toBe('defer')
    })
  })

  it('高分 insight 触发 route（action = route）', async () => {
    const bus = new EventBus()
    new EventGate(bus)
    const emitted = collectEvents(bus)

    bus.emitFireAndForget(
      {
        type: 'conversation.turn.completed',
        payload: { insightCount: 3, hasInsight: true, insightScore: 2.5, responseLength: 800, spaceId: 's1' },
      },
      { actor: 'system', spaceId: 's1', metadata: {} },
    )

    await vi.waitFor(() => {
      const gated = emitted.find(e => e.type === 'knowledge.event.gated') as BubbleEventData & { type: 'knowledge.event.gated' }
      expect(gated).toBeDefined()
      expect(gated.payload.action).toBe('route')
    })
  })

  it('insightCount = 0 时跳过，不发射 gated 事件', async () => {
    const bus = new EventBus()
    new EventGate(bus)
    const emitted = collectEvents(bus)

    bus.emitFireAndForget(
      {
        type: 'conversation.turn.completed',
        payload: { insightCount: 0, hasInsight: false, insightScore: 0, responseLength: 100, spaceId: 's1' },
      },
      { actor: 'system', spaceId: 's1', metadata: {} },
    )

    // 等待异步 listener 执行
    await vi.waitFor(() => {
      const gated = emitted.find(e => e.type === 'knowledge.event.gated')
      expect(gated).toBeUndefined()
    })
  })

  it('边界值：insightScore = 2.0 恰过阈值', async () => {
    const bus = new EventBus()
    new EventGate(bus)
    const emitted = collectEvents(bus)

    bus.emitFireAndForget(
      {
        type: 'conversation.turn.completed',
        payload: { insightCount: 2, hasInsight: true, insightScore: 2.0, responseLength: 600, spaceId: 's1' },
      },
      { actor: 'system', spaceId: 's1', metadata: {} },
    )

    await vi.waitFor(() => {
      const gated = emitted.find(e => e.type === 'knowledge.event.gated') as BubbleEventData & { type: 'knowledge.event.gated' }
      expect(gated).toBeDefined()
      expect(gated.payload.action).toBe('route')
      expect(gated.payload.insightScore).toBe(2.0)
    })
  })
})
