import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

export async function executeDailyDigest(params: Record<string, unknown>, deps: TaskDeps): Promise<TaskResult> {
  const db = getDatabase()

  // Query bubbles created in the last 24 hours
  const since = Date.now() - 24 * 60 * 60 * 1000
  const rows = db.prepare(
    'SELECT type, title, content, confidence FROM bubbles WHERE created_at > ? ORDER BY confidence DESC',
  ).all(since) as Array<{ type: string; title: string; content: string; confidence: number }>

  if (rows.length === 0) {
    return { success: true, message: '过去24小时没有新数据' }
  }

  // Group by type
  const byType: Record<string, number> = {}
  for (const r of rows) {
    byType[r.type] = (byType[r.type] || 0) + 1
  }

  const typeSummary = Object.entries(byType)
    .map(([t, c]) => `${t}: ${c}条`)
    .join(', ')

  // Top 10 by confidence
  const top10 = rows.slice(0, 10)
  const topItems = top10.map((r, i) =>
    `${i + 1}. [${r.type}] ${r.title}: ${r.content.slice(0, 100)}`,
  ).join('\n')

  // Build digest prompt and use LLM to summarize
  const prompt = `请用简洁的中文生成一段每日数据摘要（3-5句话）。

过去24小时新增 ${rows.length} 条数据：${typeSummary}

重要数据:
${topItems}

请总结要点，突出关键数据变化和值得关注的信息。`

  let summary: string
  try {
    const result = await deps.llm.chat([
      { role: 'system', content: '你是数据摘要助手，用简洁的中文总结每日数据。' },
      { role: 'user', content: prompt },
    ])
    summary = result.content
  } catch {
    summary = `过去24小时新增 ${rows.length} 条数据（${typeSummary}）。`
  }

  // Create digest bubble
  const bubble = createBubble({
    type: 'event',
    title: `每日摘要 - ${new Date().toLocaleDateString('zh-CN')}`,
    content: summary,
    tags: ['daily-digest', new Date().toISOString().slice(0, 10)],
    source: 'scheduler',
    confidence: 0.9,
  })

  // Push to Feishu if available
  if (deps.feishu) {
    const chatId = deps.feishu?.getAdminChatId() || String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        await deps.feishu.pushMessage(chatId, `📊 每日数据摘要\n\n${summary}`)
      } catch (err) {
        logger.error('Daily digest Feishu push failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  return { success: true, message: `生成摘要，包含 ${rows.length} 条数据`, bubbleIds: [bubble.id] }
}
