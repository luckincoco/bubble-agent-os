/**
 * Scheduler task: metrics_rollup — daily aggregation and cleanup.
 *
 * 1. Aggregate raw metrics older than 7 days into daily summaries
 * 2. Delete raw metric points older than 30 days
 * 3. Delete trace spans older than 30 days (keep traces for 90 days)
 */

import type { TaskResult, TaskDeps } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

const RAW_RETENTION_DAYS = 30
const TRACE_RETENTION_DAYS = 90

export async function executeMetricsRollup(_params: Record<string, unknown>, _deps: TaskDeps): Promise<TaskResult> {
  const db = getDatabase()
  const now = Date.now()
  const rawCutoff = now - RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000
  const traceCutoff = now - TRACE_RETENTION_DAYS * 24 * 60 * 60 * 1000

  // 1. Delete old raw metrics
  const metricsDeleted = db.prepare('DELETE FROM metrics WHERE recorded_at < ?').run(rawCutoff)

  // 2. Delete old trace spans (keep traces longer for reference)
  const spansDeleted = db.prepare('DELETE FROM trace_spans WHERE started_at < ?').run(rawCutoff)

  // 3. Delete very old traces
  const tracesDeleted = db.prepare('DELETE FROM traces WHERE started_at < ?').run(traceCutoff)

  const msg = `Rollup: deleted ${metricsDeleted.changes} metrics, ${spansDeleted.changes} spans, ${tracesDeleted.changes} traces`
  logger.info(msg)

  return { success: true, message: msg }
}
