/**
 * FTS5 BM25 Search Module
 * Uses SQLite FTS5 with trigram tokenizer for Chinese-aware full-text search.
 * Trigram works for queries of 3+ characters; shorter queries fall back to LIKE.
 */

import { getDatabase, buildInClause } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface FTSResult {
  id: string
  rank: number  // BM25 rank (negative, lower = more relevant)
}

/** Check if FTS5 table exists and is usable */
export function isFTSAvailable(): boolean {
  try {
    const db = getDatabase()
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='bubbles_fts'"
    ).get() as { name: string } | undefined
    return !!row
  } catch {
    return false
  }
}

/**
 * Build a FTS5 MATCH expression from a Chinese query.
 * - Segments of 3+ chars: use directly as trigram matches
 * - Multiple segments: join with OR
 * - The full query is also tried as-is if 3+ chars
 */
export function buildFTSQuery(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null

  const parts: string[] = []

  // If full query is 3+ chars, add it as a phrase
  if (charLength(trimmed) >= 3) {
    parts.push(escapeFTS(trimmed))
  }

  // Split on punctuation/whitespace and extract segments
  const segments = trimmed.split(/[\s,，。？！、；：""''（）()\[\]{}·\-—\n\r\t]+/).filter(Boolean)

  for (const seg of segments) {
    if (charLength(seg) >= 3 && seg !== trimmed) {
      parts.push(escapeFTS(seg))
    }
    // For longer segments, also extract 3-char overlapping windows
    if (charLength(seg) >= 5) {
      const chars = [...seg]
      for (let i = 0; i <= chars.length - 3; i += 2) {
        const sub = chars.slice(i, i + 3).join('')
        if (sub !== seg && !parts.includes(escapeFTS(sub))) {
          parts.push(escapeFTS(sub))
        }
      }
    }
  }

  if (parts.length === 0) return null

  // Deduplicate
  const unique = [...new Set(parts)]
  return unique.join(' OR ')
}

/**
 * Search using FTS5 BM25 ranking.
 * Returns results sorted by relevance (most relevant first).
 */
export function searchFTS(query: string, limit: number, spaceIds?: string[]): FTSResult[] {
  if (!isFTSAvailable()) return []

  const ftsQuery = buildFTSQuery(query)
  if (!ftsQuery) return []

  const db = getDatabase()

  try {
    let sql: string
    const params: unknown[] = []

    if (spaceIds?.length) {
      const { placeholders, params: sp } = buildInClause(spaceIds)
      sql = `
        SELECT b.id, bm25(bubbles_fts) as rank
        FROM bubbles_fts f
        JOIN bubbles b ON b.rowid = f.rowid
        WHERE bubbles_fts MATCH ?
          AND b.deleted_at IS NULL
          AND b.space_id IN (${placeholders})
        ORDER BY rank
        LIMIT ?
      `
      params.push(ftsQuery, ...sp, limit)
    } else {
      sql = `
        SELECT b.id, bm25(bubbles_fts) as rank
        FROM bubbles_fts f
        JOIN bubbles b ON b.rowid = f.rowid
        WHERE bubbles_fts MATCH ?
          AND b.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?
      `
      params.push(ftsQuery, limit)
    }

    const rows = db.prepare(sql).all(...params) as Array<{ id: string; rank: number }>
    return rows
  } catch (err) {
    // FTS5 MATCH can throw on malformed queries
    logger.debug('FTS5 search error:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Get segments that are too short for trigram (< 3 chars).
 * These need LIKE-based fallback search.
 */
export function getShortSegments(query: string): string[] {
  const stopWords = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '没', '不', '也', '都', '就', '和', '与', '或', '吗', '呢', '吧', '啊', '哦', '嗯'])

  const segments = query.split(/[\s,，。？！、；：""''（）()\[\]{}·\-—\n\r\t]+/).filter(Boolean)
  const shorts: string[] = []

  for (const seg of segments) {
    if (charLength(seg) === 2 && !stopWords.has(seg)) {
      shorts.push(seg)
    }
  }

  return [...new Set(shorts)]
}

// --- Helpers ---

function charLength(s: string): number {
  return [...s].length
}

function escapeFTS(s: string): string {
  // Remove FTS5 special characters that could break the query
  return s.replace(/['"*^(){}[\]]/g, '').trim()
}
