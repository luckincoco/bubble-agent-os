import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  createEpisode,
  getEpisodeById,
  queryEpisodes,
  getEpisodeThread,
  getRecentEpisodesByActor,
  countEpisodes,
  updateEpisodeSummary,
} from '../src/temporal/episode-store.js'
import type { CreateEpisodeInput, Episode } from '../src/temporal/episode-store.js'

let tmpDir: string

const sampleInput: CreateEpisodeInput = {
  type: 'conversation',
  source: 'feishu',
  actorId: 'user-1',
  spaceId: 'space-1',
  content: '今天钢材价格如何？',
  summary: '用户询问钢材价格',
  metadata: { channel: 'direct' },
  parentEpisodeId: undefined,
}

function sample(overrides: Partial<CreateEpisodeInput> = {}): CreateEpisodeInput {
  return { ...sampleInput, ...overrides }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-es-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM episodes').run()
})

// ── createEpisode ───────────────────────────────────────────

describe('createEpisode', () => {
  it('creates an episode with all fields', () => {
    const ep = createEpisode(sampleInput)

    expect(ep.id).toBeTruthy()
    expect(ep.type).toBe('conversation')
    expect(ep.source).toBe('feishu')
    expect(ep.actorId).toBe('user-1')
    expect(ep.spaceId).toBe('space-1')
    expect(ep.content).toBe('今天钢材价格如何？')
    expect(ep.summary).toBe('用户询问钢材价格')
    expect(ep.metadata).toEqual({ channel: 'direct' })
    expect(ep.parentEpisodeId).toBeNull()
    expect(ep.createdAt).toBeGreaterThan(0)
  })

  it('returns a valid ULID as id', () => {
    const ep = createEpisode(sample())
    // ULIDs are 26 characters, uppercase alphanumeric
    expect(ep.id).toMatch(/^[0-9A-Z]{26}$/)
  })

  it('sets default values for omitted optional fields', () => {
    const ep = createEpisode({
      type: 'system',
      source: 'scheduler',
      content: '定时任务执行',
    })

    expect(ep.actorId).toBeNull()
    expect(ep.spaceId).toBeNull()
    expect(ep.summary).toBeNull()
    expect(ep.metadata).toEqual({})
    expect(ep.parentEpisodeId).toBeNull()
  })

  it('writes to DB correctly', () => {
    const ep = createEpisode(sample())
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(ep.id) as any
    expect(row).toBeTruthy()
    expect(row.type).toBe('conversation')
    expect(row.content).toBe('今天钢材价格如何？')
  })

  it('multiple episodes have unique IDs', () => {
    const a = createEpisode(sample({ content: '第一条' }))
    const b = createEpisode(sample({ content: '第二条' }))
    expect(a.id).not.toBe(b.id)
  })

  it('stores parentEpisodeId when provided', () => {
    const parent = createEpisode(sample())
    const child = createEpisode(sample({
      content: '子回复',
      parentEpisodeId: parent.id,
    }))

    expect(child.parentEpisodeId).toBe(parent.id)
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM episodes WHERE id = ?').get(child.id) as any
    expect(row.parent_episode_id).toBe(parent.id)
  })
})

// ── getEpisodeById ──────────────────────────────────────────

describe('getEpisodeById', () => {
  it('returns episode when found', () => {
    const created = createEpisode(sample())
    const found = getEpisodeById(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.content).toBe(created.content)
  })

  it('returns null when not found', () => {
    const result = getEpisodeById('nonexistent-id')
    expect(result).toBeNull()
  })
})

// ── queryEpisodes ───────────────────────────────────────────

