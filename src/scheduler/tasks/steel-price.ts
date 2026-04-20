import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

const STEEL_PRICE_URL = 'https://shanghai.steelx2.com/city/Quotation/quotation/1/index.html'

/** Fetch steel prices from steelx2.com and store as bubble */
export async function executeSteelPrice(_params: Record<string, unknown>, deps: TaskDeps): Promise<TaskResult> {
  try {
    const res = await fetch(STEEL_PRICE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BubbleAgent/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      return { success: false, message: `抓取失败 (${res.status})` }
    }

    const html = await res.text()

    // Extract text content from HTML
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '\n')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n/g, '\n')
      .trim()

    if (!text) {
      return { success: false, message: '页面内容为空' }
    }

    const today = new Date().toISOString().slice(0, 10)

    const bubble = createBubble({
      type: 'event',
      title: `上海钢材价格行情 ${today}`,
      content: text.slice(0, 5000),
      tags: ['steel-price', 'steelx2', 'shanghai', today],
      source: 'scheduler',
      confidence: 0.95,
      metadata: { url: STEEL_PRICE_URL, fetchedAt: Date.now(), date: today },
    })

    // Push to Feishu if configured
    if (deps.feishu) {
      const chatId = deps.feishu?.getAdminChatId() || String(_params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
      if (chatId) {
        try {
          await deps.feishu.pushMessage(chatId, `📊 今日上海钢材价格已更新 (${today})\n来源: 西本新干线\n数据已存入记忆系统，随时可查询。`)
        } catch (err) {
          logger.error('Steel price Feishu push failed:', err instanceof Error ? err.message : String(err))
        }
      }
    }

    return {
      success: true,
      message: `上海钢材价格 ${today} 已抓取并存储`,
      bubbleIds: [bubble.id],
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Steel price fetch error:', msg)
    return { success: false, message: `抓取出错: ${msg}` }
  }
}
