/**
 * System Health Eval — measures operational health metrics.
 *
 * Metrics:
 * - Token utilization (working memory fill rate)
 * - LLM latency percentiles (p50, p95) from traces
 * - Compaction reduction ratio
 * - Daily token consumption estimate
 * - Scheduler task success rate
 *
 * Pure SQL — zero LLM calls.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../../storage/database.js'
import type { MetricsWriter } from '../metrics-writer.js'
import type { SystemHealthScore, EvalResult } from '../types.js'
import { logger } from '../../shared/logger.js'

const EVAL_PERIOD_HOURS = 24

export function runSystemHealthEval(writer: MetricsWriter, spaceId?: string): EvalResult | null {
  const db = getDatabase()
  const now = Date.now()
  const periodStart = now - EVAL_PERIOD_HOURS * 60 * 60 * 1000

  // 1. LLM latency from traces
  const latencies = db.prepare(`
    SELECT duration_ms FROM traces
    WHERE trace_type = 'think' AND started_at >= ? AND status = 'ok'
    ORDER BY duration_ms ASC
  `).all(periodStart) as Array<{ duration_ms: number }>

  let llmLatencyP50 = 0
  let llmLatencyP95 = 0
  if (latencies.length > 0) {
    const p50Idx = Math.floor(latencies.length * 0.5)
    const p95Idx = Math.floor(latencies.length * 0.95)
    llmLatencyP50 = latencies[p50Idx]?.duration_ms ?? 0
    llmLatencyP95 = latencies[p95Idx]?.duration_ms ?? 0
  }

  // 2. Token consumption estimate from metrics table
  const tokenMetrics = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total FROM metrics
    WHERE name = 'trace.think.duration_ms' AND recorded_at >= ?
  `).get(periodStart) as { total: number }
  // Rough estimate: 1ms LLM time ≈ 5 tokens (heuristic for DeepSeek)
  const dailyTokenConsumption = Math.round(tokenMetrics.total * 5)

  // 3. Task success rate from events
  const taskEvents = db.prepare(`
    SELECT payload FROM events
    WHERE type = 'system.scheduler.task_completed' AND timestamp >= ?
  `).all(periodStart) as Array<{ payload: string }>

  let taskTotal = taskEvents.length
  let taskSuccess = 0
  for (const e of taskEvents) {
    try {
      const p = JSON.parse(e.payload)
      if (p.result !== 'error' && p.result !== 'failed') taskSuccess++
    } catch {
      taskSuccess++ // assume success if payload doesn't indicate failure
    }
  }
  const taskSuccessRate = taskTotal > 0 ? taskSuccess / taskTotal : 1

  // 4. Working memory utilization
  const wmStats = db.prepare(`
    SELECT AVG(token_cost) as avg_cost, COUNT(*) as cnt FROM working_memory WHERE tier = 'hot'
  `).get() as { avg_cost: number | null; cnt: number }
  const totalBudget = 8000 // default context budget for WM
  const avgTokenUtilization = wmStats.avg_cost
    ? Math.min(1, (wmStats.avg_cost * wmStats.cnt) / totalBudget)
    : 0

  // 5. Compaction reduction ratio from events
  const compactionEvents = db.prepare(`
    SELECT payload FROM events
    WHERE type = 'memory.compaction.completed' AND timestamp >= ?
  `).all(periodStart) as Array<{ payload: string }>

  let compactionReductionRatio = 0
  if (compactionEvents.length > 0) {
    let totalSources = 0
    for (const e of compactionEvents) {
      try {
        const p = JSON.parse(e.payload)
        totalSources += (p.sourceIds?.length ?? 0)
      } catch { /* ignore */ }
    }
    // ratio = total sources compressed / number of synthesis bubbles produced
    compactionReductionRatio = compactionEvents.length > 0
      ? totalSources / compactionEvents.length
      : 0
  }

  const scores: SystemHealthScore = {
    avgTokenUtilization: Math.round(avgTokenUtilization * 1000) / 1000,
    compactionReductionRatio: Math.round(compactionReductionRatio * 10) / 10,
    llmLatencyP50,
    llmLatencyP95,
    dailyTokenConsumption,
    taskSuccessRate: Math.round(taskSuccessRate * 1000) / 1000,
  }

  const result: EvalResult = {
    id: ulid(),
    evalType: 'system_health',
    spaceId,
    runAt: now,
    periodStart,
    periodEnd: now,
    scores,
    sampleSize: latencies.length + taskTotal,
    metadata: { traceCount: latencies.length, taskCount: taskTotal, compactionCount: compactionEvents.length },
  }

  writer.writeEvalResult(result)
  logger.info(`SystemHealthEval: p50=${llmLatencyP50}ms p95=${llmLatencyP95}ms, tasks=${taskSuccess}/${taskTotal}, WM util=${(avgTokenUtilization * 100).toFixed(0)}%`)

  return result
}
