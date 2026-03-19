import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

export async function executeMemoryDecay(_params: Record<string, unknown>, _deps: TaskDeps): Promise<TaskResult> {
  const db = getDatabase()
  const now = Date.now()

  // Tier 3: archive (> 90 days, confidence < 0.3, not pinned) → delete
  const tier3Threshold = now - 90 * 24 * 60 * 60 * 1000
  const deleted = db.prepare(
    'DELETE FROM bubbles WHERE accessed_at < ? AND confidence < 0.3 AND pinned = 0',
  ).run(tier3Threshold)

  // Tier 2: long-term (30-90 days, not pinned) → reduce confidence by 10%
  const tier2Threshold = now - 30 * 24 * 60 * 60 * 1000
  const decayed = db.prepare(
    'UPDATE bubbles SET confidence = confidence * 0.9, updated_at = ? WHERE accessed_at < ? AND accessed_at >= ? AND pinned = 0',
  ).run(now, tier2Threshold, tier3Threshold)

  // Clean up orphaned links
  db.prepare(
    'DELETE FROM bubble_links WHERE source_id NOT IN (SELECT id FROM bubbles) OR target_id NOT IN (SELECT id FROM bubbles)',
  ).run()

  const message = `清理: 删除 ${deleted.changes} 条过期记忆, 衰减 ${decayed.changes} 条长期记忆`
  logger.info(`Memory decay: ${message}`)

  return { success: true, message }
}
