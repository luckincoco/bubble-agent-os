/**
 * ObsidianIngest — Safe, read-only ingestion of Obsidian vault notes into Bubble memory.
 *
 * Design principles:
 * 1. White-list directory only (_for_bubble/)
 * 2. Read-only: never writes back to Obsidian
 * 3. Source-tagged: all ingested bubbles marked source='obsidian-ingest'
 * 4. Stale detection: deleted/modified files mark old bubbles stale
 * 5. Low initial weight: natural decay validates relevance
 *
 * Zero LLM cost — pure file I/O + DB operations.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { createBubble, type CreateBubbleInput } from '../bubble/model.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { EventBus } from '../event/event-bus.js'

export interface IngestResult {
  created: number
  updated: number
  staled: number
  skipped: number
  denied: number
}

interface IngestRecord {
  filePath: string
  hash: string
  bubbleId: string
  ingestedAt: number
  stale: number
}

interface FrontMatter {
  tags?: string[]
  title?: string
  [key: string]: unknown
}

const INGEST_SOURCE = 'obsidian-ingest'
const INITIAL_WEIGHT = 0.5
const INITIAL_DECAY_RATE = 0.12
const MAX_CONTENT_LENGTH = 50_000  // Skip files >50KB

export class ObsidianIngest {
  private ingestDir: string
  private eventBus?: EventBus

  constructor(ingestDir: string) {
    this.ingestDir = ingestDir
    this.ensureTable()
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus
  }

  /**
   * Run a full ingest cycle:
   * 1. Scan directory for .md files
   * 2. Compute hash for each file
   * 3. Compare with previous ingest records
   * 4. Create/update/stale as needed
   */
  async ingest(): Promise<IngestResult> {
    const result: IngestResult = { created: 0, updated: 0, staled: 0, skipped: 0, denied: 0 }

    if (!existsSync(this.ingestDir)) {
      logger.info(`ObsidianIngest: directory not found: ${this.ingestDir}, skipping`)
      return result
    }

    // 1. Scan all .md files recursively
    const files = this.scanMarkdownFiles(this.ingestDir)
    const currentPaths = new Set(files.map(f => f.relativePath))

    // 2. Get all existing ingest records
    const existingRecords = this.getExistingRecords()

    // 3. Process each file
    for (const file of files) {
      if (file.size > MAX_CONTENT_LENGTH) {
        logger.debug(`ObsidianIngest: skipping oversized file: ${file.relativePath}`)
        result.skipped++
        continue
      }

      const content = readFileSync(file.absolutePath, 'utf-8')

      // Access control: check frontmatter before processing
      if (this.isDenied(content)) {
        logger.debug(`ObsidianIngest: access denied by frontmatter: ${file.relativePath}`)
        result.denied++
        continue
      }

      const hash = this.computeHash(content)
      const existing = existingRecords.get(file.relativePath)

      if (existing) {
        if (existing.hash === hash && !existing.stale) {
          // Unchanged — skip
          result.skipped++
        } else {
          // Content changed or was stale — update
          this.updateBubble(existing.bubbleId, content, file.relativePath)
          this.updateRecord(file.relativePath, hash, existing.bubbleId)
          result.updated++
          logger.info(`ObsidianIngest: updated "${file.relativePath}"`)
        }
      } else {
        // New file — create bubble
        const bubble = this.createDocumentBubble(content, file.relativePath)
        this.insertRecord(file.relativePath, hash, bubble.id)
        result.created++
        logger.info(`ObsidianIngest: ingested new "${file.relativePath}"`)
      }
    }

    // 4. Mark removed files as stale
    for (const [path, record] of existingRecords) {
      if (!currentPaths.has(path) && !record.stale) {
        this.markStale(record.bubbleId, path)
        result.staled++
        logger.info(`ObsidianIngest: marked stale "${path}"`)
      }
    }

    // 5. Emit event if anything happened
    if (result.created > 0 || result.updated > 0) {
      this.eventBus?.emit({
        type: 'knowledge.obsidian.ingested',
        payload: { ...result },
      }, { actor: 'obsidian-ingest' })
    }

    return result
  }

  // --- Private methods ---

  private scanMarkdownFiles(dir: string): Array<{ absolutePath: string; relativePath: string; size: number }> {
    const results: Array<{ absolutePath: string; relativePath: string; size: number }> = []
    this.walkDir(dir, results)
    return results
  }

  private walkDir(dir: string, results: Array<{ absolutePath: string; relativePath: string; size: number }>): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }

    for (const entry of entries) {
      // Skip hidden files/dirs
      if (entry.startsWith('.')) continue

      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      if (stat.isDirectory()) {
        this.walkDir(fullPath, results)
      } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
        results.push({
          absolutePath: fullPath,
          relativePath: relative(this.ingestDir, fullPath),
          size: stat.size,
        })
      }
    }
  }

  private computeHash(content: string): string {
    return createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  private parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
    const fmRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/
    const match = content.match(fmRegex)

    if (!match) return { frontMatter: {}, body: content }

    const fmBlock = match[1]
    const body = content.slice(match[0].length)
    const fm: FrontMatter = {}

    // Simple YAML-like parsing (tags, title)
    for (const line of fmBlock.split('\n')) {
      const colonIdx = line.indexOf(':')
      if (colonIdx < 0) continue
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim()

      if (key === 'tags') {
        // Handle [tag1, tag2] or - tag formats
        if (value.startsWith('[')) {
          fm.tags = value.slice(1, -1).split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean)
        }
      } else if (key === '- ') {
        // continuation of tags list — skip (simplified parser)
      } else {
        fm[key] = value.replace(/^['"]|['"]$/g, '')
      }
    }

    return { frontMatter: fm, body }
  }

  /**
   * Access control: deny ingestion if frontmatter explicitly opts out.
   *
   * Denied when any of:
   * - `bubble: false`
   * - `access: private`
   * - tags include `private` or `draft`
   */
  private isDenied(content: string): boolean {
    const { frontMatter } = this.parseFrontMatter(content)

    if (String(frontMatter['bubble']).toLowerCase() === 'false') return true
    if (String(frontMatter['access']).toLowerCase() === 'private') return true

    const tags = frontMatter.tags ?? []
    const denyTags = ['private', 'draft']
    if (tags.some(t => denyTags.includes(t.toLowerCase()))) return true

    return false
  }

  private createDocumentBubble(content: string, relativePath: string) {
    const { frontMatter, body } = this.parseFrontMatter(content)
    const title = frontMatter.title as string || this.titleFromPath(relativePath)
    const tags = [...(frontMatter.tags || []), 'obsidian-ingest']

    const input: CreateBubbleInput = {
      type: 'document',
      title,
      content: body,
      source: INGEST_SOURCE,
      confidence: INITIAL_WEIGHT,
      decayRate: INITIAL_DECAY_RATE,
      tags,
      metadata: {
        obsidianPath: relativePath,
        ingestedAt: Date.now(),
        frontMatter,
      },
    }

    return createBubble(input)
  }

  private updateBubble(bubbleId: string, content: string, relativePath: string): void {
    const { frontMatter, body } = this.parseFrontMatter(content)
    const title = frontMatter.title as string || this.titleFromPath(relativePath)
    const tags = [...(frontMatter.tags || []), 'obsidian-ingest']
    const now = Date.now()

    const db = getDatabase()
    db.prepare(`
      UPDATE bubbles SET
        title = ?, content = ?, tags = ?,
        metadata = json_patch(metadata, ?),
        updated_at = ?, confidence = ?
      WHERE id = ?
    `).run(
      title,
      body,
      JSON.stringify(tags),
      JSON.stringify({ obsidianPath: relativePath, updatedAt: now, frontMatter }),
      now,
      INITIAL_WEIGHT, // Reset weight on update — let decay re-validate
      bubbleId,
    )
  }

  private markStale(bubbleId: string, _path: string): void {
    const db = getDatabase()
    const now = Date.now()
    // Drastically reduce weight so it won't appear in retrieval
    db.prepare(`
      UPDATE bubbles SET confidence = 0.01, decay_rate = 0.5, updated_at = ? WHERE id = ?
    `).run(now, bubbleId)

    // Also mark record as stale
    db.prepare(`UPDATE obsidian_ingest SET stale = 1 WHERE file_path = ?`).run(_path)
  }

  private titleFromPath(relativePath: string): string {
    return basename(relativePath, '.md').replace(/[-_]/g, ' ')
  }

  // --- DB record management ---

  private ensureTable(): void {
    const db = getDatabase()
    db.exec(`
      CREATE TABLE IF NOT EXISTS obsidian_ingest (
        file_path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        bubble_id TEXT NOT NULL,
        ingested_at INTEGER NOT NULL,
        stale INTEGER DEFAULT 0
      )
    `)
  }

  private getExistingRecords(): Map<string, IngestRecord> {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM obsidian_ingest').all() as Array<{
      file_path: string; hash: string; bubble_id: string; ingested_at: number; stale: number
    }>

    const map = new Map<string, IngestRecord>()
    for (const row of rows) {
      map.set(row.file_path, {
        filePath: row.file_path,
        hash: row.hash,
        bubbleId: row.bubble_id,
        ingestedAt: row.ingested_at,
        stale: row.stale,
      })
    }
    return map
  }

  private insertRecord(filePath: string, hash: string, bubbleId: string): void {
    const db = getDatabase()
    db.prepare(
      'INSERT OR REPLACE INTO obsidian_ingest (file_path, hash, bubble_id, ingested_at, stale) VALUES (?, ?, ?, ?, 0)',
    ).run(filePath, hash, bubbleId, Date.now())
  }

  private updateRecord(filePath: string, hash: string, bubbleId: string): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE obsidian_ingest SET hash = ?, bubble_id = ?, ingested_at = ?, stale = 0 WHERE file_path = ?',
    ).run(hash, bubbleId, Date.now(), filePath)
  }
}
