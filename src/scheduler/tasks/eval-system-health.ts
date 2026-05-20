/**
 * Scheduler task: eval_system_health — runs daily system health eval.
 */

import type { TaskResult } from '../scheduler.js'
import type { TaskDeps } from '../scheduler.js'
import { runSystemHealthEval } from '../../observability/eval/system-health.js'
import { MetricsWriter } from '../../observability/metrics-writer.js'

export async function executeEvalSystemHealth(_params: Record<string, unknown>, _deps: TaskDeps): Promise<TaskResult> {
  const writer = new MetricsWriter()
  writer.init()

  const result = runSystemHealthEval(writer)

  if (!result) {
    return { success: true, message: 'No data for system health eval' }
  }

  const scores = result.scores as { llmLatencyP50: number; llmLatencyP95: number; taskSuccessRate: number }
  return {
    success: true,
    message: `System health: p50=${scores.llmLatencyP50}ms p95=${scores.llmLatencyP95}ms, task success=${(scores.taskSuccessRate * 100).toFixed(0)}%`,
  }
}
