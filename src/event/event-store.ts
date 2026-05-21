/**
 * EventStore — append-only event persistence with SHA-256 hash chain.
 * Provides immutable audit trail for all state mutations in Bubble Agent OS.
 */

import { createHash } from 'node:crypto'
import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { BubbleEventData, EventType, StoredEvent, EventMetadata } from './event-types.js'
import type { EventBus, EmitOptions } from './event-bus.js'

/** Column aliases to map DB snake_case → TypeScript camelCase. */
const EVENT_COLUMNS = 'id, type, timestamp, actor, space_id AS spaceId, payload, metadata, hash, prev_hash AS prevHash, version'

export interface AppendEventInput {
  event: BubbleEventData
  actor: string
  spaceId?: string
  metadata?: EventMetadata
}

export class EventStore {
  private lastHash: string | null = null
  private initialized = false

  /**
   * Initialize the event store. Loads the last hash from DB for chain continuation.
   */
  init(): void {
    if (this.initialized) return
    const db = getDatabase()

    // Get the last event's hash for chain continuation
    const lastEvent = db.prepare(
      'SELECT hash FROM events ORDER BY rowid DESC LIMIT 1'
    ).get() as { hash: string } | undefined

    this.lastHash = lastEvent?.hash ?? null
    this.initialized = true

    // If empty, insert genesis event
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt
    if (count === 0) {
      this.appendGenesis()
    }

    logger.info(`EventStore: initialized, chain length=${count}, lastHash=${this.lastHash?.slice(0, 8) ?? 'genesis'}`)
  }

  /**
   * Append an event to the immutable log. Returns the stored event.
   */
  append(input: AppendEventInput): StoredEvent {
    if (!this.initialized) this.init()
    const db = getDatabase()

    const id = ulid()
    const timestamp = Date.now()
    const payload = JSON.stringify(input.event.payload)
    const metadata = JSON.stringify(input.metadata || {})
    const hash = this.computeHash(this.lastHash, input.event.type, timestamp, payload)

    const stored: StoredEvent = {
      id,
      type: input.event.type,
      timestamp,
      actor: input.actor,
      spaceId: input.spaceId ?? null,
      payload,
      metadata,
      hash,
      prevHash: this.lastHash,
      version: 1,
    }

    db.prepare(`
      INSERT INTO events (id, type, timestamp, actor, space_id, payload, metadata, hash, prev_hash, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(stored.id, stored.type, stored.timestamp, stored.actor, stored.spaceId, stored.payload, stored.metadata, stored.hash, stored.prevHash, stored.version)

    this.lastHash = hash
    return stored
  }

  /**
   * Subscribe to EventBus and persist all events automatically.
   */
  subscribeToEventBus(bus: EventBus): () => void {
    return bus.onAll((event, options) => {
      this.append({
        event,
        actor: options.actor,
        spaceId: options.spaceId,
        metadata: options.metadata,
      })
    })
  }

  /**
   * Query events by type, with optional time range and limit.
   */
  getEventsByType(type: EventType | string, opts: { since?: number; until?: number; limit?: number } = {}): StoredEvent[] {
    const db = getDatabase()
    const conditions: string[] = []
    const params: unknown[] = []

    if (type.endsWith('*')) {
      // Prefix match: 'biz.*' matches all biz events
      const prefix = type.slice(0, -1)
      conditions.push('type LIKE ?')
      params.push(`${prefix}%`)
    } else {
      conditions.push('type = ?')
      params.push(type)
    }

    if (opts.since) { conditions.push('timestamp >= ?'); params.push(opts.since) }
    if (opts.until) { conditions.push('timestamp <= ?'); params.push(opts.until) }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const limit = opts.limit ? `LIMIT ${opts.limit}` : ''

    return db.prepare(`SELECT ${EVENT_COLUMNS} FROM events ${where} ORDER BY timestamp DESC ${limit}`).all(...params) as StoredEvent[]
  }

  /**
   * Get events since a specific event ID (exclusive).
   */
  getEventsSince(eventId: string, limit = 100): StoredEvent[] {
    const db = getDatabase()
    // ULID is time-ordered, so simple comparison works
    return db.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`
    ).all(eventId, limit) as StoredEvent[]
  }

  /**
   * Get the most recent N events.
   */
  getRecent(limit = 50): StoredEvent[] {
    const db = getDatabase()
    return db.prepare(
      `SELECT ${EVENT_COLUMNS} FROM events ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as StoredEvent[]
  }

  /**
   * Verify hash chain integrity. Returns the first broken link or null if valid.
   */
  verifyChain(opts: { since?: string; limit?: number } = {}): { valid: boolean; brokenAt?: string; expected?: string; actual?: string } {
    const db = getDatabase()
    const limit = opts.limit || 1000

    const col = EVENT_COLUMNS
    let query = `SELECT ${col} FROM events ORDER BY rowid ASC LIMIT ?`
    const params: unknown[] = [limit]
    if (opts.since) {
      query = `SELECT ${col} FROM events WHERE id >= ? ORDER BY rowid ASC LIMIT ?`
      params.unshift(opts.since)
    }

    const events = db.prepare(query).all(...params) as StoredEvent[]
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      const expectedHash = this.computeHash(ev.prevHash, ev.type, ev.timestamp, ev.payload)
      if (expectedHash !== ev.hash) {
        return { valid: false, brokenAt: ev.id, expected: expectedHash, actual: ev.hash }
      }
      // Also verify chain linkage
      if (i > 0 && ev.prevHash !== events[i - 1].hash) {
        return { valid: false, brokenAt: ev.id, expected: events[i - 1].hash, actual: ev.prevHash ?? 'null' }
      }
    }
    return { valid: true }
  }

  /**
   * Get event count (for diagnostics).
   */
  count(): number {
    const db = getDatabase()
    return (db.prepare('SELECT COUNT(*) as cnt FROM events').get() as { cnt: number }).cnt
  }

  // ── Private ─────────────────────────────────────────────────────

  private computeHash(prevHash: string | null, type: string, timestamp: number, payload: string): string {
    const data = `${prevHash || 'genesis'}|${type}|${timestamp}|${payload}`
    return createHash('sha256').update(data).digest('hex')
  }

  private appendGenesis(): void {
    const db = getDatabase()
    const id = ulid()
    const timestamp = Date.now()
    const type = 'system.genesis'
    const payload = JSON.stringify({ version: '0.7.0', timestamp })
    const metadata = JSON.stringify({})
    const hash = this.computeHash(null, type, timestamp, payload)

    db.prepare(`
      INSERT INTO events (id, type, timestamp, actor, space_id, payload, metadata, hash, prev_hash, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, type, timestamp, 'system:init', null, payload, metadata, hash, null, 1)

    this.lastHash = hash
    logger.info('EventStore: genesis event created')
  }
}
