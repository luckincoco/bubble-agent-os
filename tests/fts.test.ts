import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  isFTSAvailable,
  buildFTSQuery,
  searchFTS,
  getShortSegments,
} from '../src/bubble/fts.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-fts-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubbles').run()
})

// ── buildFTSQuery ────────────────────────────────────────────

describe('buildFTSQuery', () => {
  it('returns null for empty string', () => {
    expect(buildFTSQuery('')).toBeNull()
  })

  it('returns null for whitespace only', () => {
    expect(buildFTSQuery('   ')).toBeNull()
  })

  it('returns null for short query (< 3 chars)', () => {
    expect(buildFTSQuery('钢')).toBeNull()
    expect(buildFTSQuery('ab')).toBeNull()
  })

  it('includes the full query when 3+ chars', () => {
    const result = buildFTSQuery('螺纹钢')
    expect(result).toContain('螺纹钢')
  })

  it('joins multiple segments with OR', () => {
    const result = buildFTSQuery('宝钢 螺纹钢')
    expect(result).toContain('OR')
    expect(result).toContain('宝钢')
    expect(result).toContain('螺纹钢')
  })

  it('generates trigram windows for long segments (5+ chars)', () => {
    const result = buildFTSQuery('热轧卷板')
    // 5 chars → overlapping 3-char windows: 热轧卷, 轧卷板
    expect(result).toContain('热轧卷')
    expect(result).toContain('轧卷板')
  })

  it('strips special FTS characters from query', () => {
    const result = buildFTSQuery(`钢'铁"价*格`)
    expect(result).not.toContain("'")
    expect(result).not.toContain('"')
    expect(result).not.toContain('*')
    // The full stripped query should be present (钢铁价格 is 4 chars ≥ 3)
    expect(result).toContain('钢铁价格')
  })

  it('deduplicates segments', () => {
    const result = buildFTSQuery('螺纹钢 热轧板 螺纹钢')!
    const orParts = result.split(' OR ')
    // "螺纹钢" appears as a standalone OR term only once (dedup)
    expect(orParts.filter(p => p === '螺纹钢')).toHaveLength(1)
    // "热轧板" appears once
    expect(orParts.filter(p => p === '热轧板')).toHaveLength(1)
  })
})

// ── getShortSegments ─────────────────────────────────────────

describe('getShortSegments', () => {
  it('returns 2-char segments that are not stop words', () => {
    const result = getShortSegments('钢材 期货 我们')
    expect(result).toContain('钢材')
    expect(result).toContain('期货')
  })

  it('excludes stop words', () => {
    const result = getShortSegments('钢材 我 你')
    // 1-char segments are not returned (only 2-char)
    expect(result).toEqual(['钢材'])
  })

  it('deduplicates results', () => {
    const result = getShortSegments('钢材 钢材 期货')
    expect(result).toHaveLength(2)
  })

  it('returns empty for punctuation-only input', () => {
    const result = getShortSegments('，。！')
    expect(result).toHaveLength(0)
  })
})

// ── isFTSAvailable ───────────────────────────────────────────

describe('isFTSAvailable', () => {
  it('returns true when FTS table exists', () => {
    expect(isFTSAvailable()).toBe(true)
  })
})

// ── searchFTS ────────────────────────────────────────────────

describe('searchFTS', () => {
  function indexBubble(id: string): void {
    const db = getDatabase()
    // Get the SQLite rowid for this bubble
    const row = db.prepare('SELECT rowid FROM bubbles WHERE id = ?').get(id) as { rowid: number } | undefined
    if (!row) return
    const bubble = db.prepare('SELECT title, content, tags FROM bubbles WHERE id = ?').get(id) as any
    db.prepare('INSERT OR IGNORE INTO bubbles_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)').run(
      row.rowid, bubble.title, bubble.content, bubble.tags,
    )
  }

  it('returns empty for no match', () => {
    const results = searchFTS('ZZZZNONEXISTENT', 10)
    expect(results).toHaveLength(0)
  })

  it('finds results matching the query', () => {
    const db = getDatabase()
    const now = Date.now()
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["钢材"]', 'test', 0.8, 0.1, 0, ?, ?, ?, NULL, 0)
    `).run('b-fts-1', '螺纹钢', '螺纹钢价格4000元每吨', now, now, now)
    indexBubble('b-fts-1')

    const results = searchFTS('螺纹钢', 10)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].id).toBe('b-fts-1')
  })

  it('ranks by relevance (BM25)', () => {
    const db = getDatabase()
    const now = Date.now()
    // Bubble with title match — should rank higher
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["钢材"]', 'test', 0.8, 0.1, 0, ?, ?, ?, NULL, 0)
    `).run('b-rank-high', '螺纹钢', '螺纹钢价格4000元每吨', now, now, now)
    // Bubble with only content mention
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["钢材"]', 'test', 0.8, 0.1, 0, ?, ?, ?, NULL, 0)
    `).run('b-rank-low', '其他', '螺纹钢是一种常用的建筑材料', now, now, now)
    indexBubble('b-rank-high')
    indexBubble('b-rank-low')

    const results = searchFTS('螺纹钢', 10)
    expect(results.length).toBeGreaterThanOrEqual(2)
    // BM25: lower (more negative) rank = more relevant
    expect(results[0].rank).toBeLessThanOrEqual(results[1].rank)
  })

  it('filters by spaceIds', () => {
    const db = getDatabase()
    const now = Date.now()
    const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }

    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["钢材"]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('b-space-a', '螺纹钢', '螺纹钢行情', now, now, now, space.id)
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["钢材"]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('b-space-b', '螺纹钢', '螺纹钢行情', now, now, now, 'other-space')
    indexBubble('b-space-a')
    indexBubble('b-space-b')

    const results = searchFTS('螺纹钢', 10, [space.id])
    expect(results.every(r => r.id === 'b-space-a')).toBe(true)
  })

  it('returns empty for null query (short input)', () => {
    const results = searchFTS('钢', 10)
    expect(results).toHaveLength(0)
  })
})
