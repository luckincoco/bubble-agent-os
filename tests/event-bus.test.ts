import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/event/event-bus.js'
import type { BubbleEventData } from '../src/event/event-types.js'
import type { EmitOptions } from '../src/event/event-bus.js'

const testEvent: BubbleEventData = {
  type: 'memory.bubble.created',
  payload: { bubbleId: 'b1', bubbleType: 'observation', source: 'test', title: '测试' },
}

const testOptions: EmitOptions = { actor: 'tester', spaceId: 's1', metadata: {} }

const anotherEvent: BubbleEventData = {
  type: 'memory.bubble.invalidated',
  payload: { bubbleId: 'b1', reason: 'test', validUntil: 0 },
}

function collectEmitted(): { events: BubbleEventData[]; options: EmitOptions[] } {
  const events: BubbleEventData[] = []
  const options: EmitOptions[] = []
  const listener = (e: BubbleEventData, o: EmitOptions) => { events.push(e); options.push(o) }
  return { events, options, listener }
}

describe('EventBus — on / emit', () => {
  it('订阅后 emit 收到事件', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.on('memory.bubble.created', listener)
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('memory.bubble.created')
    expect(events[0].payload).toMatchObject({ bubbleId: 'b1' })
  })

  it('emit 传递 EmitOptions', async () => {
    const bus = new EventBus()
    const { options, listener } = collectEmitted()
    bus.on('memory.bubble.created', listener)
    await bus.emit(testEvent, testOptions)
    expect(options[0].actor).toBe('tester')
    expect(options[0].spaceId).toBe('s1')
  })

  it('多个监听器都收到事件', async () => {
    const bus = new EventBus()
    const events1: BubbleEventData[] = []
    const events2: BubbleEventData[] = []
    bus.on('memory.bubble.created', (e) => { events1.push(e) })
    bus.on('memory.bubble.created', (e) => { events2.push(e) })
    await bus.emit(testEvent, testOptions)
    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
  })

  it('未订阅的类型不触发', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.on('memory.bubble.created', listener)
    await bus.emit(anotherEvent, testOptions)
    expect(events).toHaveLength(0)
  })
})

describe('EventBus — unsubscribe', () => {
  it('取消订阅后不再收到事件', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    const unsub = bus.on('memory.bubble.created', listener)
    unsub()
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(0)
  })

  it('多次取消不报错', async () => {
    const bus = new EventBus()
    const { listener } = collectEmitted()
    const unsub = bus.on('memory.bubble.created', listener)
    unsub()
    expect(() => unsub()).not.toThrow()
  })
})

describe('EventBus — 数组类型订阅', () => {
  it('一次订阅多个类型', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.on(['memory.bubble.created', 'memory.bubble.invalidated'], listener)
    await bus.emit(testEvent, testOptions)
    await bus.emit(anotherEvent, testOptions)
    expect(events).toHaveLength(2)
  })

  it('取消订阅移除所有类型', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    const unsub = bus.on(['memory.bubble.created', 'memory.bubble.invalidated'], listener)
    unsub()
    await bus.emit(testEvent, testOptions)
    await bus.emit(anotherEvent, testOptions)
    expect(events).toHaveLength(0)
  })
})

describe('EventBus — onPrefix 通配符', () => {
  it('前缀匹配触发', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.onPrefix('memory', listener)
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(1)
  })

  it('前缀不匹配不触发', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.onPrefix('biz', listener)
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(0)
  })

  it('取消订阅后不再触发', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    const unsub = bus.onPrefix('memory', listener)
    unsub()
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(0)
  })
})

describe('EventBus — onAll 全局监听', () => {
  it('收到所有事件类型', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.onAll(listener)
    await bus.emit(testEvent, testOptions)
    await bus.emit(anotherEvent, testOptions)
    expect(events).toHaveLength(2)
  })

  it('取消订阅停止接收', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    const unsub = bus.onAll(listener)
    unsub()
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(0)
  })

  it('类型监听器和全局监听器都收到', async () => {
    const bus = new EventBus()
    const typed: BubbleEventData[] = []
    const global: BubbleEventData[] = []
    bus.on('memory.bubble.created', (e) => { typed.push(e) })
    bus.onAll((e) => { global.push(e) })
    await bus.emit(testEvent, testOptions)
    expect(typed).toHaveLength(1)
    expect(global).toHaveLength(1)
  })
})

describe('EventBus — 错误隔离', () => {
  it('一个监听器抛错不影响其他', async () => {
    const bus = new EventBus()
    const events: BubbleEventData[] = []
    bus.on('memory.bubble.created', () => { throw new Error('boom') })
    bus.on('memory.bubble.created', (e) => { events.push(e) })
    await expect(bus.emit(testEvent, testOptions)).resolves.toBeUndefined()
    expect(events).toHaveLength(1)
  })
})

describe('EventBus — listenerCount', () => {
  it('统计类型和全局监听器数量', async () => {
    const bus = new EventBus()
    const l1 = () => {}
    const l2 = () => {}
    bus.on('memory.bubble.created', l1)
    bus.on('memory.bubble.created', l2)
    bus.onAll(() => {})
    const count = bus.listenerCount()
    expect(count.typed).toBe(2)
    expect(count.global).toBe(1)
  })

  it('取消后计数减少', async () => {
    const bus = new EventBus()
    const l1 = () => {}
    const unsub = bus.on('memory.bubble.created', l1)
    expect(bus.listenerCount().typed).toBe(1)
    unsub()
    expect(bus.listenerCount().typed).toBe(0)
  })
})

describe('EventBus — clear', () => {
  it('清除所有监听器', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEmitted()
    bus.on('memory.bubble.created', listener)
    bus.onAll(listener)
    bus.clear()
    await bus.emit(testEvent, testOptions)
    expect(events).toHaveLength(0)
    expect(bus.listenerCount().typed).toBe(0)
    expect(bus.listenerCount().global).toBe(0)
  })
})

describe('EventBus — emitFireAndForget', () => {
  it('异步调用不阻塞', async () => {
    const bus = new EventBus()
    let called = false
    bus.on('memory.bubble.created', async () => {
      called = true
    })
    expect(() => bus.emitFireAndForget(testEvent, testOptions)).not.toThrow()
    await vi.waitFor(() => expect(called).toBe(true))
  })

  it('emitFireAndForget 错误被捕获', async () => {
    const bus = new EventBus()
    bus.on('memory.bubble.created', () => { throw new Error('async boom') })
    expect(() => bus.emitFireAndForget(testEvent, testOptions)).not.toThrow()
  })
})
