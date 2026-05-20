import type Database from 'better-sqlite3'
import { logger } from '../shared/logger.js'

/** Tokenize text into meaningful terms (2+ chars, lowercased) */
export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .split(/[\s,，。？！、；：""''（）()\[\]{}·\-—\n]+/)
      .filter(t => t.length >= 2)
  )
}

interface UserFocus {
  messages: string[]
  terms: Map<string, number>  // term -> frequency
}

/**
 * Tracks user conversation focus via a sliding window of recent messages.
 * Computes a boost score (0~0.15) for bubble content that overlaps with
 * the user's current focus terms.
 */
export class FocusTracker {
  private focusMap = new Map<string, UserFocus>()
  private readonly WINDOW_SIZE = 10
  private readonly MAX_BOOST = 0.15

  /** Record a new user message, maintaining the sliding window */
  record(userId: string, message: string): void {
    let focus = this.focusMap.get(userId)
    if (!focus) {
      focus = { messages: [], terms: new Map() }
      this.focusMap.set(userId, focus)
    }

    focus.messages.push(message)

    // Trim to window size
    if (focus.messages.length > this.WINDOW_SIZE) {
      focus.messages = focus.messages.slice(-this.WINDOW_SIZE)
    }

    // Recompute term frequencies from the entire window
    focus.terms.clear()
    for (const msg of focus.messages) {
      const tokens = tokenize(msg)
      for (const t of tokens) {
        focus.terms.set(t, (focus.terms.get(t) || 0) + 1)
      }
    }

    logger.debug(`FocusTracker: user=${userId}, terms=${focus.terms.size}, window=${focus.messages.length}`)
  }

  /** Persist current message window to database (full replace per user) */
  persistToDatabase(db: Database.Database): void {
    const insert = db.prepare('INSERT INTO focus_messages (user_id, message, updated_at) VALUES (?, ?, ?)')
    const del = db.prepare('DELETE FROM focus_messages WHERE user_id = ?')
    const txn = db.transaction(() => {
      for (const userId of this.focusMap.keys()) {
        const focus = this.focusMap.get(userId)!
        del.run(userId)
        const now = Date.now()
        for (const msg of focus.messages) {
          insert.run(userId, msg, now)
        }
      }
    })
    txn()
  }

  /** Restore message windows from database for all users */
  loadFromDatabase(db: Database.Database): void {
    const rows = db.prepare(
      'SELECT user_id, message FROM focus_messages ORDER BY user_id, updated_at',
    ).all() as Array<{ user_id: string; message: string }>

    // Group messages by user, rebuild window
    const grouped = new Map<string, string[]>()
    for (const row of rows) {
      const list = grouped.get(row.user_id) || []
      list.push(row.message)
      grouped.set(row.user_id, list)
    }

    let loadedCount = 0
    for (const [userId, messages] of grouped) {
      const window = messages.slice(-this.WINDOW_SIZE)
      const focus: UserFocus = { messages: window, terms: new Map() }
      for (const msg of window) {
        const tokens = tokenize(msg)
        for (const t of tokens) {
          focus.terms.set(t, (focus.terms.get(t) || 0) + 1)
        }
      }
      this.focusMap.set(userId, focus)
      loadedCount++
    }

    if (loadedCount > 0) {
      logger.info(`FocusTracker: loaded ${loadedCount} user windows (${rows.length} messages) from database`)
    }
  }

  /**
   * Compute a focus boost for a piece of bubble content.
   * Returns 0 if no focus data, up to MAX_BOOST if high overlap.
   */
  /** Get top frequent terms for a user (sorted by frequency desc) */
  getTopTerms(userId: string, minFreq = 2, limit = 10): Array<{ term: string; freq: number }> {
    const focus = this.focusMap.get(userId)
    if (!focus || focus.terms.size === 0) return []
    return [...focus.terms.entries()]
      .filter(([, freq]) => freq >= minFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([term, freq]) => ({ term, freq }))
  }

  /** Get all user IDs that have focus data */
  getActiveUserIds(): string[] {
    return [...this.focusMap.keys()]
  }

  /** Get the current message window size for a user */
  getWindowSize(userId: string): number {
    return this.focusMap.get(userId)?.messages.length ?? 0
  }

  computeFocusBoost(userId: string, bubbleContent: string): number {
    const focus = this.focusMap.get(userId)
    if (!focus || focus.terms.size === 0) return 0

    const contentTokens = tokenize(bubbleContent)
    if (contentTokens.size === 0) return 0

    let matchWeight = 0
    let totalWeight = 0

    for (const [term, freq] of focus.terms) {
      totalWeight += freq
      if (contentTokens.has(term)) {
        matchWeight += freq
      }
    }

    if (totalWeight === 0) return 0

    // Normalize overlap ratio and cap at MAX_BOOST
    const ratio = matchWeight / totalWeight
    return Math.min(ratio * this.MAX_BOOST * 2, this.MAX_BOOST)
  }
}
