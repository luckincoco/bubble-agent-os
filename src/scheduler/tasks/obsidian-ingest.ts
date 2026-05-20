import type { TaskDeps, TaskResult } from '../scheduler.js'
import { logger } from '../../shared/logger.js'

/**
 * Obsidian Ingest — periodic ingestion of whitelisted Obsidian notes.
 * Runs daily at 5:30 AM (before compaction/reflection cycle).
 *
 * Zero LLM cost — pure file scan + DB writes.
 */
export async function executeObsidianIngest(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  if (!(deps as any).obsidianIngest) {
    return { success: true, message: 'Obsidian摄入: 未启用' }
  }

  try {
    const ingest = (deps as any).obsidianIngest as import('../../cognition/obsidian-ingest.js').ObsidianIngest
    const result = await ingest.ingest()

    const message = `Obsidian摄入: 新增 ${result.created}, 更新 ${result.updated}, 过期 ${result.staled}, 跳过 ${result.skipped}, 拒绝 ${result.denied}`
    logger.info(`ObsidianIngest task: ${message}`)

    return { success: true, message }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`ObsidianIngest task failed: ${msg}`)
    return { success: false, message: `Obsidian摄入失败: ${msg}` }
  }
}
