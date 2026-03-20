import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { BubbleCompactor, type CompactionResult } from '../../memory/compactor.js'
import { logger } from '../../shared/logger.js'

export async function executeBubbleCompaction(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const compactor = new BubbleCompactor(deps.llm)
  const db = getDatabase()

  // Get all distinct space IDs
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL',
  ).all() as Array<{ space_id: string }>

  const totals: CompactionResult = { synthesized: 0, portrayed: 0, clustersFound: 0, skipped: 0 }

  // Process each space independently
  for (const row of spaceRows) {
    try {
      const result = await compactor.compact(row.space_id)
      totals.synthesized += result.synthesized
      totals.portrayed += result.portrayed
      totals.clustersFound += result.clustersFound
      totals.skipped += result.skipped
    } catch (err) {
      logger.error(`Compaction failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Process bubbles without a space
  try {
    const result = await compactor.compact(undefined)
    totals.synthesized += result.synthesized
    totals.portrayed += result.portrayed
    totals.clustersFound += result.clustersFound
    totals.skipped += result.skipped
  } catch (err) {
    logger.error('Compaction failed for unscoped bubbles:', err instanceof Error ? err.message : String(err))
  }

  const message = `泡泡压缩: 发现 ${totals.clustersFound} 个聚类, 生成 ${totals.synthesized} 个概念泡泡, ${totals.portrayed} 个画像泡泡, 跳过 ${totals.skipped} 个`
  logger.info(`Bubble compaction: ${message}`)

  return { success: true, message }
}
