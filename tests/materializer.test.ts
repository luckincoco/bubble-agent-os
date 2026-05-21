import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/event/event-bus.js'
import { Materializer } from '../src/event/materializer.js'
import type { BubbleEventData } from '../src/event/event-types.js'
import type { EmitOptions } from '../src/event/event-bus.js'

const testEvent: BubbleEventData = {
  type: 'memory.bubble.created',
  payload: { bubbleId: 'b1', bubbleType: 'observation', source: 'test', title: '测试' },
}

const anotherEvent: BubbleEventData = {
  type: 'memory.bubble.invalidated',
  payload: { bubbleId: 'b1', reason: 'test', validUntil: 0 },
}

const bizEvent: BubbleEventData = {
  type: 'biz.purchase.created',
  payload: { purchaseId: 'p1', supplierId: 's1', productId: 'pr1', tonnage: 100, unitPrice: 50, totalAmount: 5000 },
}

const testOptions: EmitOptions = { actor: 'tester', spaceId: 's1', metadata: {} }

describe('Materializer — register / materialize', () => {
  it('exact match handler is called with event and options', async () => {
    const mat = new Materializer()
    const handler = vi.fn()
    mat.register('memory.bubble.created', handler)

    await mat.materialize(testEvent, testOptions)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(testEvent, testOptions)
  })

  it('no handler registered — silently returns', async () => {
    const mat = new Materializer()
    await expect(mat.materialize(testEvent, testOptions)).resolves.toBeUndefined()
  })

  it('handler error is caught and does not throw', async () => {
    const mat = new Materializer()
    mat.register('memory.bubble.created', () => { throw new Error('handler boom') })

    await expect(mat.materialize(testEvent, testOptions)).resolves.toBeUndefined()
  })

  it('exact match takes priority over prefix match', async () => {
    const mat = new Materializer()
    const exactHandler = vi.fn()
    const prefixHandler = vi.fn()
    mat.register('memory.bubble.created', exactHandler)
    mat.registerPrefix('memory', prefixHandler)

    await mat.materialize(testEvent, testOptions)

    // Only exact handler should be called (early return)
    expect(exactHandler).toHaveBeenCalledTimes(1)
    expect(prefixHandler).not.toHaveBeenCalled()
  })
})

describe('Materializer — registerPrefix', () => {
  it('prefix handler is called for matching event type', async () => {
    const mat = new Materializer()
    const handler = vi.fn()
    mat.registerPrefix('memory', handler)

    await mat.materialize(testEvent, testOptions)

    expect(handler).toHaveBeenCalledWith(testEvent, testOptions)
  })

  it('prefix handler is NOT called for non-matching event type', async () => {
    const mat = new Materializer()
    const handler = vi.fn()
    mat.registerPrefix('memory', handler)

    await mat.materialize(bizEvent, testOptions)

    expect(handler).not.toHaveBeenCalled()
  })

  it('prefix handler error is caught and does not throw', async () => {
    const mat = new Materializer()
    mat.registerPrefix('memory', () => { throw new Error('prefix boom') })

    await expect(mat.materialize(testEvent, testOptions)).resolves.toBeUndefined()
  })
})

describe('Materializer — subscribeTo', () => {
  it('events flow from EventBus through materializer to handler', async () => {
    const bus = new EventBus()
    const mat = new Materializer()
    const handler = vi.fn()
    mat.register('memory.bubble.created', handler)
    mat.subscribeTo(bus)

    await bus.emit(testEvent, testOptions)

    expect(handler).toHaveBeenCalledWith(testEvent, testOptions)
  })

  it('unsubscribe stops event processing', async () => {
    const bus = new EventBus()
    const mat = new Materializer()
    const handler = vi.fn()
    mat.register('memory.bubble.created', handler)
    const unsub = mat.subscribeTo(bus)
    unsub()

    await bus.emit(testEvent, testOptions)

    expect(handler).not.toHaveBeenCalled()
  })
})

describe('Materializer — replay', () => {
  it('processes all events and returns count', async () => {
    const mat = new Materializer()
    const handler = vi.fn()
    mat.register('memory.bubble.created', handler)

    const result = await mat.replay([testEvent, testEvent], [testOptions, testOptions])

    expect(result.processed).toBe(2)
    expect(result.errors).toBe(0)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('events without handler are still counted as processed', async () => {
    const mat = new Materializer()
    // No handler registered for testEvent.type

    const result = await mat.replay([testEvent], [testOptions])

    // materialize catches errors internally, never throws — so replay always counts processed
    expect(result.processed).toBe(1)
    expect(result.errors).toBe(0)
  })
})

describe('Materializer — handlerCount', () => {
  it('returns correct count after register and registerPrefix', () => {
    const mat = new Materializer()
    expect(mat.handlerCount()).toBe(0)

    mat.register('memory.bubble.created', () => {})
    expect(mat.handlerCount()).toBe(1)

    mat.registerPrefix('memory', () => {})
    expect(mat.handlerCount()).toBe(2)

    mat.register('memory.bubble.invalidated', () => {})
    expect(mat.handlerCount()).toBe(3)
  })
})
