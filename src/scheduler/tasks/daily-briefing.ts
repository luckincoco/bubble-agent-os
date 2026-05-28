/**
 * Daily Briefing — zero-config morning briefing for the admin user.
 *
 * Aggregates public information (weather, steel prices) into a concise
 * daily briefing pushed via Feishu every morning at 7:30.
 *
 * This is the "地基层" of the information supply — public data sources
 * that require zero configuration from the user.
 */

import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import { recordDelivery } from '../../memory/feedback-store.js'

const WEATHER_URL = 'https://wttr.in/Shanghai?format=j1'

interface WeatherData {
  temp: string
  feelsLike: string
  humidity: string
  description: string
  windDir: string
  windSpeed: string
}

/** Fetch current weather for Shanghai from wttr.in (free, no key) */
async function fetchWeather(): Promise<WeatherData | null> {
  try {
    const res = await fetch(WEATHER_URL, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return null
    const data = await res.json() as any
    const current = data.current_condition?.[0]
    if (!current) return null
    return {
      temp: current.temp_C ?? '?',
      feelsLike: current.FeelsLikeC ?? '?',
      humidity: current.humidity ?? '?',
      description: current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || '',
      windDir: current.winddir16Point ?? '',
      windSpeed: current.windspeedKmph ?? '',
    }
  } catch {
    return null
  }
}

/** Fetch the latest steel price bubble content from the database */
function fetchLatestSteelPrice(): { content: string; date: string } | null {
  try {
    const db = getDatabase()
    const row = db.prepare(
      "SELECT content, metadata FROM bubbles WHERE type = 'event' AND tags LIKE '%steel-price%' ORDER BY created_at DESC LIMIT 1"
    ).get() as { content: string; metadata: string } | undefined
    if (!row) return null
    const meta = JSON.parse(row.metadata)
    return { content: row.content.slice(0, 1500), date: meta.date || '' }
  } catch {
    return null
  }
}

/** Get today's day of week in Chinese */
function dayOfWeek(): string {
  const days = ['日', '一', '二', '三', '四', '五', '六']
  return days[new Date().getDay()]
}

export async function executeDailyBriefing(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  try {
    const today = new Date()
    const dateStr = `${today.getMonth() + 1}月${today.getDate()}日`
    const weekday = dayOfWeek()

    // Fetch data sources in parallel
    const [weather, steelPrice] = await Promise.all([
      fetchWeather(),
      Promise.resolve(fetchLatestSteelPrice()),
    ])

    // If both sources failed, skip sending
    if (!weather && !steelPrice) {
      logger.warn('Daily briefing: all data sources failed, skipping')
      return { success: false, message: '所有数据源获取失败，跳过简报' }
    }

    // Build briefing content
    let briefing = `☀️ 早安简报 · ${dateStr} 周${weekday}\n`

    if (weather) {
      briefing += `\n🌤 上海 ${weather.temp}°C ${weather.description}`
      briefing += `，体感 ${weather.feelsLike}°C`
      if (weather.windDir) briefing += `，${weather.windDir} ${weather.windSpeed}级`
    }

    if (steelPrice) {
      briefing += `\n\n📊 钢价行情（${steelPrice.date || '昨日'}）\n`

      // Use LLM to extract key steel price info if available
      if (deps.llm) {
        try {
          const llmResponse = await deps.llm.chat([
            {
              role: 'system',
              content: '你是一个简报助手。下面是钢材价格行情原文。提取 2-4 个关键品种的价格摘要，每行一个品种，格式如"HRB400E 螺纹钢 ¥3,420/吨（+20）"。只返回价格行，不要多余文字。如果原文中没有明确价格数字，返回空字符串。',
            },
            { role: 'user', content: steelPrice.content },
          ])
          const extracted = llmResponse.content.trim()
          if (extracted) {
            briefing += extracted
          } else {
            // LLM returned empty — use raw first few lines
            briefing += steelPrice.content.split('\n').slice(0, 5).filter(l => l.trim()).join('\n')
          }
        } catch {
          briefing += steelPrice.content.split('\n').slice(0, 5).filter(l => l.trim()).join('\n')
        }
      } else {
        briefing += steelPrice.content.split('\n').slice(0, 5).filter(l => l.trim()).join('\n')
      }
    }

    briefing += `\n\n信息源：西本新干线 · wttr.in`

    // Get admin userId for feedback tracking
    let adminUserId = ''
    try {
      const db = getDatabase()
      const adminUser = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string } | undefined
      if (adminUser) adminUserId = adminUser.id
    } catch { /* non-critical */ }

    // Push to Feishu
    if (deps.feishu) {
      const chatId = deps.feishu.getAdminChatId() || String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
      if (chatId) {
        await deps.feishu.pushMessage(chatId, briefing)

        // Phase 1: record delivery for feedback loop
        if (adminUserId) {
          recordDelivery(adminUserId, 'daily_briefing', { date: dateStr, hasWeather: !!weather, hasSteelPrice: !!steelPrice })
        }
      }
    }

    logger.info('Daily briefing sent successfully')
    return { success: true, message: `早安简报已发送 (${dateStr})` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('Daily briefing error:', msg)
    return { success: false, message: `简报生成出错: ${msg}` }
  }
}
