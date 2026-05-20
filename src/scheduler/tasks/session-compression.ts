import type { TaskDeps, TaskResult } from '../scheduler.js'
import { SessionCompressor } from '../../memory/session-compressor.js'
import { logger } from '../../shared/logger.js'

/**
 * Session Compression Task
 *
 * Periodically checks for idle conversation sessions (30+ min silence)
 * and compresses them into structured summary bubbles.
 *
 * Schedule: every 10 minutes
 */

const DEFAULT_IDLE_MS = 30 * 60 * 1000 // 30 minutes

export async function executeSessionCompression(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const idleMs = Number(params.idleMs) || DEFAULT_IDLE_MS
  const memoryLlm = deps.llmRouter?.forCategory('memory') ?? deps.llm

  // Get sessions that have been idle
  const staleSessions = deps.brain.drainStaleSessions(idleMs)

  if (staleSessions.length === 0) {
    return { success: true, message: '无空闲 session 需要压缩' }
  }

  const compressor = new SessionCompressor(memoryLlm)
  const bubbleIds: string[] = []
  const errors: string[] = []

  for (const session of staleSessions) {
    try {
      const result = await compressor.compress(session.userId, session.history)
      if (result) {
        bubbleIds.push(result.bubbleId)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${session.userId}: ${msg}`)
      logger.debug(`Session compression error for ${session.userId}:`, msg)
    }
  }

  const message = `Session 压缩: ${staleSessions.length} 个空闲会话, 生成 ${bubbleIds.length} 个摘要泡泡${errors.length ? `, ${errors.length} 个失败` : ''}`
  logger.info(message)

  return {
    success: errors.length === 0,
    message,
    bubbleIds,
  }
}