describe('queryEpisodes', () => {
  it('returns all episodes ordered by created_at DESC', () => {
    createEpisode(sample({ content: 'A' }))
    createEpisode(sample({ content: 'B' }))

    const results = queryEpisodes()
    expect(results).toHaveLength(2)
  })

  it('filters by type', () => {
    createEpisode(sample({ type: 'conversation', content: '对话' }))
    createEpisode(sample({ type: 'system', content: '系统事件' }))

    const results = queryEpisodes({ type: 'system' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('系统事件')
  })

  it('filters by source', () => {
    createEpisode(sample({ source: 'feishu', content: '飞书' }))
    createEpisode(sample({ source: 'wecom', content: '企微' }))

    const results = queryEpisodes({ source: 'wecom' })
    expect(results).toHaveLength(1)
    expect(results[0].content).toBe('企微')
  })

  it('filters by actorId', () => {
    createEpisode(sample({ actorId: 'user-1', content: '用户1' }))
    createEpisode(sample({ actorId: 'user-2', content: '用户2' }))

    const results = queryEpisodes({ actorId: 'user-1' })
    expect(results).toHaveLength(1)
  })

  it('filters by spaceId', () => {
    createEpisode(sample({ spaceId: 'space-1', content: '空间1' }))
    createEpisode(sample({ spaceId: 'space-2', content: '空间2' }))

    const results = queryEpisodes({ spaceId: 'space-1' })
    expect(results).toHaveLength(1)
  })

  it('filters by time range', () => {
    const now = Date.now()
    createEpisode(sample({ content: '旧消息' }))
    // Manually set old created_at
    const db = getDatabase()
    const oldId = createEpisode(sample({ content: '非常旧' })).id
    db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?').run(now - 100000, oldId)

    const results = queryEpisodes({ since: now - 50000 })
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.every(e => e.createdAt >= now - 50000)).toBe(true)
  })

  it('respects limit and offset', () => {
    for (let i = 0; i < 10; i++) createEpisode(sample({ content: `消息${i}` }))

    const page1 = queryEpisodes({ limit: 3, offset: 0 })
    expect(page1).toHaveLength(3)

    const page2 = queryEpisodes({ limit: 3, offset: 3 })
    expect(page2).toHaveLength(3)
    expect(page2[0].id).not.toBe(page1[0].id)
  })

  it('defaults to limit 100', () => {
    for (let i = 0; i < 150; i++) createEpisode(sample({ content: `消息${i}` }))

    const results = queryEpisodes()
    expect(results).toHaveLength(100)
  })
})

// ── getEpisodeThread ────────────────────────────────────────

describe('getEpisodeThread', () => {
  it('returns root + children', () => {
    const root = createEpisode(sample())
    const child = createEpisode(sample({ content: '子回复1', parentEpisodeId: root.id }))
    const child2 = createEpisode(sample({ content: '子回复2', parentEpisodeId: root.id }))

    const thread = getEpisodeThread(root.id)
    expect(thread).toHaveLength(3)
    expect(thread[0].id).toBe(root.id)
    const childIds = thread.slice(1).map(e => e.id).sort()
    expect(childIds).toEqual([child.id, child2.id].sort())
  })

  it('returns empty when root not found', () => {
    const thread = getEpisodeThread('nonexistent')
    expect(thread).toHaveLength(0)
  })

  it('respects limit on children', () => {
    const root = createEpisode(sample())
    for (let i = 0; i < 5; i++) {
      createEpisode(sample({ content: `子${i}`, parentEpisodeId: root.id }))
    }

    const thread = getEpisodeThread(root.id, 2)
    expect(thread).toHaveLength(3) // root + 2 children
  })
})

// ── getRecentEpisodesByActor ────────────────────────────────

describe('getRecentEpisodesByActor', () => {
  it('returns episodes for the given actor ordered by created_at DESC', async () => {
    createEpisode(sample({ actorId: 'u1', content: '较早' }))
    await new Promise(r => setTimeout(r, 5))
    createEpisode(sample({ actorId: 'u1', content: '较晚' }))

    const results = getRecentEpisodesByActor('u1')
    expect(results).toHaveLength(2)
    expect(results[0].content).toBe('较晚')
  })

  it('returns empty for unknown actor', () => {
    const results = getRecentEpisodesByActor('unknown')
    expect(results).toHaveLength(0)
  })

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) createEpisode(sample({ actorId: 'u1', content: `消息${i}` }))

    const results = getRecentEpisodesByActor('u1', 3)
    expect(results).toHaveLength(3)
  })
})

// ── countEpisodes ───────────────────────────────────────────

describe('countEpisodes', () => {
  it('returns 0 when no episodes', () => {
    expect(countEpisodes()).toBe(0)
  })

  it('counts all episodes', () => {
    createEpisode(sample())
    createEpisode(sample())
    expect(countEpisodes()).toBe(2)
  })

  it('filters by type', () => {
    createEpisode(sample({ type: 'conversation' }))
    createEpisode(sample({ type: 'system' }))

    expect(countEpisodes({ type: 'conversation' })).toBe(1)
  })

  it('filters by since', () => {
    const now = Date.now()
    createEpisode(sample({ content: '新' }))
    const db = getDatabase()
    const oldId = createEpisode(sample({ content: '旧' })).id
    db.prepare('UPDATE episodes SET created_at = ? WHERE id = ?').run(now - 100000, oldId)

    expect(countEpisodes({ since: now - 50000 })).toBe(1)
  })
})

// ── updateEpisodeSummary ────────────────────────────────────

describe('updateEpisodeSummary', () => {
  it('updates summary for existing episode', () => {
    const ep = createEpisode(sample())
    updateEpisodeSummary(ep.id, '更新后的摘要')

    const updated = getEpisodeById(ep.id)
    expect(updated!.summary).toBe('更新后的摘要')
  })

  it('does not throw for nonexistent episode', () => {
    expect(() => updateEpisodeSummary('nonexistent', '摘要')).not.toThrow()
  })
})
