import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  getBubblesAsOf,
  getNeighborsAsOf,
  getRelationTimeline,
  getInvalidatedBubbles,
  getTemporalStats,
} from '../src/temporal/temporal-query.js'

let tmpDir: string
let spaceId: string

function insertBubble(overrides: Record<string, unknown> = {}): string {
  const db = getDatabase()
  const id = (overrides.id as string) || `tb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, valid_from, valid_until)
    VALUES (?, ?, ?, ?, '{}', ?, ?, ?, 0.1, 0, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id,
    overrides.type || 'entity',
    overrides.title || '测试',
    overrides.content || '内容',
    JSON.stringify((overrides.tags as string[]) || []),
    overrides.source || 'test',
    overrides.confidence ?? 0.8,
    now, now, now,
    overrides.space_id as string || spaceId,
    overrides.valid_from ?? null,
    overrides.valid_until ?? null,
  )
  return id
}

function insertLink(opts: { sourceId: string; targetId: string; relation: string; weight?: number; validFrom?: number | null; validUntil?: number | null }) {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, valid_from, valid_until, created_at)
    VALUES (?, ?, ?, ?, 'test', ?, ?, ?)
  `).run(opts.sourceId, opts.targetId, opts.relation, opts.weight ?? 0.5, opts.validFrom ?? null, opts.validUntil ?? null, now)
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-tq-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubbles').run()
  db.prepare('DELETE FROM bubble_links').run()
})

// ── getBubblesAsOf ──────────────────────────────────────────

describe('getBubblesAsOf', () => {
  it('returns bubbles valid at a specific time', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '有效实体', valid_from: now - 10000, valid_until: now + 10000 })

    const result = getBubblesAsOf(now)
    expect(result.some(b => b.id === 'b1')).toBe(true)
  })

  it('excludes bubbles not yet valid', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '未来实体', valid_from: now + 50000 })

    const result = getBubblesAsOf(now)
    expect(result.some(b => b.id === 'b1')).toBe(false)
  })

  it('excludes bubbles past valid_until', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '过期实体', valid_from: now - 50000, valid_until: now - 10000 })

    const result = getBubblesAsOf(now)
    expect(result.some(b => b.id === 'b1')).toBe(false)
  })

  it('includes bubbles with null valid_from/valid_until', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '永久实体', valid_from: null, valid_until: null })

    const result = getBubblesAsOf(now)
    expect(result.some(b => b.id === 'b1')).toBe(true)
  })

  it('filters by type', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '实体', type: 'entity', valid_from: now - 10000 })
    insertBubble({ id: 'b2', title: '记忆', type: 'memory', valid_from: now - 10000 })

    const result = getBubblesAsOf(now, { type: 'entity' })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b1')
  })

  it('filters by spaceId', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '空间1', space_id: spaceId, valid_from: now - 10000 })
    insertBubble({ id: 'b2', title: '空间2', space_id: 'other-space', valid_from: now - 10000 })

    const result = getBubblesAsOf(now, { spaceId })
    expect(result.every(b => b.spaceId === spaceId)).toBe(true)
  })

  it('respects limit', () => {
    const now = Date.now()
    for (let i = 0; i < 10; i++) {
      insertBubble({ id: `lim-${i}`, title: `实体${i}`, valid_from: now - 10000 })
    }

    const result = getBubblesAsOf(now, { limit: 3 })
    expect(result).toHaveLength(3)
  })
})

// ── getNeighborsAsOf ────────────────────────────────────────

describe('getNeighborsAsOf', () => {
  it('finds outgoing neighbors', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源实体' })
    insertBubble({ id: 'tgt', title: '目标实体' })
    insertLink({ sourceId: 'src', targetId: 'tgt', relation: 'supplies', validFrom: now - 10000, validUntil: now + 10000 })

    const neighbors = getNeighborsAsOf('src', now, { direction: 'outgoing' })
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].bubble.id).toBe('tgt')
    expect(neighbors[0].relation).toBe('supplies')
  })

  it('finds incoming neighbors', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源实体' })
    insertBubble({ id: 'tgt', title: '目标实体' })
    insertLink({ sourceId: 'src', targetId: 'tgt', relation: 'supplies', validFrom: now - 10000 })

    const neighbors = getNeighborsAsOf('tgt', now, { direction: 'incoming' })
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].bubble.id).toBe('src')
  })

  it('finds both directions', () => {
    const now = Date.now()
    insertBubble({ id: 'a', title: 'A' })
    insertBubble({ id: 'b', title: 'B' })
    insertBubble({ id: 'c', title: 'C' })
    insertLink({ sourceId: 'a', targetId: 'b', relation: 'related', validFrom: now - 10000 })
    insertLink({ sourceId: 'c', targetId: 'a', relation: 'related', validFrom: now - 10000 })

    const neighbors = getNeighborsAsOf('a', now, { direction: 'both' })
    expect(neighbors).toHaveLength(2)
    const ids = neighbors.map(n => n.bubble.id).sort()
    expect(ids).toEqual(['b', 'c'])
  })

  it('filters by relation type', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源' })
    insertBubble({ id: 't1', title: '供应' })
    insertBubble({ id: 't2', title: '运输' })
    insertLink({ sourceId: 'src', targetId: 't1', relation: 'supplies', validFrom: now - 10000 })
    insertLink({ sourceId: 'src', targetId: 't2', relation: 'transports', validFrom: now - 10000 })

    const neighbors = getNeighborsAsOf('src', now, { direction: 'outgoing', relation: 'supplies' })
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0].bubble.id).toBe('t1')
  })

  it('excludes temporally invalid links', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源' })
    insertBubble({ id: 'tgt', title: '目标' })
    insertLink({ sourceId: 'src', targetId: 'tgt', relation: 'old', validFrom: now - 50000, validUntil: now - 30000 })

    const neighbors = getNeighborsAsOf('src', now, { direction: 'outgoing' })
    expect(neighbors).toHaveLength(0)
  })

  it('includes links with null temporal values', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源' })
    insertBubble({ id: 'tgt', title: '目标' })
    insertLink({ sourceId: 'src', targetId: 'tgt', relation: 'permanent', validFrom: null, validUntil: null })

    const neighbors = getNeighborsAsOf('src', now)
    expect(neighbors).toHaveLength(1)
  })
})

