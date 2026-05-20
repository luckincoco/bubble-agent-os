/**
 * Resonance Integration — wires ResonanceTracker into the EventBus.
 *
 * Listens for:
 * - memory.observation.discovered → records activation path
 * - memory.compaction.completed → records cluster-level activation
 * - knowledge.concept.forged → records concept as activation
 *
 * Provides:
 * - shouldEmitPattern(): anti-double-emit gate check
 * - recordPatternEmission(): mark pattern as emitted
 */

import type { EventBus } from '../../event/event-bus.js'
import type { BubbleEventData } from '../../event/event-types.js'
import type { EmitOptions } from '../../event/event-bus.js'
import { ResonanceTracker, generateSignatureHash } from './resonance-tracker.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

export class ResonanceIntegration {
  private tracker: ResonanceTracker
  private unsubscribers: Array<() => void> = []

  constructor() {
    this.tracker = new ResonanceTracker()
  }

  get resonanceTracker(): ResonanceTracker {
    return this.tracker
  }

  /**
   * Wire into the EventBus. Call once during initialization.
   */
  subscribeTo(bus: EventBus): void {
    // Listen for new observations being discovered
    const unsub1 = bus.on('memory.observation.discovered', (event, options) => {
      this.handleObservationDiscovered(event, options)
    })
    this.unsubscribers.push(unsub1)

    // Listen for compaction completions (cluster = co-activated observations)
    const unsub2 = bus.on('memory.compaction.completed', (event, options) => {
      this.handleCompactionCompleted(event, options)
    })
    this.unsubscribers.push(unsub2)

    // Listen for concept forge results
    const unsub3 = bus.on('knowledge.concept.forged', (event, options) => {
      this.handleConceptForged(event, options)
    })
    this.unsubscribers.push(unsub3)

    logger.info('ResonanceIntegration: subscribed to EventBus')
  }

  /**
   * Check if a pattern should be shown to user (anti-double-emit gate).
   * Returns false if pattern is suppressed.
   */
  shouldEmitPattern(content: string): boolean {
    const hash = generateSignatureHash(content)
    return !this.tracker.shouldSuppress(hash)
  }

  /**
   * Mark a pattern as emitted to user.
   */
  recordPatternEmission(content: string): void {
    const hash = generateSignatureHash(content)
    this.tracker.recordEmission(hash)
  }

  /**
   * User acknowledged a pattern (responded to it).
   */
  recordUserAcknowledgement(content: string): void {
    const hash = generateSignatureHash(content)
    this.tracker.recordAcknowledgement(hash)
  }

  /**
   * Find resonant paths for current conversation context.
   */
  findResonantPaths(context: string, spaceId?: string) {
    return this.tracker.findMatchingPaths(context, spaceId)
  }

  /**
   * Cleanup subscriptions on shutdown.
   */
  destroy(): void {
    for (const unsub of this.unsubscribers) unsub()
    this.unsubscribers = []
  }

  // ── Event handlers ───────────────────────────────────────────

  private handleObservationDiscovered(event: BubbleEventData, options: EmitOptions): void {
    if (event.type !== 'memory.observation.discovered') return
    const { observationId, title } = event.payload

    this.tracker.recordActivation({
      triggerContext: title,
      observationIds: [observationId],
      spaceId: options.spaceId,
    })
  }

  private handleCompactionCompleted(event: BubbleEventData, options: EmitOptions): void {
    if (event.type !== 'memory.compaction.completed') return
    const { synthesisId, sourceIds } = event.payload

    // A compaction cluster = multiple observations activated together
    // Use the synthesis bubble's content as trigger context
    const db = getDatabase()
    const synthesis = db.prepare('SELECT title FROM bubbles WHERE id = ?').get(synthesisId) as { title: string } | undefined
    if (!synthesis) return

    this.tracker.recordActivation({
      triggerContext: synthesis.title,
      observationIds: sourceIds,
      spaceId: options.spaceId,
    })
  }

  private handleConceptForged(event: BubbleEventData, options: EmitOptions): void {
    if (event.type !== 'knowledge.concept.forged') return
    const { conceptId, name, sourceNodes } = event.payload

    this.tracker.recordActivation({
      triggerContext: name,
      observationIds: sourceNodes,
      structureType: '模式发现',
      spaceId: options.spaceId,
    })
  }
}
