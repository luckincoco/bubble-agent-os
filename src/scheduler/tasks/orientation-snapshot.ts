import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

/**
 * Orientation Snapshot — daily rebuild of the cognitive landscape.
 * One LLM call per space (~2K tokens) to classify domains and identify tensions.
 * Feeds into interest-search for intelligent search guidance.
 */
export async function executeOrientationSnapshot(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  if (!deps.orientationGraph) {
    return { success: true, message: '认知快照: OrientationGraph 未启用' }
  }

  const db = getDatabase()
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL AND deleted_at IS NULL',
  ).all() as Array<{ space_id: string }>

  let totalNodes = 0
  let totalFrontiers = 0
  let totalTensions = 0

  for (const row of spaceRows) {
    try {
      const snapshot = await deps.orientationGraph.buildSnapshot(row.space_id)
      totalNodes += snapshot.nodes.length
      totalFrontiers += snapshot.frontiers.length
      totalTensions += snapshot.tensions.length
    } catch (err) {
      logger.error(`OrientationSnapshot failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Also build for default/no-space bubbles
  try {
    const snapshot = await deps.orientationGraph.buildSnapshot('default')
    totalNodes += snapshot.nodes.length
    totalFrontiers += snapshot.frontiers.length
    totalTensions += snapshot.tensions.length
  } catch (err) {
    logger.debug(`OrientationSnapshot default space: ${err instanceof Error ? err.message : String(err)}`)
  }

  const message = `认知快照: ${totalNodes} 节点, ${totalFrontiers} 前沿, ${totalTensions} 张力`
  logger.info(`OrientationSnapshot: ${message}`)

  return { success: true, message }
}
