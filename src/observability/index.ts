/**
 * Observability Module — public API and initialization.
 *
 * Usage:
 *   const obs = initObservability(eventBus, config)
 *   brain.setTracer(obs.tracer)
 */

import type { EventBus } from '../event/event-bus.js'
import type { ObservabilityConfig } from './types.js'
import { DEFAULT_OBS_CONFIG } from './types.js'
import { MetricsWriter } from './metrics-writer.js'
import { MetricsCollector } from './metrics-collector.js'
import { Tracer } from './tracer.js'
import { logger } from '../shared/logger.js'

export interface ObservabilityModule {
  tracer: Tracer
  metrics: MetricsCollector
  writer: MetricsWriter
  stop(): void
}

/**
 * Initialize the observability subsystem.
 * Wires up EventBus subscriptions for automatic metric collection.
 */
export function initObservability(
  eventBus: EventBus | undefined,
  config?: Partial<ObservabilityConfig>,
): ObservabilityModule {
  const cfg: ObservabilityConfig = { ...DEFAULT_OBS_CONFIG, ...config }

  const writer = new MetricsWriter()
  writer.init()

  const metrics = new MetricsCollector(writer, {
    flushIntervalMs: cfg.metricsFlushIntervalMs,
    bufferSize: cfg.metricsBufferSize,
  })
  metrics.start()

  const tracer = new Tracer(writer, metrics, cfg.tracingLevel)

  // Wire EventBus subscriptions for passive metric collection
  if (eventBus) {
    wireEventMetrics(eventBus, metrics)
  }

  logger.info(`Module: Observability enabled (tracing=${cfg.tracingLevel})`)

  return {
    tracer,
    metrics,
    writer,
    stop() {
      metrics.stop()
    },
  }
}

/**
 * Subscribe to EventBus events and auto-collect metrics.
 * Zero modification to existing modules — pure listener.
 */
function wireEventMetrics(eventBus: EventBus, metrics: MetricsCollector): void {
  // Observation lifecycle
  eventBus.onPrefix('memory.observation.', (event) => {
    metrics.increment('obs.lifecycle', { event_type: event.type })
  })

  // Knowledge events (causal evaluation outcomes)
  eventBus.onPrefix('knowledge.observation.', (event) => {
    metrics.increment('knowledge.observation', { event_type: event.type })
  })

  // Compaction events
  eventBus.on('memory.compaction.completed', (event) => {
    const payload = event.payload as { sourceIds: string[] }
    metrics.record('compaction.source_count', payload.sourceIds?.length ?? 0)
  })

  // Decay events
  eventBus.on('memory.decay.applied', (event) => {
    const payload = event.payload as { affectedCount: number; deletedCount: number }
    metrics.record('decay.affected', payload.affectedCount)
    metrics.record('decay.deleted', payload.deletedCount)
  })

  // Scheduler task completion
  eventBus.on('system.scheduler.task_completed', (event) => {
    const payload = event.payload as { taskName: string; duration: number }
    metrics.record('task.duration_ms', payload.duration, { task: payload.taskName })
  })

  // Bubble creation (memory volume tracking)
  eventBus.on('memory.bubble.created', (event) => {
    const payload = event.payload as { bubbleType: string }
    metrics.increment('bubble.created', { type: payload.bubbleType })
  })

  // Urgency detection
  eventBus.on('knowledge.urgency.detected', (event) => {
    const payload = event.payload as { dimension: string; urgency: string }
    metrics.increment('urgency.detected', { dimension: payload.dimension, urgency: payload.urgency })
  })
}

// Re-exports for convenience
export { Tracer, TraceContext, SpanHandle } from './tracer.js'
export { MetricsCollector } from './metrics-collector.js'
export { MetricsWriter } from './metrics-writer.js'
export type { ObservabilityConfig, TracingLevel } from './types.js'
