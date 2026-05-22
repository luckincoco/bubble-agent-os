import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { ObsidianIngest } from '../src/cognition/obsidian-ingest.js'
import type { IngestResult } from '../src/cognition/obsidian-ingest.js'

let dbDir: string
let vaultDir: string

function writeNote(relativePath: string, content: string): void {
  const parts = relativePath.split('/')
  const fileName = parts.pop()!
  const dirPath = parts.length > 0 ? join(vaultDir, ...parts) : vaultDir
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, fileName), content, 'utf-8')
}

async function ingestAll(ingest: ObsidianIngest): Promise<IngestResult> {
  return ingest.ingest()
}

function countRecords(): number {
  const db = getDatabase()
  return (db.prepare('SELECT COUNT(*) AS cnt FROM obsidian_ingest').get() as any).cnt
}

function getRecord(filePath: string): any {
  const db = getDatabase()
  return db.prepare('SELECT * FROM obsidian_ingest WHERE file_path = ?').get(filePath)
}

describe('ObsidianIngest', () => {
  beforeAll(() => {
    dbDir = mkdtempSync(join(tmpdir(), 'obsidian-db-'))
    initDatabase(dbDir, 'test-pass')
  })

  afterAll(() => {
    closeDatabase()
    rmSync(dbDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // Clean up vault dir between tests
    if (existsSync(vaultDir)) {
      rmSync(vaultDir, { recursive: true, force: true })
    }
    vaultDir = mkdtempSync(join(tmpdir(), 'obsidian-vault-'))
    // Ensure obsidian_ingest table exists (created by ObsidianIngest constructor,
    // but may not exist yet before the first test constructs it)
    const db = getDatabase()
    db.exec(`CREATE TABLE IF NOT EXISTS obsidian_ingest (
      file_path TEXT PRIMARY KEY, hash TEXT NOT NULL, bubble_id TEXT NOT NULL,
      ingested_at INTEGER NOT NULL, stale INTEGER DEFAULT 0
    )`)
    db.exec('DELETE FROM obsidian_ingest')
    db.exec('DELETE FROM bubbles')
  })

  afterAll(() => {
    // Clean vault dir if it exists
    if (existsSync(vaultDir)) {
      rmSync(vaultDir, { recursive: true, force: true })
    }
  })

  // ── Pure method tests ──────────────────────────────────────

  describe('computeHash', () => {
    it('returns first 16 chars of sha256 hex digest', () => {
      const ingest = new ObsidianIngest(vaultDir)
      const hash = (ingest as any).computeHash('hello')
      expect(hash).toBe('2cf24dba5fb0a30e') // sha256('hello').slice(0, 16)
      expect(hash).toHaveLength(16)
    })

    it('produces different hashes for different content', () => {
      const ingest = new ObsidianIngest(vaultDir)
      const h1 = (ingest as any).computeHash('content A')
      const h2 = (ingest as any).computeHash('content B')
      expect(h1).not.toBe(h2)
    })
  })

  describe('parseFrontMatter', () => {
    it('parses frontmatter with tags and title', () => {
      const ingest = new ObsidianIngest(vaultDir)
      const content = '---\ntitle: My Note\ntags: [steel, trade]\n---\n# Body content'
      const { frontMatter, body } = (ingest as any).parseFrontMatter(content)
      expect(frontMatter.title).toBe('My Note')
      expect(frontMatter.tags).toEqual(['steel', 'trade'])
      expect(body).toBe('# Body content')
    })

    it('returns empty frontmatter and full content when no frontmatter', () => {
      const ingest = new ObsidianIngest(vaultDir)
      const content = '# Plain note\nno frontmatter here'
      const { frontMatter, body } = (ingest as any).parseFrontMatter(content)
      expect(frontMatter).toEqual({})
      expect(body).toBe(content)
    })

    it('handles frontmatter with only body content', () => {
      const ingest = new ObsidianIngest(vaultDir)
      const { frontMatter, body } = (ingest as any).parseFrontMatter('---\nbubble: false\n---\nPrivate')
      expect(frontMatter.bubble).toBe('false')
      expect(body).toBe('Private')
    })
  })

  describe('isDenied', () => {
    it('denies when bubble: false', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).isDenied('---\nbubble: false\n---\ncontent')).toBe(true)
    })

    it('denies when access: private', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).isDenied('---\naccess: private\n---\ncontent')).toBe(true)
    })

    it('denies when tags contain private', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).isDenied('---\ntags: [private, draft]\n---\ncontent')).toBe(true)
    })

    it('allows when no deny conditions match', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).isDenied('---\ntags: [steel]\n---\ncontent')).toBe(false)
    })

    it('allows content without frontmatter', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).isDenied('just a note')).toBe(false)
    })
  })

  describe('titleFromPath', () => {
    it('removes .md extension and replaces separators', () => {
      const ingest = new ObsidianIngest(vaultDir)
      expect((ingest as any).titleFromPath('my-note.md')).toBe('my note')
      expect((ingest as any).titleFromPath('steel_trade/note.md')).toBe('note')
      expect((ingest as any).titleFromPath('2024-06_summary.md')).toBe('2024 06 summary')
    })
  })

  // ── Ingest flow tests ──────────────────────────────────────

  describe('ingest flow', () => {
    it('creates records for new markdown files', async () => {
      writeNote('note1.md', '# Note 1\nContent here')
      writeNote('sub/note2.md', '# Note 2\nMore content')

      const ingest = new ObsidianIngest(vaultDir)
      const result = await ingestAll(ingest)

      expect(result.created).toBe(2)
      expect(result.skipped).toBe(0)
      expect(result.denied).toBe(0)
      expect(countRecords()).toBe(2)
    })

    it('skips unchanged files on second ingest', async () => {
      writeNote('note1.md', '# Note 1\nContent here')
      const ingest = new ObsidianIngest(vaultDir)
      const first = await ingestAll(ingest)
      expect(first.created).toBe(1)

      // Second ingest — file unchanged
      const second = await ingestAll(ingest)
      expect(second.created).toBe(0)
      expect(second.skipped).toBe(1)
      expect(second.updated).toBe(0)
    })

    it('updates records when file content changes', async () => {
      writeNote('note1.md', '# Note 1\nOriginal')
      const ingest = new ObsidianIngest(vaultDir)
      const first = await ingestAll(ingest)
      expect(first.created).toBe(1)

      // Change file content
      writeNote('note1.md', '# Note 1\nUpdated content')

      const second = await ingestAll(ingest)
      expect(second.updated).toBe(1)
      expect(second.created).toBe(0)

      // Verify hash was updated
      const record = getRecord('note1.md')
      expect(record).not.toBeNull()
      expect(record.stale).toBe(0)
    })

    it('marks deleted files as stale', async () => {
      writeNote('note1.md', '# Note 1')
      writeNote('note2.md', '# Note 2')
      const ingest = new ObsidianIngest(vaultDir)
      const first = await ingestAll(ingest)
      expect(first.created).toBe(2)

      // Remove note2 and re-ingest
      rmSync(join(vaultDir, 'note2.md'))
      const second = await ingestAll(ingest)
      expect(second.staled).toBe(1)
      expect(second.created).toBe(0)

      // note1 unchanged → skipped
      expect(second.skipped).toBe(1)

      // Verify note2 marked stale
      const record = getRecord('note2.md')
      expect(record).not.toBeNull()
      expect(record.stale).toBe(1)
    })

    it('denies files with bubble:false frontmatter', async () => {
      writeNote('allowed.md', '# Allowed')
      writeNote('denied.md', '---\nbubble: false\n---\n# Denied')

      const ingest = new ObsidianIngest(vaultDir)
      const result = await ingestAll(ingest)

      expect(result.created).toBe(1)  // only allowed.md
      expect(result.denied).toBe(1)   // denied.md skipped
    })

    it('returns zeros for non-existent directory', async () => {
      const ingest = new ObsidianIngest(join(vaultDir, 'nonexistent'))
      const result = await ingestAll(ingest)
      expect(result.created).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.denied).toBe(0)
      expect(result.staled).toBe(0)
    })

    it('skips oversized files (>50KB)', async () => {
      const bigContent = 'x'.repeat(51_000)
      writeNote('big.md', bigContent)
      writeNote('small.md', '# Small note')

      const ingest = new ObsidianIngest(vaultDir)
      const result = await ingestAll(ingest)

      expect(result.created).toBe(1)  // only small.md
      expect(result.skipped).toBe(1)  // big.md skipped due to size
    })

    it('handles files in nested subdirectories', async () => {
      writeNote('a/b/c/deep.md', '# Deeply nested')
      writeNote('x/y.md', '# Also nested')

      const ingest = new ObsidianIngest(vaultDir)
      const result = await ingestAll(ingest)

      expect(result.created).toBe(2)
      expect(getRecord('a/b/c/deep.md')).toBeTruthy()
      expect(getRecord('x/y.md')).toBeTruthy()
    })
  })
})
