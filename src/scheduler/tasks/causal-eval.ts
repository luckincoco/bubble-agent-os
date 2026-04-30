import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { CausalEvaluator } from '../../memory/causal-evaluator.js'
import { logger } from '../../shared/logger.js'

export async function executeCausalEval(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const memoryLlm = deps.llmRouter?.forCategory('memory') ?? deps.llm
  const evaluator = new CausalEvaluator(memoryLlm)
  const db = getDatabase()

  // Get all distinct space IDs
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL',
  ).all() as Array<{ space_id: string }>

  let totalEvaluated = 0
  let totalContradicts = 0
  let totalExtends = 0

  for (const row of spaceRows) {
    try {
      const result = await evaluator.evaluate(row.space_id)
      totalEvaluated += result.evaluated
      totalContradicts += result.contradicts
      totalExtends += result.extends
    } catch (err) {
      logger.error(`CausalEval failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  const message = `因果评估: 评估 ${totalEvaluated} 条, 矛盾 ${totalContradicts} 条, 延伸 ${totalExtends} 条`
  logger.info(`CausalEval: ${message}`)

  return { success: true, message }
}
