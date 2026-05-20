/**
 * Causal Eval — measures the accuracy of CausalEvaluator verdicts.
 *
 * Strategy: When CausalEvaluator emits 'contradicts' or 'confirms' verdicts,
 * check whether the affected observations actually weakened/strengthened
 * within 7 days of the verdict.
 *
 * Pure SQL — zero LLM calls.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../../storage/database.js'
import type { MetricsWriter } from '../metrics-writer.js'
import type { CausalAccuracyScore, EvalResult } from '../types.js'
import { logger } from '../../shared/logger.js'

const EVAL_PERIOD_DAYS = 30
const VERDICT_WINDOW_DAYS = 7

export function runCausalEval(writer: MetricsWriter, spaceId?: string): EvalResult | null {
  const db = getDatabase()
  const now = Date.now()
  const periodStart = now - EVAL_PERIOD_DAYS * 24 * 60 * 60 * 1000
  const verdictWindow = VERDICT_WINDOW_DAYS * 24 * 60 * 60 * 1000

  // Get all causal urgency events (which represent evaluated verdicts)
  const urgencyEvents = db.prepare(`
    SELECT id, timestamp, payload FROM events
    WHERE type = 'knowledge.urgency.detected' AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(periodStart) as Array<{ id: string; timestamp: number; payload: string }>

  if (urgencyEvents.length === 0) {
    logger.debug('CausalEval: no urgency events found, skipping')
    return null
  }

  // Get observation strengthened/weakened/killed events for cross-reference
  const obsEvents = db.prepare(`
    SELECT type, timestamp, payload FROM events
    WHERE (type = 'knowledge.observation.strengthened' OR type = 'knowledge.observation.weakened' OR type = 'knowledge.observation.killed')
    AND timestamp >= ?
    ORDER BY timestamp ASC
  `).all(periodStart) as Array<{ type: string; timestamp: number; payload: string }>

  let totalVerdicts = urgencyEvents.length
  let contradictionCorrect = 0
  let contradictionTotal = 0
  let confirmationCorrect = 0
  let confirmationTotal = 0
  let totalConfidence = 0

  for (const event of urgencyEvents) {
    let payload: { impactType?: string; bubbleId?: string; dimension?: string } = {}
    try { payload = JSON.parse(event.payload) } catch { continue }

    const impactType = payload.impactType
    if (!impactType) continue

    // Look for subsequent observation events that validate or invalidate this verdict
    const subsequentEvents = obsEvents.filter(e =>
      e.timestamp > event.timestamp &&
      e.timestamp <= event.timestamp + verdictWindow
    )

    if (impactType === 'contradicts') {
      contradictionTotal++
      // Did any observation actually weaken or get killed after?
      const weakened = subsequentEvents.some(e =>
        e.type === 'knowledge.observation.weakened' || e.type === 'knowledge.observation.killed'
      )
      if (weakened) contradictionCorrect++
    } else if (impactType === 'confirms') {
      confirmationTotal++
      // Did any observation strengthen after?
      const strengthened = subsequentEvents.some(e =>
        e.type === 'knowledge.observation.strengthened'
      )
      if (strengthened) confirmationCorrect++
    }

    totalConfidence++
  }

  const contradictionPrecision = contradictionTotal > 0
    ? contradictionCorrect / contradictionTotal
    : 0
  const confirmationPrecision = confirmationTotal > 0
    ? confirmationCorrect / confirmationTotal
    : 0

  const scores: CausalAccuracyScore = {
    totalVerdicts,
    contradictionPrecision: Math.round(contradictionPrecision * 1000) / 1000,
    confirmationPrecision: Math.round(confirmationPrecision * 1000) / 1000,
    avgConfidence: 0, // TODO: extract from verdict metadata when available
  }

  const result: EvalResult = {
    id: ulid(),
    evalType: 'causal_accuracy',
    spaceId,
    runAt: now,
    periodStart,
    periodEnd: now,
    scores,
    sampleSize: totalVerdicts,
    metadata: { contradictionTotal, confirmationTotal },
  }

  writer.writeEvalResult(result)
  logger.info(`CausalEval: ${totalVerdicts} verdicts, contradiction precision=${(contradictionPrecision * 100).toFixed(0)}%, confirmation precision=${(confirmationPrecision * 100).toFixed(0)}%`)

  return result
}
