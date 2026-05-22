import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  createTemporalLink,
  invalidateLink,
  invalidateOutgoingLinks,
  getActiveLinks,
  getLinksAsOf,
  findContradiction,
  resolveContradiction,
} from '../src/temporal/temporal-linker.js'
import type { TemporalLinkInput } from '../src/temporal/temporal-linker.js'

let tmpDir: string

function insertBubble(id: string, spaceId?: string): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'entity', ?, ?, '{}', '[]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
  `).run(id, id, id, now, now, now, spaceId || null)
}

function defaultInput(overrides: Partial<TemporalLinkInput> = {}): TemporalLinkInput {
  return {
    sourceId: 'src-1',
    targetId: 'tgt-1',
    relation: 'supplies',
    weight: 1.0,
    linkSource: 'test',
    episodeId: 'ep-1',
    validFrom: Date.now() - 10000,
    metadata: { key: 'val' },
    ...overrides,
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-tl-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_links').run()
  db.prepare('DELETE FROM bubbles').run()
})

// ── createTemporalLink ──────────────────────────────────────

describe('createTemporalLink', () => {
  it('creates a link with all parameters', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    createTemporalLink(defaultInput())

    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM bubble_links').all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].source_id).toBe('src-1')
    expect(rows[0].target_id).toBe('tgt-1')
    expect(rows[0].relation).toBe('supplies')
    expect(rows[0].weight).toBe(1.0)
    expect(rows[0].link_source).toBe('test')
    expect(rows[0].episode_id).toBe('ep-1')
  })

  it('uses sensible defaults for optional fields', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    const now = Date.now()
    createTemporalLink({ sourceId: 'src-1', targetId: 'tgt-1', relation: 'related' })

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubble_links').get() as any
    expect(row.weight).toBe(1.0)
    expect(row.link_source).toBe('system')
    expect(row.episode_id).toBeNull()
    expect(row.valid_from).toBeGreaterThanOrEqual(now - 100)
    expect(row.metadata).toBe('{}')
  })

  it('stores valid_from when provided', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    const past = Date.now() - 50000
    createTemporalLink(defaultInput({ validFrom: past }))

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubble_links').get() as any
    expect(row.valid_from).toBe(past)
  })
})

// ── invalidateLink ──────────────────────────────────────────

describe('invalidateLink', () => {
  it('sets valid_until on matching active links', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    createTemporalLink(defaultInput())
    const before = Date.now()

    const count = invalidateLink('src-1', 'tgt-1', 'supplies')
    expect(count).toBe(1)

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubble_links').get() as any
    expect(row.valid_until).toBeGreaterThanOrEqual(before)
  })

  it('returns 0 when no active link matches', () => {
    const count = invalidateLink('nonexistent', 'nonexistent', 'unknown')
    expect(count).toBe(0)
  })

  it('merges invalidationReason into metadata', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    createTemporalLink(defaultInput())

    invalidateLink('src-1', 'tgt-1', 'supplies', '被新信息取代')

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubble_links').get() as any
    const meta = JSON.parse(row.metadata)
    expect(meta.invalidationReason).toBe('被新信息取代')
    expect(meta.invalidatedAt).toBeGreaterThan(0)
  })

  it('only invalidates links with valid_until IS NULL', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    createTemporalLink(defaultInput())
    invalidateLink('src-1', 'tgt-1', 'supplies') // first invalidation
    const count = invalidateLink('src-1', 'tgt-1', 'supplies') // try again
    expect(count).toBe(0) // already invalidated
  })
})

// ── invalidateOutgoingLinks ─────────────────────────────────

describe('invalidateOutgoingLinks', () => {
  it('invalidates all outgoing links of a relation from a source', () => {
    insertBubble('src-1')
    insertBubble('tgt-1')
    insertBubble('tgt-2')
    createTemporalLink(defaultInput({ targetId: 'tgt-1' }))
    createTemporalLink(defaultInput({ targetId: 'tgt-2' }))

    const count = invalidateOutgoingLinks('src-1', 'supplies')
    expect(count).toBe(2)

    const db = getDatabase()
    const active = db.prepare('SELECT COUNT(*) as cnt FROM bubble_links WHERE valid_until IS NULL').get() as any
    expect(active.cnt).toBe(0)
  })

  it('returns 0 when no active links', () => {
    const count = invalidateOutgoingLinks('src-1', 'supplies')
    expect(count).toBe(0)
  })
})

// ── getActiveLinks ──────────────────────────────────────────

describe('getActiveLinks', () => {
  it('returns outgoing links', () => {
    insertBubble('src-1'); insertBubble('tgt-1'); insertBubble('tgt-2')
    createTemporalLink(defaultInput({ targetId: 'tgt-1' }))
    createTemporalLink(defaultInput({ targetId: 'tgt-2' }))

    const links = getActiveLinks('src-1', 'outgoing')
    expect(links).toHaveLength(2)
    expect(links.every(l => l.sourceId === 'src-1')).toBe(true)
  })

  it('returns incoming links', () => {
    insertBubble('src-1'); insertBubble('src-2'); insertBubble('tgt-1')
    createTemporalLink(defaultInput({ sourceId: 'src-1', targetId: 'tgt-1' }))
    createTemporalLink(defaultInput({ sourceId: 'src-2', targetId: 'tgt-1' }))

    const links = getActiveLinks('tgt-1', 'incoming')
    expect(links).toHaveLength(2)
    expect(links.every(l => l.targetId === 'tgt-1')).toBe(true)
  })

  it('returns both directions by default', () => {
    insertBubble('a'); insertBubble('b'); insertBubble('c')
    createTemporalLink(defaultInput({ sourceId: 'a', targetId: 'b' }))
    createTemporalLink(defaultInput({ sourceId: 'b', targetId: 'c' }))

    const links = getActiveLinks('b')
    expect(links).toHaveLength(2)
  })

  it('excludes invalidated links', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    createTemporalLink(defaultInput())
    invalidateLink('src-1', 'tgt-1', 'supplies')

    const links = getActiveLinks('src-1', 'outgoing')
    expect(links).toHaveLength(0)
  })
})

// ── getLinksAsOf ────────────────────────────────────────────

describe('getLinksAsOf', () => {
  it('returns links valid at a past time', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    const past = Date.now() - 50000
    const recent = Date.now() - 10000
    createTemporalLink(defaultInput({ validFrom: past }))
    // set valid_until directly since createTemporalLink doesn't accept it
    getDatabase().prepare('UPDATE bubble_links SET valid_until = ? WHERE source_id = ? AND target_id = ?')
      .run(recent, 'src-1', 'tgt-1')

    // Query at a time when the link was valid
    const mid = past + (recent - past) / 2
    const links = getLinksAsOf('src-1', mid, 'outgoing')
    expect(links).toHaveLength(1)
  })

  it('excludes links not yet valid at asOf', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    const future = Date.now() + 50000
    createTemporalLink(defaultInput({ validFrom: future }))

    const links = getLinksAsOf('src-1', Date.now(), 'outgoing')
    expect(links).toHaveLength(0)
  })

  it('excludes links already expired at asOf', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    const now = Date.now()
    const past = now - 50000
    createTemporalLink(defaultInput({ validFrom: past }))
    // set valid_until in the past so the link is already expired
    getDatabase().prepare('UPDATE bubble_links SET valid_until = ? WHERE source_id = ? AND target_id = ?')
      .run(now - 10000, 'src-1', 'tgt-1')

    const links = getLinksAsOf('src-1', Date.now(), 'outgoing')
    expect(links).toHaveLength(0)
  })

  it('includes both directions by default', () => {
    insertBubble('a'); insertBubble('b'); insertBubble('c')
    createTemporalLink(defaultInput({ sourceId: 'a', targetId: 'b' }))
    createTemporalLink(defaultInput({ sourceId: 'c', targetId: 'b' }))

    const links = getLinksAsOf('b', Date.now())
    expect(links).toHaveLength(2)
  })
})

// ── findContradiction ───────────────────────────────────────

describe('findContradiction', () => {
  it('finds contradiction: same source+rel, different target', () => {
    insertBubble('src-1'); insertBubble('old-tgt'); insertBubble('new-tgt')
    createTemporalLink(defaultInput({ targetId: 'old-tgt' }))

    const c = findContradiction('src-1', 'supplies', 'new-tgt')
    expect(c).not.toBeNull()
    expect(c!.targetId).toBe('old-tgt')
  })

  it('no contradiction: same source+rel+target', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    createTemporalLink(defaultInput())

    const c = findContradiction('src-1', 'supplies', 'tgt-1')
    expect(c).toBeNull()
  })

  it('no contradiction: different relation', () => {
    insertBubble('src-1'); insertBubble('tgt-1'); insertBubble('tgt-2')
    createTemporalLink(defaultInput({ targetId: 'tgt-1', relation: 'supplies' }))

    const c = findContradiction('src-1', 'transports', 'tgt-2')
    expect(c).toBeNull()
  })

  it('no contradiction when existing link is already invalidated', () => {
    insertBubble('src-1'); insertBubble('old-tgt'); insertBubble('new-tgt')
    createTemporalLink(defaultInput({ targetId: 'old-tgt' }))
    invalidateLink('src-1', 'old-tgt', 'supplies')

    const c = findContradiction('src-1', 'supplies', 'new-tgt')
    expect(c).toBeNull()
  })
})

// ── resolveContradiction ────────────────────────────────────

describe('resolveContradiction', () => {
  it('invalidates old link and creates new one', () => {
    insertBubble('src-1'); insertBubble('old-tgt'); insertBubble('new-tgt')
    createTemporalLink(defaultInput({ targetId: 'old-tgt' }))

    const resolved = resolveContradiction(defaultInput({ targetId: 'new-tgt' }))
    expect(resolved).toBe(true)

    // Old link should be invalidated
    const db = getDatabase()
    const allLinks = db.prepare('SELECT * FROM bubble_links ORDER BY id').all() as any[]
    expect(allLinks).toHaveLength(2)
    const oldLink = allLinks.find((l: any) => l.target_id === 'old-tgt')
    expect(oldLink.valid_until).not.toBeNull()
    const newLink = allLinks.find((l: any) => l.target_id === 'new-tgt')
    expect(newLink.valid_until).toBeNull()
  })

  it('returns false when no contradiction exists', () => {
    insertBubble('src-1'); insertBubble('tgt-1')
    // No pre-existing link, so no contradiction
    const resolved = resolveContradiction(defaultInput())
    expect(resolved).toBe(false)
  })

  it('merges invalidation reason into old link metadata', () => {
    insertBubble('src-1'); insertBubble('old-tgt'); insertBubble('new-tgt')
    createTemporalLink(defaultInput({ targetId: 'old-tgt' }))

    resolveContradiction(defaultInput({ targetId: 'new-tgt' }))

    const db = getDatabase()
    const oldLink = db.prepare('SELECT * FROM bubble_links WHERE target_id = ?').get('old-tgt') as any
    const meta = JSON.parse(oldLink.metadata)
    expect(meta.invalidationReason).toContain('superseded')
  })
})
