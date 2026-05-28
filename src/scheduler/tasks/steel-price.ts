import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble } from '../../bubble/model.js'
import { getDatabase } from '../../storage/database.js'
import { getInventory } from '../../connector/biz/structured-store.js'
import { logger } from '../../shared/logger.js'
import { recordDelivery } from '../../memory/feedback-store.js'

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

    // Get admin userId for feedback tracking
    let adminUserId = ''
    try {
      const db = getDatabase()
      const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string } | undefined
      if (adminUser) adminUserId = adminUser.id
    } catch { /* non-critical */ }

    const bubble = createBubble({
      type: 'event',
      title: `上海钢材价格行情 ${today}`,
      content: text.slice(0, 5000),
      tags: ['steel-price', 'steelx2', 'shanghai', today],
      source: 'scheduler',
      confidence: 0.95,
      metadata: { url: STEEL_PRICE_URL, fetchedAt: Date.now(), date: today },
    })

    // ── P0: Match inventory against price text ──
    let matchedProducts: Array<{
      productCode: string
      brand: string
      name: string
      spec: string
      price: number
      priceChange: string
      stockTons: number
    }> = []
    try {
      const db = getDatabase()
      const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string } | undefined
      if (adminUser) {
        const userSpace = db.prepare('SELECT space_id FROM user_spaces WHERE user_id = ? LIMIT 1').get(adminUser.id) as { space_id: string } | undefined
        if (userSpace?.space_id) {
          const inventory = getInventory({ spaceId: userSpace.space_id })
          if (inventory.length > 0) {
            const sysPrompt = `你是一个钢材价格匹配助手。你的任务是把用户库存品种与今日钢材价格行情进行匹配。

用户库存包含以下字段：code（产品编码，如 HRB400E-25）、brand（品牌，如 沙钢）、name（产品名，如 螺纹钢）、spec（规格，如 Φ25）、stockTons（库存吨数）。

价格行情文本中包含各品种的当日价格。

请找出库存中哪些品种出现在了今日价格行情中。返回 JSON 数组，格式：
[{"productCode":"HRB400E-25","brand":"沙钢","name":"螺纹钢","spec":"Φ25","price":3420,"priceChange":"+20","stockTons":50}]

规则：
- 只返回在价格行情中明确出现的品种
- price 是今日价格（数字，不含 ¥）
- priceChange 是涨跌幅度（如 "+20"、"-15"、""）
- 如果一个品种在库存中但不在价格行情中，不要包含它
- 如果没有任何匹配，返回空数组 []`

            const userContent = `今日价格行情（${today}）：\n${text.slice(0, 3000)}\n\n用户库存：\n${JSON.stringify(inventory.map(i => ({ code: i.code, brand: i.brand, name: i.name, spec: i.spec, stockTons: i.stockTons })))}`

            const llmResponse = await deps.llm.chat([
              { role: 'system', content: sysPrompt },
              { role: 'user', content: userContent },
            ])

            const raw = llmResponse.content.trim()
            // Extract JSON from possible markdown code fences
            const jsonStr = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
            const parsed = JSON.parse(jsonStr)
            if (Array.isArray(parsed) && parsed.length > 0) {
              matchedProducts = parsed
            }
          }
        }
      }
    } catch (err) {
      logger.warn('Steel price inventory matching skipped:', err instanceof Error ? err.message : String(err))
    }

    // Push to Feishu if configured
    if (deps.feishu) {
      const chatId = deps.feishu?.getAdminChatId() || String(_params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
      if (chatId) {
        try {
          let message: string
          if (matchedProducts.length > 0) {
            const lines = matchedProducts.map(m =>
              `${m.brand} ${m.name}（${m.spec}）¥${m.price}/吨 — 你库存 ${m.stockTons} 吨${m.priceChange ? `（${m.priceChange}）` : ''}`
            )
            message = `📊 钢价更新：与你库存相关的品种\n\n${lines.join('\n')}\n\n来源：西本新干线 (${today})\n数据已存入记忆系统`
          } else {
            message = `📊 今日上海钢材价格已更新 (${today})\n来源: 西本新干线\n数据已存入记忆系统，随时可查询。`
          }
          await deps.feishu.pushMessage(chatId, message)

          // Phase 1: record delivery for feedback loop
          if (adminUserId) {
            recordDelivery(adminUserId, 'steel_price', {
              date: today,
              matchedProducts: matchedProducts.length,
            })
          }
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
