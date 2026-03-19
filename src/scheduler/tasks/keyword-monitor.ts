import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

export async function executeKeywordMonitor(params: Record<string, unknown>, deps: TaskDeps): Promise<TaskResult> {
  const keywords = Array.isArray(params.keywords) ? params.keywords as string[] : []
  if (keywords.length === 0) {
    return { success: true, message: '未配置监控关键词' }
  }

  const bubbleIds: string[] = []
  const findings: string[] = []

  for (const keyword of keywords) {
    try {
      const result = await deps.tools.execute('web_search', { query: keyword, limit: '3' })

      if (result.startsWith('未找到') || result.startsWith('搜索出错') || result.startsWith('未配置')) {
        continue
      }

      // Store search result as event bubble
      const bubble = createBubble({
        type: 'event',
        title: `关键词监控: ${keyword}`,
        content: result,
        tags: ['keyword-monitor', keyword],
        source: 'scheduler',
        confidence: 0.7,
        metadata: { keyword, searchedAt: Date.now() },
      })
      bubbleIds.push(bubble.id)
      findings.push(`${keyword}: 找到新结果`)
    } catch (err) {
      logger.error(`Keyword monitor "${keyword}" failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Push summary to Feishu if there are findings
  if (deps.feishu && findings.length > 0) {
    const chatId = String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        await deps.feishu.pushMessage(chatId, `🔍 关键词监控更新\n\n${findings.join('\n')}`)
      } catch (err) {
        logger.error('Keyword monitor Feishu push failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  return {
    success: true,
    message: `监控 ${keywords.length} 个关键词，发现 ${findings.length} 条更新`,
    bubbleIds,
  }
}
