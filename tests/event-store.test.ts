import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventStore } from '../src/event/event-store.js'
import { EventBus } from '../src/event/event-bus.js'
import type { BubbleEventData } from '../src/event/event-types.js'

let tmpDir: string

const testEvent: BubbleEventData = {
  type: 'memory.bubble.created',
  payload: { bubbleId: 'b1', bubbleType: 'observation', source: 'test', title: '测试' },
}

const anotherEvent: BubbleEventData = {
  type: 'memory.bubble.invalidated',
  payload: { bubbleId: 'b1', reason: '过期', validUntil: Date.now() + 86400000 },
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-estore-'))
  initDatabase(tmpDir, 'test-password-123')
})

beforeEach(async () => {
  // 等待上一个测试的异步操作（如 emitFireAndForget）落地，再清空
  await new Promise(r => setTimeout(r, 20))
  // 每个测试前清空 events 表，避免跨测试状态污染
  const db = getDatabase()
  db.prepare('DELETE FROM events').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('EventStore — init', () => {
  it('空库初始化创建 genesis 事件', () => {
    const store = new EventStore()
    store.init()
    expect(store.count()).toBe(1)
    const recent = store.getRecent(1)
    expect(recent[0].type).toBe('system.genesis')
  })

  it('重复 init 不创建重复 genesis', () => {
    const store = new EventStore()
    store.init()
    store.init()
    expect(store.count()).toBe(1)
  })
})

describe('EventStore — append', () => {
  it('追加事件产生 hash', () => {
    const store = new EventStore()
    const stored = store.append({ event: testEvent, actor: 'tester', spaceId: 's1' })
    expect(stored.id).toBeTruthy()
    expect(stored.hash).toBeTruthy()
    expect(stored.type).toBe('memory.bubble.created')
    expect(stored.actor).toBe('tester')
  })

  it('连续追加形成 hash 链', () => {
    const store = new EventStore()
    const e1 = store.append({ event: testEvent, actor: 'tester' })
    const e2 = store.append({ event: anotherEvent, actor: 'tester' })
    expect(e2.prevHash).toBe(e1.hash)
  })

  it('不同 payload 产生不同 hash', () => {
    const store = new EventStore()
    const e1 = store.append({ event: testEvent, actor: 'tester' })
    const modified = { ...testEvent, payload: { ...testEvent.payload, title: '不同标题' } }
    const e2 = store.append({ event: modified, actor: 'tester' })
    expect(e1.hash).not.toBe(e2.hash)
  })
})

describe('EventStore — 查询', () => {
  it('getEventsByType 精确匹配', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    store.append({ event: anotherEvent, actor: 'tester' })
    const results = store.getEventsByType('memory.bubble.created')
    expect(results.length).toBe(1) // genesis + 1 matching
    expect(results[0].type).toBe('memory.bubble.created')
  })

  it('getEventsByType 前缀匹配', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    const results = store.getEventsByType('memory.*')
    expect(results.length).toBe(1)
    expect(results.every(e => e.type.startsWith('memory'))).toBe(true)
  })

  it('getEventsByType 时间范围过滤', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    const now = Date.now()
    const results = store.getEventsByType('memory.*', { since: now - 60000, until: now + 60000 })
    expect(results.length).toBe(1)
  })

  it('getEventsSince 返回指定 ID 之后的事件', async () => {
    const store = new EventStore()
    const e1 = store.append({ event: testEvent, actor: 'tester' })
    // 5ms delay ensures ULID timestamp ordering (same-millisecond ULID random suffix may not sort lexicographically)
    await new Promise(r => setTimeout(r, 5))
    store.append({ event: anotherEvent, actor: 'tester' })
    const results = store.getEventsSince(e1.id)
    expect(results.length).toBe(1)
    expect(results[0].id).not.toBe(e1.id)
  })

  it('getRecent 返回最近事件且按时间倒序', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    store.append({ event: anotherEvent, actor: 'tester' })
    const recent = store.getRecent(5)
    // genesis + 2 appended events = 3 total
    expect(recent.length).toBe(3)
    for (let i = 1; i < recent.length; i++) {
      expect(recent[i].timestamp).toBeLessThanOrEqual(recent[i - 1].timestamp)
    }
  })
})

describe('EventStore — verifyChain 完整性', () => {
  it('完整链验证通过', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    store.append({ event: anotherEvent, actor: 'tester' })
    const result = store.verifyChain()
    expect(result.valid).toBe(true)
  })

  it('篡改 payload 后检测到断裂', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    const stored = store.append({ event: anotherEvent, actor: 'tester' })

    const db = getDatabase()
    db.prepare("UPDATE events SET payload = 'hacked' WHERE id = ?").run(stored.id)

    const result = store.verifyChain()
    expect(result.valid).toBe(false)
    expect(result.brokenAt).toBe(stored.id)
  })

  it('篡改 prevHash 后检测到链断裂', () => {
    const store = new EventStore()
    store.append({ event: testEvent, actor: 'tester' })
    const stored = store.append({ event: anotherEvent, actor: 'tester' })

    const db = getDatabase()
    db.prepare("UPDATE events SET prev_hash = 'badhash' WHERE id = ?").run(stored.id)

    const result = store.verifyChain()
    expect(result.valid).toBe(false)
  })
})

describe('EventStore — subscribeToEventBus', () => {
  it('EventBus 事件自动持久化', async () => {
    const bus = new EventBus()
    const store = new EventStore()
    const unsub = store.subscribeToEventBus(bus)

    bus.emitFireAndForget(testEvent, { actor: 'tester', spaceId: 's1', metadata: {} })
    bus.emitFireAndForget(anotherEvent, { actor: 'tester', spaceId: 's1', metadata: {} })

    await new Promise(r => setTimeout(r, 100))
    // genesis(1) + 2 events = 3
    expect(store.count()).toBe(3)
    unsub()
  })

  it('取消订阅后事件不再持久化', async () => {
    const bus = new EventBus()
    const store = new EventStore()
    const unsub = store.subscribeToEventBus(bus)
    unsub()

    bus.emitFireAndForget(testEvent, { actor: 'tester', spaceId: 's1', metadata: {} })
    await new Promise(r => setTimeout(r, 100))
    // store never initialized (no append called) → 0 events
    expect(store.count()).toBe(0)
  })
})
