import type { TaskDeps, TaskResult } from '../scheduler.js'
import { logger } from '../../shared/logger.js'

/**
 * Concept Forge — daily cross-domain structural isomorphism detection.
 * Runs after orientation_snapshot (6:15 AM) to leverage fresh cognitive landscape.
 *
 * Budget: ≤3 LLM calls/day (~1.5k tokens total)
 */
export async function executeConceptForge(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  if (!deps.conceptForge) {
    return { success: true, message: '概念锻造: ConceptForge 未启用' }
  }

  try {
    const concepts = await deps.conceptForge.forge()

    if (concepts.length === 0) {
      return { success: true, message: '概念锻造: 今日无新概念发现' }
    }

    const names = concepts.map(c => c.name).join(', ')
    const autoCount = concepts.filter(c => c.confidence > 0.85).length
    const pendingCount = concepts.length - autoCount

    const message = `概念锻造: 发现 ${concepts.length} 个概念 [${names}], 自动创建 ${autoCount}, 待审批 ${pendingCount}`
    logger.info(`ConceptForge task: ${message}`)

    return {
      success: true,
      message,
      bubbleIds: concepts.filter(c => c.bubbleId).map(c => c.bubbleId!),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`ConceptForge task failed: ${msg}`)
    return { success: false, message: `概念锻造失败: ${msg}` }
  }
}
