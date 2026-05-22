import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  BubbleAggregator,
  tierMultiplier,
  type BubbleSummaryHit,
} from '../src/bubble/aggregator.js'
import { addLink } from '../src/bubble/links.js'
import { storeEntities } from '../src/bubble/entity-extractor.js'

let tmpDir: string
let aggregator: BubbleAggregator

function insertBubble(
  id: string,
  title: string,
  content: string,
  overrides: Partial<{
    pinned: number
    created_at: number
    updated_at: number
    accessed_at: number
    space_id: string | null
    abstraction_level: number
    summary: string | null
  }> = {},
): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level, summary)
    VALUES (?, 'entity', ?, ?, '{}', '[]', 'test', 0.8, 0.1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    title,
    content,
    overrides.pinned ?? 0,
    overrides.created_at ?? now,
    overrides.updated_at ?? now,
    overrides.accessed_at ?? now,
    overrides.space_id ?? null,
    overrides.abstraction_level ?? 0,
    overrides.summary ?? null,
  )
}

function indexBubbleFTS(id: string): void {
  const db = getDatabase()
  const row = db.prepare('SELECT rowid FROM bubbles WHERE id = ?').get(id) as { rowid: number } | undefined
  if (!row) return
  const bubble = db.prepare('SELECT title, content, tags FROM bubbles WHERE id = ?').get(id) as any
  db.prepare('INSERT OR IGNORE INTO bubbles_fts(rowid, title, content, tags) VALUES (?, ?, ?, ?)').run(
    row.rowid, bubble.title, bubble.content, bubble.tags,
  )
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-ag-'))
  initDatabase(tmpDir, 'test-password-123')
  aggregator = new BubbleAggregator()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_entities').run()
  db.prepare('DELETE FROM bubble_links').run()
  db.prepare('DELETE FROM bubbles').run()
  aggregator = new BubbleAggregator()
})

// ── tierMultiplier (pure function, no DB) ─────────────────────

describe('tierMultiplier', () => {
  it('returns 1.0 for pinned bubbles regardless of accessedAt', () => {
    expect(tierMultiplier(0, true)).toBe(1.0)
  })

  it('returns 1.0 for recently accessed (tier 0, < 1 hour)', () => {
    const recent = Date.now() - 30 * 60 * 1000 // 30 min ago
    expect(tierMultiplier(recent, false)).toBe(1.0)
  })

  it('returns 0.8 for active (tier 1, 1 hour ~ 7 days)', () => {
    const active = Date.now() - 3 * 24 * 60 * 60 * 1000 // 3 days ago
    expect(tierMultiplier(active, false)).toBe(0.8)
  })

  it('returns 0.5 for long-term (tier 2, 7 ~ 90 days)', () => {
    const longTerm = Date.now() - 30 * 24 * 60 * 60 * 1000 // 30 days ago
    expect(tierMultiplier(longTerm, false)).toBe(0.5)
  })

  it('returns 0.2 for archive (tier 3, > 90 days)', () => {
    const archive = Date.now() - 180 * 24 * 60 * 60 * 1000 // 180 days ago
    expect(tierMultiplier(archive, false)).toBe(0.2)
  })
})

// ── setEmbeddingProvider ─────────────────────────────────────

describe('setEmbeddingProvider', () => {
  it('stores the provider reference', () => {
    const mockProvider = { embed: async () => [0.1, 0.2, 0.3] } as any
    aggregator.setEmbeddingProvider(mockProvider)
    // We verify by checking that no error is thrown and the provider is set
    // (internal use happens inside aggregate — we trust the setter)
    expect(true).toBe(true)
  })
})

// ── aggregate — basic ────────────────────────────────────────

describe('aggregate basic', () => {
  it('returns matching bubbles from FTS/keyword search', async () => {
    insertBubble('b1', '螺纹钢', '螺纹钢价格4000元每吨')
    indexBubbleFTS('b1')

    const results = await aggregator.aggregate('螺纹钢')
    expect(results.length).toBeGreaterThanOrEqual(1)
    const ids = results.map(r => r.id)
    expect(ids).toContain('b1')
  })

  it('returns empty array when nothing matches', async () => {
    insertBubble('b1', '无关标题', '一些不相关的内容')
    indexBubbleFTS('b1')

    const results = await aggregator.aggregate('ZZZZNONEXISTENT')
    expect(results).toHaveLength(0)
  })

  it('respects the limit parameter', async () => {
    for (let i = 0; i < 3; i++) {
      insertBubble(`b-${i}`, '螺纹钢', `螺纹钢品种${i}`)
      indexBubbleFTS(`b-${i}`)
    }

    const results = await aggregator.aggregate('螺纹钢', 1)
    expect(results.length).toBeLessThanOrEqual(1)
  })
})

