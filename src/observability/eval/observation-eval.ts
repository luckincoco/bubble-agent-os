/**
 * Observation Eval — measures the quality and health of Bubble's observation system.
 *
 * Metrics computed:
 * - Survival rate: what % of observations reach 'stable' vs die at 'stale'
 * - Average lifespan: how long observations live before staling
 * - Currently active observations
 *
 * Pure SQL — zero LLM calls.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../../storage/database.js'
import type { MetricsWriter } from '../metrics-writer.js'
import type { ObservationSurvivalScore, EvalResult } from '../types.js'
import { logger } from '../../shared/logger.js'

const EVAL_PERIOD_DAYS = 30

interface ObservationRow {
  id: string
  metadata: string
  created_at: number
  updated_at: number
}

export function runObservationEval(writer: MetricsWriter, spaceId?: string): EvalResult | null {
  const db = getDatabase()
  const now = Date.now()
  const periodStart = now - EVAL_PERIOD_DAYS * 24 * 60 * 60 * 1000

  // Fetch all observation-type bubbles
  const query = spaceId
    ? `SELECT id, metadata, created_at, updated_at FROM bubbles WHERE type = 'observation' AND deleted_at IS NULL AND space_id = ?`
    : `SELECT id, metadata, created_at, updated_at FROM bubbles WHERE type = 'observation' AND deleted_at IS NULL`

  const rows = (spaceId
    ? db.prepare(query).all(spaceId)
    : db.prepare(query).all()) as ObservationRow[]

  if (rows.length === 0) {
    logger.debug('ObservationEval: no observations found, skipping')
    return null
  }

  let totalDiscovered = 0
  let reachedStable = 0
  let reachedStale = 0
  let currentActive = 0
  let totalLifespanMs = 0
  let lifespanCount = 0

  // Only consider observations discovered within the eval period
  const periodRows = rows.filter(r => r.created_at >= periodStart)
  totalDiscovered = periodRows.length

  for (const row of periodRows) {
    let meta: { trend?: string; firstSeen?: number; lastSeen?: number } = {}
    try {
      meta = JSON.parse(row.metadata)
    } catch { /* ignore */ }

    const trend = meta.trend || 'new'

    if (trend === 'stable') {
      reachedStable++
      currentActive++
    } else if (trend === 'stale') {
      reachedStale++
    } else {
      // new, strengthening, weakening — still active
      currentActive++
    }

    // Calculate lifespan
    const firstSeen = meta.firstSeen || row.created_at
    const lastSeen = meta.lastSeen || row.updated_at
    if (lastSeen > firstSeen) {
      totalLifespanMs += lastSeen - firstSeen
      lifespanCount++
    }
  }

  // Also count observations from before the period that are still active
  const olderActive = rows.filter(r => r.created_at < periodStart).filter(r => {
    try {
      const m = JSON.parse(r.metadata)
      return m.trend && m.trend !== 'stale'
    } catch { return false }
  })
  currentActive += olderActive.length

  const avgLifespanDays = lifespanCount > 0
    ? (totalLifespanMs / lifespanCount) / (24 * 60 * 60 * 1000)
    : 0

  const survivalRate = totalDiscovered > 0
    ? reachedStable / totalDiscovered
    : 0

  const scores: ObservationSurvivalScore = {
    totalDiscovered,
    reachedStable,
    reachedStale,
    avgLifespanDays: Math.round(avgLifespanDays * 10) / 10,
    survivalRate: Math.round(survivalRate * 1000) / 1000,
    currentActive,
  }

  const result: EvalResult = {
    id: ulid(),
    evalType: 'observation_survival',
    spaceId,
    runAt: now,
    periodStart,
    periodEnd: now,
    scores,
    sampleSize: totalDiscovered,
    metadata: { totalObservations: rows.length },
  }

  writer.writeEvalResult(result)
  logger.info(`ObservationEval: ${totalDiscovered} discovered, ${reachedStable} stable (${(survivalRate * 100).toFixed(1)}%), ${reachedStale} stale, ${currentActive} active`)

  return result
}