// ── getRelationTimeline ─────────────────────────────────────

describe('getRelationTimeline', () => {
  it('returns all versions sorted by valid_from', () => {
    const now = Date.now()
    insertBubble({ id: 'src', title: '源公司' })
    insertBubble({ id: 't1', title: '供应商A' })
    insertBubble({ id: 't2', title: '供应商B' })

    insertLink({ sourceId: 'src', targetId: 't1', relation: 'supplies', validFrom: now - 50000, validUntil: now - 20000 })
    insertLink({ sourceId: 'src', targetId: 't2', relation: 'supplies', validFrom: now - 10000, validUntil: null })

    const timeline = getRelationTimeline('src', 'supplies')
    expect(timeline).toHaveLength(2)
    // Sorted by valid_from ASC
    expect(timeline[0].targetTitle).toBe('供应商A')
    expect(timeline[1].targetTitle).toBe('供应商B')
  })

  it('returns empty when no matching relations', () => {
    const timeline = getRelationTimeline('nonexistent', 'supplies')
    expect(timeline).toHaveLength(0)
  })
})

// ── getInvalidatedBubbles ───────────────────────────────────

describe('getInvalidatedBubbles', () => {
  it('returns bubbles invalidated in a time range', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '已失效', valid_from: now - 50000, valid_until: now - 10000 })
    insertBubble({ id: 'b2', title: '仍有效', valid_from: now - 50000, valid_until: null })

    const result = getInvalidatedBubbles(now - 20000, now)
    expect(result.some(b => b.id === 'b1')).toBe(true)
    expect(result.some(b => b.id === 'b2')).toBe(false)
  })

  it('respects since parameter', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '较早失效', valid_from: now - 100000, valid_until: now - 50000 })
    insertBubble({ id: 'b2', title: '较晚失效', valid_from: now - 100000, valid_until: now - 10000 })

    const result = getInvalidatedBubbles(now - 30000)
    expect(result.some(b => b.id === 'b1')).toBe(false)
    expect(result.some(b => b.id === 'b2')).toBe(true)
  })

  it('filters by spaceId', () => {
    const now = Date.now()
    insertBubble({ id: 'b1', title: '本空间', valid_until: now - 10000, space_id: spaceId })
    insertBubble({ id: 'b2', title: '其他空间', valid_until: now - 10000, space_id: 'other' })

    const result = getInvalidatedBubbles(now - 20000, now, spaceId)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b1')
  })
})

// ── getTemporalStats ────────────────────────────────────────

describe('getTemporalStats', () => {
  it('returns counts when no bubbles exist', () => {
    const stats = getTemporalStats()
    expect(stats).toEqual({ active: 0, invalidated: 0, total: 0 })
  })

  it('counts active vs invalidated correctly', () => {
    insertBubble({ id: 'b1', title: '有效', valid_until: null })
    insertBubble({ id: 'b2', title: '有效无时间', valid_from: null, valid_until: null })
    insertBubble({ id: 'b3', title: '已失效', valid_until: Date.now() - 10000 })

    const stats = getTemporalStats()
    expect(stats.total).toBe(3)
    expect(stats.invalidated).toBe(1)
    expect(stats.active).toBe(2)
  })

  it('scoped to spaceId', () => {
    insertBubble({ id: 'b1', title: '空间内有效', space_id: spaceId, valid_until: null })
    insertBubble({ id: 'b2', title: '其他空间', space_id: 'other-space', valid_until: null })

    const stats = getTemporalStats(spaceId)
    expect(stats.total).toBe(1)
    expect(stats.active).toBe(1)
  })
})
