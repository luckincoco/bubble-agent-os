/**
 * WorkingMemory — autonomous memory tier management (Letta/MemGPT inspired).
 * Manages hot/warm/cold tiers with priority-based eviction.
 * The agent can self-manage what's in its "context window" via tools.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { Bubble, WorkingMemoryEntry } from '../shared/types.js'
import { estimateTokens } from '../shared/tokens.js'

const DEFAULT_TOKEN_BUDGET = 8000
const PIN_BONUS = 10.0
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000  // 24 hours

interface WmRow {
  id: string
  session_id: string
  bubble_id: string
  tier: string
  priority_score: number
  pinned: number
  loaded_at: number
  last_accessed: number
  token_cost: number
}

function rowToEntry(row: WmRow): WorkingMemoryEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    bubbleId: row.bubble_id,
    tier: row.tier as 'hot' | 'warm' | 'cold',
    priorityScore: row.priority_score,
    pinned: row.pinned === 1,
    loadedAt: row.loaded_at,
    lastAccessed: row.last_accessed,
    tokenCost: row.token_cost,
  }
}

export interface PriorityFactors {
  recency: number     // 0-1 based on last_accessed freshness
  relevance: number   // 0-1 cosine similarity to current query
  confidence: number  // 0-1 from bubble.confidence
  focusBoost: number  // 0-0.15 from FocusTracker
}

export class WorkingMemory {
  private tokenBudget: number

  constructor(tokenBudget = DEFAULT_TOKEN_BUDGET) {
    this.tokenBudget = tokenBudget
  }

  /**
   * Load a bubble into hot tier. If budget exceeded, auto-evict lowest priority.
   */
  load(sessionId: string, bubble: Bubble, factors: PriorityFactors): WorkingMemoryEntry {
    const db = getDatabase()
    const now = Date.now()

    // Check if already loaded
    const existing = db.prepare(
      'SELECT * FROM working_memory WHERE session_id = ? AND bubble_id = ?'
    ).get(sessionId, bubble.id) as WmRow | undefined

    if (existing) {
      // Update tier to hot and refresh access time
      db.prepare(
        "UPDATE working_memory SET tier = 'hot', last_accessed = ?, priority_score = ? WHERE id = ?"
      ).run(now, this.computePriority(factors, false), existing.id)
      return { ...rowToEntry(existing), tier: 'hot', lastAccessed: now }
    }

    // Estimate token cost
    const tokenCost = estimateTokens(bubble.content + (bubble.summary || ''))
    const priority = this.computePriority(factors, false)

    // Check budget and evict if needed
    this.ensureBudget(sessionId, tokenCost)

    const id = ulid()
    db.prepare(`
      INSERT INTO working_memory (id, session_id, bubble_id, tier, priority_score, pinned, loaded_at, last_accessed, token_cost)
      VALUES (?, ?, ?, 'hot', ?, 0, ?, ?, ?)
    `).run(id, sessionId, bubble.id, priority, now, now, tokenCost)

    return { id, sessionId, bubbleId: bubble.id, tier: 'hot', priorityScore: priority, pinned: false, loadedAt: now, lastAccessed: now, tokenCost }
  }

  /**
   * Evict a bubble from working memory (move to cold or remove).
   */
  evict(sessionId: string, bubbleId: string): void {
    const db = getDatabase()
    const entry = db.prepare(
      'SELECT * FROM working_memory WHERE session_id = ? AND bubble_id = ?'
    ).get(sessionId, bubbleId) as WmRow | undefined

    if (!entry) return
    if (entry.pinned) {
      logger.warn(`WorkingMemory: cannot evict pinned bubble ${bubbleId}`)
      return
    }

    db.prepare('DELETE FROM working_memory WHERE id = ?').run(entry.id)
  }

  /**
   * Pin a bubble — it will never be auto-evicted.
   */
  pin(sessionId: string, bubbleId: string): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE working_memory SET pinned = 1, priority_score = priority_score + ? WHERE session_id = ? AND bubble_id = ?'
    ).run(PIN_BONUS, sessionId, bubbleId)
  }

  /**
   * Unpin a bubble — it can now be auto-evicted.
   */
  unpin(sessionId: string, bubbleId: string): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE working_memory SET pinned = 0, priority_score = priority_score - ? WHERE session_id = ? AND bubble_id = ?'
    ).run(PIN_BONUS, sessionId, bubbleId)
  }

  /**
   * Get all entries in hot tier for a session (what's "in context").
   */
  getHotItems(sessionId: string): WorkingMemoryEntry[] {
    const db = getDatabase()
    const rows = db.prepare(
      "SELECT * FROM working_memory WHERE session_id = ? AND tier = 'hot' ORDER BY priority_score DESC"
    ).all(sessionId) as WmRow[]
    return rows.map(rowToEntry)
  }

  /**
   * Get all entries across all tiers for a session.
   */
  getAllItems(sessionId: string): WorkingMemoryEntry[] {
    const db = getDatabase()
    const rows = db.prepare(
      'SELECT * FROM working_memory WHERE session_id = ? ORDER BY priority_score DESC'
    ).all(sessionId) as WmRow[]
    return rows.map(rowToEntry)
  }

  /**
   * Get working memory status summary (for agent self-awareness).
   */
  getStatus(sessionId: string): { hotCount: number; hotTokens: number; warmCount: number; coldCount: number; budgetTotal: number; budgetUsed: number } {
    const db = getDatabase()
    const stats = db.prepare(`
      SELECT tier, COUNT(*) as cnt, COALESCE(SUM(token_cost), 0) as tokens
      FROM working_memory WHERE session_id = ?
      GROUP BY tier
    `).all(sessionId) as Array<{ tier: string; cnt: number; tokens: number }>

    let hotCount = 0, hotTokens = 0, warmCount = 0, coldCount = 0
    for (const s of stats) {
      if (s.tier === 'hot') { hotCount = s.cnt; hotTokens = s.tokens }
      else if (s.tier === 'warm') warmCount = s.cnt
      else if (s.tier === 'cold') coldCount = s.cnt
    }

    return { hotCount, hotTokens, warmCount, coldCount, budgetTotal: this.tokenBudget, budgetUsed: hotTokens }
  }

  /**
   * Touch: update last_accessed timestamp (called when a hot item is referenced in response).
   */
  touch(sessionId: string, bubbleId: string): void {
    const db = getDatabase()
    db.prepare(
      'UPDATE working_memory SET last_accessed = ? WHERE session_id = ? AND bubble_id = ?'
    ).run(Date.now(), sessionId, bubbleId)
  }

  /**
   * Demote: move items from hot to warm based on staleness.
   * Called periodically or before context assembly.
   */
  demoteStaleItems(sessionId: string, maxAgeMs = 30 * 60 * 1000): number {
    const db = getDatabase()
    const cutoff = Date.now() - maxAgeMs
    const result = db.prepare(
      "UPDATE working_memory SET tier = 'warm' WHERE session_id = ? AND tier = 'hot' AND pinned = 0 AND last_accessed < ?"
    ).run(sessionId, cutoff)
    return result.changes
  }

  /**
   * Cleanup: remove sessions older than 24h.
   */
  cleanupExpiredSessions(): number {
    const db = getDatabase()
    const cutoff = Date.now() - SESSION_EXPIRY_MS
    const result = db.prepare(
      'DELETE FROM working_memory WHERE loaded_at < ?'
    ).run(cutoff)
    if (result.changes > 0) {
      logger.info(`WorkingMemory: cleaned up ${result.changes} expired entries`)
    }
    return result.changes
  }

  /**
   * Clear a specific session's working memory.
   */
  clearSession(sessionId: string): void {
    const db = getDatabase()
    db.prepare('DELETE FROM working_memory WHERE session_id = ?').run(sessionId)
  }

  // ── Private ─────────────────────────────────────────────────────

  private computePriority(factors: PriorityFactors, pinned: boolean): number {
    const base = (0.3 * factors.recency) + (0.4 * factors.relevance) + (0.2 * factors.confidence) + (0.1 * factors.focusBoost)
    return base + (pinned ? PIN_BONUS : 0)
  }

  private ensureBudget(sessionId: string, additionalTokens: number): void {
    const db = getDatabase()
    const currentUsage = (db.prepare(
      "SELECT COALESCE(SUM(token_cost), 0) as total FROM working_memory WHERE session_id = ? AND tier = 'hot'"
    ).get(sessionId) as { total: number }).total

    if (currentUsage + additionalTokens <= this.tokenBudget) return

    // Need to evict — get lowest priority non-pinned items
    const candidates = db.prepare(
      "SELECT * FROM working_memory WHERE session_id = ? AND tier = 'hot' AND pinned = 0 ORDER BY priority_score ASC"
    ).all(sessionId) as WmRow[]

    let freed = 0
    const needed = (currentUsage + additionalTokens) - this.tokenBudget
    for (const c of candidates) {
      if (freed >= needed) break
      // Move to warm instead of deleting
      db.prepare("UPDATE working_memory SET tier = 'warm' WHERE id = ?").run(c.id)
      freed += c.token_cost
    }

    if (freed < needed) {
      logger.warn(`WorkingMemory: could not free enough tokens (needed ${needed}, freed ${freed})`)
    }
  }
}
