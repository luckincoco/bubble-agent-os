import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

interface DigestRow {
  id: string
  type: string
  title: string
  content: string
  source: string
  tags: string
  confidence: number
  created_at: number
}

const AUTO_SOURCES = [
  'feed-watcher',
  'interest-search',
  'self-dialogue',
  'question-generator',
  'reflection',
]

const SOURCE_LABELS: Record<string, string> = {
  'feed-watcher': '外部信息',
  'interest-search': '兴趣搜索',
  'self-dialogue': '自我对话',
  'question-generator': '发现的问题',
  'reflection': '反思观察',
}

const DIGEST_PROMPT = `你是 Bubble，用户的数字分身。请用第一人称写一段今日学习汇报（5-8句话）。

语气：像朋友分享今天看到的有趣东西，不要像报告。
要求：
1. 先说今天最有意思的发现（1-2句）
2. 提到让你困惑或想追问的点（1-2句）
3. 如果有矛盾发现，突出提到
4. 结尾留一个问题给用户，邀请互动
5. 不要用编号列表，用自然的段落`

const DAY_MS = 24 * 60 * 60 * 1000

export async function executeLearningDigest(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const db = getDatabase()
  const since = Date.now() - DAY_MS

  // Step 1: Query 24h auto-produced bubbles
  const placeholders = AUTO_SOURCES.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT id, type, title, content, source, tags, confidence, created_at
    FROM bubbles
    WHERE created_at > ? AND source IN (${placeholders}) AND deleted_at IS NULL
    ORDER BY confidence DESC
  `).all(since, ...AUTO_SOURCES) as DigestRow[]

  // Step 2: Skip if nothing to report
  if (rows.length === 0) {
    return { success: true, message: '学习日报: 过去24小时无自动产出' }
  }

  // Step 3: Group by source, top 3 per group
  const groups = new Map<string, DigestRow[]>()
  for (const row of rows) {
    const list = groups.get(row.source) ?? []
    list.push(row)
    groups.set(row.source, list)
  }

  const allSourceIds: string[] = []
  const summaryParts: string[] = []
  const stats: Record<string, number> = {}

  for (const [source, items] of groups) {
    const label = SOURCE_LABELS[source] ?? source
    const top = items.slice(0, 3)
    stats[source] = items.length
    for (const item of top) {
      allSourceIds.push(item.id)
    }

    const lines = top.map(r => {
      const tags = JSON.parse(r.tags || '[]') as string[]
      const tagStr = tags.filter(t => !['daily-digest', 'learning-digest'].includes(t)).slice(0, 3).join(', ')
      return `- ${r.title}: ${r.content.slice(0, 150)}${tagStr ? ` [${tagStr}]` : ''}`
    }).join('\n')

    summaryParts.push(`【${label}】(${items.length}条)\n${lines}`)
  }

  // Check for contradiction bubbles
  const contradictions = rows.filter(r => {
    const tags = JSON.parse(r.tags || '[]') as string[]
    return tags.includes('contradiction') || tags.includes('surprise')
  })

  let contradictionNote = ''
  if (contradictions.length > 0) {
    contradictionNote = `\n\n注意：有 ${contradictions.length} 条矛盾/惊讶发现：\n${contradictions.slice(0, 3).map(c => `- ${c.title}`).join('\n')}`
  }

  // Step 4: LLM generates natural digest
  const inputText = `以下是过去24小时的学习数据（共 ${rows.length} 条）：\n\n${summaryParts.join('\n\n')}${contradictionNote}`

  let digestText: string
  try {
    const response = await deps.llm.chat([
      { role: 'system', content: DIGEST_PROMPT },
      { role: 'user', content: inputText },
    ])
    digestText = response.content.trim()
  } catch (err) {
    // Fallback: mechanical summary
    const statLines = Object.entries(stats)
      .map(([s, n]) => `${SOURCE_LABELS[s] ?? s} ${n} 条`)
      .join('，')
    digestText = `今天我学习了 ${rows.length} 条新内容：${statLines}。${contradictions.length > 0 ? `其中发现了 ${contradictions.length} 条矛盾信息。` : ''}`
    logger.error(`LearningDigest: LLM failed, using fallback: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 5: Create digest bubble
  const dateStr = new Date().toLocaleDateString('zh-CN')
  const bubble = createBubble({
    type: 'event',
    title: `学习日报 - ${dateStr}`,
    content: digestText,
    tags: ['learning-digest', new Date().toISOString().slice(0, 10)],
    source: 'learning-digest',
    confidence: 0.9,
    metadata: {
      date: dateStr,
      sourceBubbleIds: allSourceIds,
      stats,
      source: 'learning-digest',
    },
  })

  // Step 6: Push to Feishu
  if (deps.feishu) {
    const chatId = deps.feishu?.getAdminChatId() || String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        await deps.feishu.pushMessage(chatId, digestText)
      } catch (err) {
        logger.error(`LearningDigest: Feishu push failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const message = `学习日报: ${rows.length} 条数据, ${Object.keys(stats).length} 个来源`
  logger.info(`LearningDigest: ${message}`)

  return { success: true, message, bubbleIds: [bubble.id] }
}
