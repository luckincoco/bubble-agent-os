import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { BubbleCompactor, type CompactionResult } from '../../memory/compactor.js'
import { Reflector } from '../../memory/reflector.js'
import { updateBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

export async function executeBubbleCompaction(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const memoryLlm = deps.llmRouter?.forCategory('memory') ?? deps.llm
  const compactor = new BubbleCompactor(memoryLlm)
  const reflector = new Reflector(memoryLlm)
  const db = getDatabase()

  // Get all distinct space IDs
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL',
  ).all() as Array<{ space_id: string }>

  const totals: CompactionResult = { synthesized: 0, portrayed: 0, clustersFound: 0, skipped: 0, newBubbleIds: [] }

  // Process each space independently
  for (const row of spaceRows) {
    try {
      // Phase 1: Get quality signals from Reflector (no LLM cost)
      const qualitySignals = reflector.getQualitySignals(row.space_id)

      // Phase 2: Run compaction with quality signals
      const result = await compactor.compact(row.space_id, qualitySignals)
      totals.synthesized += result.synthesized
      totals.portrayed += result.portrayed
      totals.clustersFound += result.clustersFound
      totals.skipped += result.skipped
      totals.newBubbleIds.push(...result.newBubbleIds)

      // Phase 3: Validate newly created syntheses (no LLM cost)
      for (const newId of result.newBubbleIds) {
        try {
          const assessment = reflector.validateSynthesis(newId, row.space_id)
          // Store quality assessment in the synthesis bubble's metadata
          updateBubble(newId, {
            metadata: { qualityAssessment: assessment } as unknown as Record<string, unknown>,
          })
        } catch (err) {
          logger.debug(`Quality assessment failed for ${newId}:`, err instanceof Error ? err.message : String(err))
        }
      }
    } catch (err) {
      logger.error(`Compaction failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Process bubbles without a space
  try {
    const qualitySignals = reflector.getQualitySignals(undefined)
    const result = await compactor.compact(undefined, qualitySignals)
    totals.synthesized += result.synthesized
    totals.portrayed += result.portrayed
    totals.clustersFound += result.clustersFound
    totals.skipped += result.skipped

    for (const newId of result.newBubbleIds) {
      try {
        const assessment = reflector.validateSynthesis(newId, undefined)
        updateBubble(newId, {
          metadata: { qualityAssessment: assessment } as unknown as Record<string, unknown>,
        })
      } catch (err) {
        logger.debug(`Quality assessment failed for ${newId}:`, err instanceof Error ? err.message : String(err))
      }
    }
  } catch (err) {
    logger.error('Compaction failed for unscoped bubbles:', err instanceof Error ? err.message : String(err))
  }

  const message = `泡泡蒸馏: 发现 ${totals.clustersFound} 个聚类, 生成 ${totals.synthesized} 个概念泡泡, ${totals.portrayed} 个画像泡泡, 跳过 ${totals.skipped} 个, 质量评估 ${totals.newBubbleIds.length} 个`
  logger.info(`Bubble compaction: ${message}`)

  return { success: true, message }
}
