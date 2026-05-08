/**
 * EventBus — in-process typed pub/sub for Bubble Agent OS.
 * Components emit events; listeners react asynchronously.
 * All events flow through a single bus instance.
 */

import type { BubbleEventData, EventType, EventMetadata } from './event-types.js'
import { logger } from '../shared/logger.js'

export interface EmitOptions {
  actor: string
  spaceId?: string
  metadata?: EventMetadata
}

type EventListener = (event: BubbleEventData, options: EmitOptions) => void | Promise<void>

export class EventBus {
  private listeners = new Map<string, EventListener[]>()
  private globalListeners: EventListener[] = []

  /**
   * Subscribe to a specific event type.
   * Use '*' or call onAll() to listen to all events.
   */
  on(type: EventType | EventType[], listener: EventListener): () => void {
    const types = Array.isArray(type) ? type : [type]
    for (const t of types) {
      const list = this.listeners.get(t) || []
      list.push(listener)
      this.listeners.set(t, list)
    }
    // Return unsubscribe function
    return () => {
      for (const t of types) {
        const list = this.listeners.get(t)
        if (list) {
          const idx = list.indexOf(listener)
          if (idx >= 0) list.splice(idx, 1)
        }
      }
    }
  }

  /**
   * Subscribe to a wildcard pattern (e.g. 'biz.*' matches all biz events).
   */
  onPrefix(prefix: string, listener: EventListener): () => void {
    // We store prefix listeners as global with filter
    const wrappedListener: EventListener = (event, options) => {
      if (event.type.startsWith(prefix)) {
        return listener(event, options)
      }
    }
    this.globalListeners.push(wrappedListener)
    return () => {
      const idx = this.globalListeners.indexOf(wrappedListener)
      if (idx >= 0) this.globalListeners.splice(idx, 1)
    }
  }

  /**
   * Subscribe to ALL events (global listener).
   */
  onAll(listener: EventListener): () => void {
    this.globalListeners.push(listener)
    return () => {
      const idx = this.globalListeners.indexOf(listener)
      if (idx >= 0) this.globalListeners.splice(idx, 1)
    }
  }

  /**
   * Emit an event. Listeners are called synchronously in registration order.
   * Errors in listeners are logged but do not prevent other listeners from running.
   */
  async emit(event: BubbleEventData, options: EmitOptions): Promise<void> {
    const typeListeners = this.listeners.get(event.type) || []
    const allListeners = [...typeListeners, ...this.globalListeners]

    for (const listener of allListeners) {
      try {
        await listener(event, options)
      } catch (err) {
        logger.error(`EventBus: listener error for ${event.type}:`, err instanceof Error ? err.message : String(err))
      }
    }
  }

  /**
   * Emit without awaiting — fire-and-forget for non-critical listeners.
   */
  emitFireAndForget(event: BubbleEventData, options: EmitOptions): void {
    this.emit(event, options).catch(err => {
      logger.error(`EventBus: unhandled emit error for ${event.type}:`, err instanceof Error ? err.message : String(err))
    })
  }

  /**
   * Get count of registered listeners (for diagnostics).
   */
  listenerCount(): { typed: number; global: number } {
    let typed = 0
    for (const list of this.listeners.values()) typed += list.length
    return { typed, global: this.globalListeners.length }
  }

  /**
   * Remove all listeners (for testing/shutdown).
   */
  clear(): void {
    this.listeners.clear()
    this.globalListeners = []
  }
}
