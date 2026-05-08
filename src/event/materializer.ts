/**
 * Materializer — subscribes to EventBus and applies events to materialized views.
 * This is the bridge between the event-sourced audit log and the existing state tables.
 * Each event type maps to a handler that mutates the relevant table.
 *
 * Design: Thin layer. EventStore persists the event; Materializer updates state tables.
 * Both happen in the same logical flow (not eventually consistent).
 */

import type { EventBus } from './event-bus.js'
import type { BubbleEventData } from './event-types.js'
import type { EmitOptions } from './event-bus.js'
import { logger } from '../shared/logger.js'

export type MaterializeHandler = (event: BubbleEventData, options: EmitOptions) => void | Promise<void>

export class Materializer {
  private handlers = new Map<string, MaterializeHandler>()

  /**
   * Register a handler for a specific event type.
   */
  register(type: string, handler: MaterializeHandler): void {
    this.handlers.set(type, handler)
  }

  /**
   * Register a handler for all events matching a prefix (e.g. 'biz.*').
   */
  registerPrefix(prefix: string, handler: MaterializeHandler): void {
    // Store with prefix marker
    this.handlers.set(`prefix:${prefix}`, handler)
  }

  /**
   * Subscribe to EventBus. Called once during initialization.
   * The materializer processes events AFTER EventStore has persisted them.
   */
  subscribeTo(bus: EventBus): () => void {
    return bus.onAll(async (event, options) => {
      await this.materialize(event, options)
    })
  }

  /**
   * Apply an event to its registered handler.
   */
  async materialize(event: BubbleEventData, options: EmitOptions): Promise<void> {
    // Try exact match first
    const exactHandler = this.handlers.get(event.type)
    if (exactHandler) {
      try {
        await exactHandler(event, options)
      } catch (err) {
        logger.error(`Materializer: handler error for ${event.type}:`, err instanceof Error ? err.message : String(err))
      }
      return
    }

    // Try prefix matches
    for (const [key, handler] of this.handlers) {
      if (key.startsWith('prefix:')) {
        const prefix = key.slice(7)
        if (event.type.startsWith(prefix)) {
          try {
            await handler(event, options)
          } catch (err) {
            logger.error(`Materializer: prefix handler error for ${event.type}:`, err instanceof Error ? err.message : String(err))
          }
          return
        }
      }
    }

    // No handler — this is fine for many event types (they're just audit trail)
  }

  /**
   * Replay events through materializer (for state reconstruction).
   * Use with caution — this re-applies all events to current state.
   */
  async replay(events: BubbleEventData[], optionsList: EmitOptions[]): Promise<{ processed: number; errors: number }> {
    let processed = 0
    let errors = 0

    for (let i = 0; i < events.length; i++) {
      try {
        await this.materialize(events[i], optionsList[i])
        processed++
      } catch {
        errors++
      }
    }

    logger.info(`Materializer replay: ${processed} processed, ${errors} errors`)
    return { processed, errors }
  }

  /**
   * Get count of registered handlers.
   */
  handlerCount(): number {
    return this.handlers.size
  }
}
