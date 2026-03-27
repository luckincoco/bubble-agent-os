import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { Reflector } from '../../memory/reflector.js'
import { logger } from '../../shared/logger.js'

export async function executeReflection(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const reflector = new Reflector(deps.llm)
  const db = getDatabase()

  // Get all distinct space IDs
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL',
  ).all() as Array<{ space_id: string }>

  let totalDiscovered = 0
  let totalValidated = 0
  let totalStaled = 0

  // Process each space independently
  for (const row of spaceRows) {
    try {
      const result = await reflector.run(row.space_id)
      totalDiscovered += result.discovered
      totalValidated += result.validated
      totalStaled += result.staled
    } catch (err) {
      logger.error(`Reflection failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  const message = `反思引擎: 发现 ${totalDiscovered} 个新观察, 验证 ${totalValidated} 个, 标记过期 ${totalStaled} 个`
  logger.info(`Reflection: ${message}`)

  return { success: true, message }
}
