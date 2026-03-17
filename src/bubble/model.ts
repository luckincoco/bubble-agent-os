import { ulid } from 'ulid'
import type { Bubble, BubbleLink, BubbleType } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'

export interface CreateBubbleInput {
  type: BubbleType
  title: string
  content: string
  metadata?: Record<string, unknown>
  tags?: string[]
  embedding?: number[]
  source?: string
  confidence?: number
  decayRate?: number
  pinned?: boolean
}

export function createBubble(input: CreateBubbleInput): Bubble {
  const db = getDatabase()
  const now = Date.now()

  const bubble: Bubble = {
    id: ulid(),
    type: input.type,
    title: input.title,
    content: input.content,
    metadata: input.metadata || {},
    tags: input.tags || [],
    links: [],
    source: input.source || 'system',
    confidence: input.confidence ?? 1.0,
    decayRate: input.decayRate ?? 0.1,
    pinned: input.pinned ?? false,
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
  }

  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, embedding, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    bubble.id,
    bubble.type,
    bubble.title,
    bubble.content,
    JSON.stringify(bubble.metadata),
    JSON.stringify(bubble.tags),
    input.embedding ? JSON.stringify(input.embedding) : null,
    bubble.source,
    bubble.confidence,
    bubble.decayRate,
    bubble.pinned ? 1 : 0,
    bubble.createdAt,
    bubble.updatedAt,
    bubble.accessedAt,
  )

  return bubble
}

export function getBubble(id: string): Bubble | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM bubbles WHERE id = ?').get(id) as any
  if (!row) return null

  // Update accessed_at
  db.prepare('UPDATE bubbles SET accessed_at = ? WHERE id = ?').run(Date.now(), id)

  return rowToBubble(row)
}

export function findBubblesByType(type: BubbleType, limit = 50): Bubble[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM bubbles WHERE type = ? ORDER BY updated_at DESC LIMIT ?').all(type, limit) as any[]
  return rows.map(rowToBubble)
}

export function searchBubbles(query: string, limit = 20): Bubble[] {
  const db = getDatabase()
  const pattern = `%${query}%`
  const rows = db.prepare(`
    SELECT * FROM bubbles 
    WHERE content LIKE ? OR title LIKE ? OR tags LIKE ?
    ORDER BY accessed_at DESC 
    LIMIT ?
  `).all(pattern, pattern, pattern, limit) as any[]
  return rows.map(rowToBubble)
}

export function getAllMemoryBubbles(): Bubble[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT * FROM bubbles WHERE type = 'memory' ORDER BY updated_at DESC
  `).all() as any[]
  return rows.map(rowToBubble)
}

export function deleteBubble(id: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM bubbles WHERE id = ?').run(id)
  return result.changes > 0
}

export function updateBubble(id: string, updates: Partial<Pick<Bubble, 'title' | 'content' | 'metadata' | 'tags' | 'confidence' | 'pinned'>>): boolean {
  const db = getDatabase()
  const sets: string[] = ['updated_at = ?']
  const values: unknown[] = [Date.now()]

  if (updates.title !== undefined) { sets.push('title = ?'); values.push(updates.title) }
  if (updates.content !== undefined) { sets.push('content = ?'); values.push(updates.content) }
  if (updates.metadata !== undefined) { sets.push('metadata = ?'); values.push(JSON.stringify(updates.metadata)) }
  if (updates.tags !== undefined) { sets.push('tags = ?'); values.push(JSON.stringify(updates.tags)) }
  if (updates.confidence !== undefined) { sets.push('confidence = ?'); values.push(updates.confidence) }
  if (updates.pinned !== undefined) { sets.push('pinned = ?'); values.push(updates.pinned ? 1 : 0) }

  values.push(id)
  const result = db.prepare(`UPDATE bubbles SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return result.changes > 0
}

function rowToBubble(row: any): Bubble {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata || '{}'),
    tags: JSON.parse(row.tags || '[]'),
    embedding: row.embedding ? JSON.parse(row.embedding) : undefined,
    links: [],
    source: row.source,
    confidence: row.confidence,
    decayRate: row.decay_rate,
    pinned: row.pinned === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
  }
}
