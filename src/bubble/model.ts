import { ulid } from 'ulid'
import type { Bubble, BubbleLink, BubbleType } from '../shared/types.js'
import { getDatabase, buildInClause } from '../storage/database.js'

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
  spaceId?: string
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
    spaceId: input.spaceId,
  }

  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, embedding, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    bubble.spaceId ?? null,
  )

  return bubble
}

export function getBubble(id: string, spaceIds?: string[]): Bubble | null {
  const db = getDatabase()
  let sql = 'SELECT * FROM bubbles WHERE id = ?'
  const params: unknown[] = [id]

  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }

  const row = db.prepare(sql).get(...params) as any
  if (!row) return null

  db.prepare('UPDATE bubbles SET accessed_at = ? WHERE id = ?').run(Date.now(), id)
  return rowToBubble(row)
}

export function findBubblesByType(type: BubbleType, limit = 50, spaceIds?: string[]): Bubble[] {
  const db = getDatabase()
  let sql = 'SELECT * FROM bubbles WHERE type = ?'
  const params: unknown[] = [type]

  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }

  sql += ' ORDER BY updated_at DESC LIMIT ?'
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as any[]
  return rows.map(rowToBubble)
}

export function searchBubbles(query: string, limit = 20, spaceIds?: string[]): Bubble[] {
  const db = getDatabase()

  // Build space filter
  let spaceFilter = ''
  const spaceParams: string[] = []
  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    spaceFilter = ` AND space_id IN (${placeholders})`
    spaceParams.push(...sp)
  }

  // Extract meaningful keywords from the query (works for Chinese)
  const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '没', '不', '也', '都', '就', '和', '与', '或', '吗', '呢', '吧', '啊', '哦', '嗯', '一个', '一共', '多少', '什么', '怎么', '这个', '那个', '可以', '能', '会', '要', '想', '让', '把', '被', '给', '到', '从', '向', '对', '于', '为', '以', '而', '但', '如果', '因为', '所以', '虽然', '但是', '还是', '已经', '正在', '最近', '现在', '今天', '昨天', '明天', '上', '下', '中', '里', '外', '前', '后', '大', '小', '多', '少', '个', '些', '每', '各', '该', '其', '本', '此'])

  // Split query by punctuation and whitespace
  const segments = query.split(/[\s,，。？！、；：""''（）()\[\]{}·\-—]+/).filter(Boolean)

  // Extract keywords: remove stop words, keep segments >= 2 chars
  const keywords: string[] = []
  for (const seg of segments) {
    if (seg.length >= 2 && !stopWords.has(seg)) {
      keywords.push(seg)
    }
    if (seg.length >= 4) {
      for (let i = 0; i < seg.length - 1; i += 2) {
        const sub = seg.substring(i, i + 2)
        if (!stopWords.has(sub) && sub.length === 2) {
          keywords.push(sub)
        }
      }
    }
  }

  const uniqueKeywords = [...new Set(keywords)]

  // Fallback: use original query
  if (uniqueKeywords.length === 0) {
    const pattern = `%${query}%`
    const rows = db.prepare(`
      SELECT * FROM bubbles
      WHERE (content LIKE ? OR title LIKE ? OR tags LIKE ?)${spaceFilter}
      ORDER BY accessed_at DESC LIMIT ?
    `).all(pattern, pattern, pattern, ...spaceParams, limit) as any[]
    return rows.map(rowToBubble)
  }

  // Build OR conditions for each keyword
  const conditions = uniqueKeywords.map(() => '(content LIKE ? OR title LIKE ? OR tags LIKE ?)').join(' OR ')
  const params: unknown[] = []
  for (const kw of uniqueKeywords) {
    const pattern = `%${kw}%`
    params.push(pattern, pattern, pattern)
  }

  const rows = db.prepare(`
    SELECT * FROM bubbles
    WHERE (${conditions})${spaceFilter}
    ORDER BY accessed_at DESC LIMIT ?
  `).all(...params, ...spaceParams, limit) as any[]
  return rows.map(rowToBubble)
}

export function getAllMemoryBubbles(spaceIds?: string[]): Bubble[] {
  const db = getDatabase()
  let sql = "SELECT * FROM bubbles WHERE type = 'memory'"
  const params: unknown[] = []

  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }

  sql += ' ORDER BY updated_at DESC'
  const rows = db.prepare(sql).all(...params) as any[]
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
    spaceId: row.space_id ?? undefined,
  }
}
