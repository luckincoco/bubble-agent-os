/**
 * Scheduler task: eval_observation — runs daily observation survival eval.
 */

import type { TaskResult } from '../scheduler.js'
import type { TaskDeps } from '../scheduler.js'
import { runObservationEval } from '../../observability/eval/observation-eval.js'
import { MetricsWriter } from '../../observability/metrics-writer.js'

export async function executeEvalObservation(_params: Record<string, unknown>, _deps: TaskDeps): Promise<TaskResult> {
  const writer = new MetricsWriter()
  writer.init()

  const result = runObservationEval(writer)

  if (!result) {
    return { success: true, message: 'No observations to evaluate' }
  }

  const scores = result.scores as { survivalRate: number; totalDiscovered: number; currentActive: number }
  return {
    success: true,
    message: `Observation eval: ${scores.totalDiscovered} discovered, survival rate ${(scores.survivalRate * 100).toFixed(1)}%, ${scores.currentActive} active`,
  }
}