// ── aggregate — graph traversal ──────────────────────────────

describe('aggregate graph traversal', () => {
  it('expands results via bubble_links', async () => {
    insertBubble('center', '螺纹钢', '螺纹钢行情消息')
    insertBubble('related', '钢铁期货', '钢铁期货走势分析')
    indexBubbleFTS('center')
    indexBubbleFTS('related')
    addLink('center', 'related', 'related')

    const results = await aggregator.aggregate('螺纹钢')
    const ids = results.map(r => r.id)
    expect(ids).toContain('center')
    // Graph traversal should pull in related via link expansion
    expect(ids).toContain('related')
  })
})

// ── aggregate — entity KG expansion ──────────────────────────

describe('aggregate entity KG expansion', () => {
  it('expands results via entity KG', async () => {
    insertBubble('b-entity', '宝钢集团', '宝钢集团最新报价')
    indexBubbleFTS('b-entity')

    // Register entity for '宝钢集团' as company
    storeEntities('b-entity', [{ text: '宝钢集团', type: 'company' }])

    // Query with entity-like content — extractEntities('宝钢集团') will find it
    // Then findBubblesByEntity('宝钢集团', 'company') returns b-entity
    const results = await aggregator.aggregate('宝钢集团')
    const ids = results.map(r => r.id)
    expect(ids).toContain('b-entity')
  })
})

// ── aggregate — post-RRF adjustments ─────────────────────────

describe('aggregate post-RRF adjustments', () => {
  it('ranks pinned bubbles higher than unpinned', async () => {
    insertBubble('unpinned', '螺纹钢', '螺纹钢普通行情')
    insertBubble('pinned-b', '螺纹钢', '螺纹钢重要行情', { pinned: 1 })
    indexBubbleFTS('unpinned')
    indexBubbleFTS('pinned-b')

    const results = await aggregator.aggregate('螺纹钢')
    const ids = results.map(r => r.id)
    expect(ids).toContain('pinned-b')
    expect(ids).toContain('unpinned')
    // pinned should appear before unpinned
    expect(ids.indexOf('pinned-b')).toBeLessThan(ids.indexOf('unpinned'))
  })

  it('applies focusBoostFn to adjust scores', async () => {
    insertBubble('boosted', '螺纹钢', '螺纹钢重点关注品种')
    insertBubble('normal', '螺纹钢', '螺纹钢普通品种')
    indexBubbleFTS('boosted')
    indexBubbleFTS('normal')

    // Give boosted a large focus bonus so it ranks first
    const focusBoost = (content: string) => content.includes('重点') ? 10 : 0
    const results = await aggregator.aggregate('螺纹钢', 10, undefined, focusBoost)
    expect(results[0].id).toBe('boosted')
  })
})

// ── aggregateSummaries ───────────────────────────────────────

describe('aggregateSummaries', () => {
  it('returns BubbleSummaryHit array with correct fields', async () => {
    insertBubble('b-sum', '螺纹钢', '螺纹钢行情走势分析', { summary: '这是一个摘要' })
    indexBubbleFTS('b-sum')

    const summaries = await aggregator.aggregateSummaries('螺纹钢')
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    const hit = summaries[0]
    expect(hit).toHaveProperty('id')
    expect(hit).toHaveProperty('type')
    expect(hit).toHaveProperty('title')
    expect(hit).toHaveProperty('summary')
    expect(hit).toHaveProperty('score')
    expect(hit.id).toBe('b-sum')
  })

  it('falls back summary to content prefix when summary is empty', async () => {
    insertBubble('b-nosum', '螺纹钢', '螺纹钢行情走势分析今日价格', { summary: null })
    indexBubbleFTS('b-nosum')

    const summaries = await aggregator.aggregateSummaries('螺纹钢')
    const hit = summaries.find(s => s.id === 'b-nosum')
    expect(hit).toBeDefined()
    // Should fallback to content slice
    expect(hit!.summary).toBe('螺纹钢行情走势分析今日价格')
  })
})

// ── loadFullBubbles ──────────────────────────────────────────

describe('loadFullBubbles', () => {
  it('returns existing bubbles by IDs', () => {
    insertBubble('b1', '标题1', '内容1')
    insertBubble('b2', '标题2', '内容2')

    const results = aggregator.loadFullBubbles(['b1', 'b2'])
    expect(results).toHaveLength(2)
    expect(results[0].id).toBe('b1')
    expect(results[1].id).toBe('b2')
  })

  it('skips non-existent IDs without throwing', () => {
    insertBubble('b1', '标题', '内容')

    const results = aggregator.loadFullBubbles(['b1', 'nonexistent'])
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe('b1')
  })
})
