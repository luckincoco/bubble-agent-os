import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkingMemory } from '../src/memory/working-memory.js'
import type { Bubble } from '../src/shared/types.js'
import { ulid } from 'ulid'

let tmpDir: string
let spaceId: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-wm-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM working_memory').run()
  db.prepare('DELETE FROM bubbles').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeBubble(id?: string): Bubble {
  return {
    id: id || ulid(),
    type: 'observation',
    title: '测试记忆',
    content: '这是一条测试记忆内容用于验证 working memory 功能',
    metadata: {},
    tags: [],
    embedding: undefined,
    source: 'test',
    confidence: 0.8,
    decayRate: 0.1,
    pinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessedAt: Date.now(),
    spaceId,
    abstractionLevel: 1,
    summary: null,
  }
}

// ── load ─────────────────────────────────────────────────────────

describe('load', () => {
  it('新 bubble 加载到 hot tier', () => {
    const wm = new WorkingMemory()
    const entry = wm.load('s1', makeBubble('b1'), { recency: 1.0, relevance: 0.8, confidence: 0.9, focusBoost: 0 })

    expect(entry.tier).toBe('hot')
    expect(entry.bubbleId).toBe('b1')
    expect(entry.sessionId).toBe('s1')
    expect(entry.pinned).toBe(false)
    expect(entry.tokenCost).toBeGreaterThan(0)

    const items = wm.getHotItems('s1')
    expect(items).toHaveLength(1)
    expect(items[0].bubbleId).toBe('b1')
  })

  it('已存在的 bubble 更新 tier 和 access 时间', () => {
    const wm = new WorkingMemory()
    const b = makeBubble('b1')
    wm.load('s1', b, { recency: 1.0, relevance: 0.8, confidence: 0.9, focusBoost: 0 })

    // Re-load with different factors
    const entry = wm.load('s1', b, { recency: 0.5, relevance: 0.5, confidence: 0.5, focusBoost: 0 })
    expect(entry.tier).toBe('hot')
    expect(entry.bubbleId).toBe('b1')

    // Should still be only 1 entry
    expect(wm.getHotItems('s1')).toHaveLength(1)
  })

  it('超出 budget 时触发自动腾退', () => {
    const wm = new WorkingMemory(300) // tiny budget
    const b1 = makeBubble('b1')
    const b2 = makeBubble('b2')
    const big = makeBubble('big')
    // Make big bubble content very long so it takes lots of tokens
    const bigContent = { ...big, content: '大数据内容 '.repeat(200) }

    // Fill budget with b1, b2
    wm.load('s1', b1, { recency: 0.1, relevance: 0.1, confidence: 0.1, focusBoost: 0 })
    wm.load('s1', b2, { recency: 0.1, relevance: 0.1, confidence: 0.1, focusBoost: 0 })

    // Load big bubble — should trigger eviction of lower-priority items
    wm.load('s1', bigContent, { recency: 1.0, relevance: 1.0, confidence: 1.0, focusBoost: 0.15 })

    // At least the high-priority big bubble should be in hot
    const items = wm.getHotItems('s1')
    expect(items.some(i => i.bubbleId === 'big')).toBe(true)
  })

  it('不同 session 隔离', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.load('s2', makeBubble('b2'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })

    expect(wm.getHotItems('s1')).toHaveLength(1)
    expect(wm.getHotItems('s2')).toHaveLength(1)
    expect(wm.getHotItems('s3')).toHaveLength(0)
  })
})

// ── evict ────────────────────────────────────────────────────────

describe('evict', () => {
  it('删除 working memory 中的条目', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.evict('s1', 'b1')
    expect(wm.getHotItems('s1')).toHaveLength(0)
  })

  it('pinned 条目无法 evict', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.pin('s1', 'b1')
    wm.evict('s1', 'b1')
    expect(wm.getHotItems('s1')).toHaveLength(1)
  })

  it('不存在的条目不报错', () => {
    const wm = new WorkingMemory()
    expect(() => wm.evict('s1', 'ghost')).not.toThrow()
  })
})

// ── pin / unpin ─────────────────────────────────────────────────

describe('pin / unpin', () => {
  it('pin 更新标志并提升优先级', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.pin('s1', 'b1')

    const items = wm.getHotItems('s1')
    expect(items[0].pinned).toBe(true)
  })

  it('unpin 恢复', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.pin('s1', 'b1')
    wm.unpin('s1', 'b1')

    const items = wm.getHotItems('s1')
    expect(items[0].pinned).toBe(false)
  })
})

// ── getHotItems / getAllItems ─────────────────────────────────────

describe('getHotItems / getAllItems', () => {
  it('getHotItems 按优先级降序', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 0.1, relevance: 0.1, confidence: 0.1, focusBoost: 0 })
    wm.load('s1', makeBubble('b2'), { recency: 1.0, relevance: 1.0, confidence: 1.0, focusBoost: 0.15 })

    const items = wm.getHotItems('s1')
    expect(items).toHaveLength(2)
    expect(items[0].bubbleId).toBe('b2') // higher priority first
    expect(items[1].bubbleId).toBe('b1')
  })
})

// ── getStatus ────────────────────────────────────────────────────

describe('getStatus', () => {
  it('返回正确的计数和 token 使用量', () => {
    const wm = new WorkingMemory(5000)
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })

    const status = wm.getStatus('s1')
    expect(status.hotCount).toBe(1)
    expect(status.hotTokens).toBeGreaterThan(0)
    expect(status.budgetTotal).toBe(5000)
    expect(status.budgetUsed).toBeGreaterThan(0)
    expect(status.warmCount).toBe(0)
    expect(status.coldCount).toBe(0)
  })
})

// ── touch ────────────────────────────────────────────────────────

describe('touch', () => {
  it('更新 last_accessed 时间', async () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    await new Promise(r => setTimeout(r, 5))
    wm.touch('s1', 'b1')

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM working_memory WHERE session_id = ? AND bubble_id = ?').get('s1', 'b1') as Record<string, unknown>
    expect(row!.last_accessed).toBeGreaterThan(row!.loaded_at as number)
  })
})

// ── demoteStaleItems ─────────────────────────────────────────────

describe('demoteStaleItems', () => {
  it('超过 maxAge 的 hot 条目降级为 warm', async () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    await new Promise(r => setTimeout(r, 5))

    const demoted = wm.demoteStaleItems('s1', 1) // 1ms max age
    expect(demoted).toBe(1)

    const hot = wm.getHotItems('s1')
    expect(hot).toHaveLength(0)

    const all = wm.getAllItems('s1')
    expect(all[0].tier).toBe('warm')
  })

  it('pinned 条目不被降级', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.pin('s1', 'b1')
    const demoted = wm.demoteStaleItems('s1', 1)
    expect(demoted).toBe(0) // pinned items are not demoted
  })
})

// ── clearSession / cleanupExpiredSessions ────────────────────────

describe('clearSession / cleanupExpiredSessions', () => {
  it('clearSession 删除指定 session', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })
    wm.clearSession('s1')
    expect(wm.getHotItems('s1')).toHaveLength(0)
  })

  it('cleanupExpiredSessions 移除过期条目', () => {
    const wm = new WorkingMemory()
    wm.load('s1', makeBubble('b1'), { recency: 1, relevance: 1, confidence: 1, focusBoost: 0 })

    // Manually set loaded_at to very old
    const db = getDatabase()
    db.prepare('UPDATE working_memory SET loaded_at = 1000').run()

    const cleaned = wm.cleanupExpiredSessions()
    expect(cleaned).toBe(1)
    expect(wm.getHotItems('s1')).toHaveLength(0)
  })
})
