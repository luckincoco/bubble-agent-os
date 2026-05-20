/**
 * MetricsCollector — buffered metric accumulation with async flush.
 * Collects MetricPoints in memory, flushes to SQLite periodically or when buffer is full.
 */

import type { MetricPoint } from './types.js'
import type { MetricsWriter } from './metrics-writer.js'
import { logger } from '../shared/logger.js'

export class MetricsCollector {
  private buffer: MetricPoint[] = []
  private writer: MetricsWriter
  private flushInterval: number
  private bufferSize: number
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(writer: MetricsWriter, opts?: { flushIntervalMs?: number; bufferSize?: number }) {
    this.writer = writer
    this.flushInterval = opts?.flushIntervalMs ?? 30_000
    this.bufferSize = opts?.bufferSize ?? 100
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.flush(), this.flushInterval)
    // Allow the timer to not prevent process exit
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Final flush on stop
    this.flush()
  }

  /**
   * Record a metric data point.
   */
  record(name: string, value: number, tags?: Record<string, string>): void {
    this.buffer.push({
      name,
      value,
      tags,
      recordedAt: Date.now(),
    })
    if (this.buffer.length >= this.bufferSize) {
      this.flush()
    }
  }

  /**
   * Convenience: increment a counter by 1.
   */
  increment(name: string, tags?: Record<string, string>): void {
    this.record(name, 1, tags)
  }

  /**
   * Flush buffered metrics to SQLite.
   */
  flush(): void {
    if (this.buffer.length === 0) return
    const batch = this.buffer.splice(0)
    try {
      this.writer.writeMetrics(batch)
    } catch (err) {
      logger.debug(`MetricsCollector: flush failed (${batch.length} points lost)`, err)
    }
  }

  /**
   * Get current buffer size (for diagnostics).
   */
  get pendingCount(): number {
    return this.buffer.length
  }
}
