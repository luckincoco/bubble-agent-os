import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { logger } from '../../shared/logger.js'

/**
 * Question Generator — the "problem definition" scaffold.
 *
 * Runs on a schedule, scans existing bubbles, and produces 'question' type
 * bubbles when it detects:
 *   A. Data anomalies  — numeric trends that deviate from recent history
 *   B. Silent links    — entities (customers, suppliers) that went quiet
 *   C. Information gaps — expected data that is missing
 *
 * Borrows from vanna-ai/proactive-agent's Creative Agent pattern:
 * the system asks questions before the human does.
 */

// ── helpers ──────────────────────────────────────────────────────────

interface RecentBubbleRow {
  id: string
  type: string
  title: string
  content: string
  tags: string
  metadata: string
  created_at: number
  space_id: string | null
}

interface EntityActivity {
  entity: string
  lastSeen: number
  count: number
  spaceId: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

// ── main executor ────────────────────────────────────────────────────

export async function executeQuestionGenerator(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const db = getDatabase()
  const now = Date.now()
  const lookbackDays = Number(params.lookbackDays) || 7
  const silenceDays = Number(params.silenceDays) || 14
  const since = now - lookbackDays * DAY_MS

  const questions: Array<{ title: string; content: string; tags: string[]; relatedIds: string[]; spaceId?: string }> = []

  // ── A. Data anomaly scan ───────────────────────────────────────────
  // Compare recent steel-price / event bubbles for numeric drift
  try {
    const priceRows = db.prepare(`
      SELECT id, type, title, content, tags, metadata, created_at, space_id
      FROM bubbles
      WHERE tags LIKE '%steel-price%' AND created_at > ?
      ORDER BY created_at DESC
    `).all(since) as RecentBubbleRow[]

    if (priceRows.length >= 2) {
      const anomalies = detectNumericDrift(priceRows)
      for (const a of anomalies) {
        questions.push({
          title: a.title,
          content: a.content,
          tags: ['question', 'anomaly', 'steel-price'],
          relatedIds: a.relatedIds,
          spaceId: priceRows[0].space_id ?? undefined,
        })
      }
    }

    // Generic event anomaly: check any event bubbles with numeric content
    const eventRows = db.prepare(`
      SELECT id, type, title, content, tags, metadata, created_at, space_id
      FROM bubbles
      WHERE type = 'event' AND tags NOT LIKE '%steel-price%' AND created_at > ?
      ORDER BY created_at DESC LIMIT 100
    `).all(since) as RecentBubbleRow[]

    const eventAnomalies = detectEventAnomalies(eventRows)
    for (const a of eventAnomalies) {
      questions.push({
        title: a.title,
        content: a.content,
        tags: ['question', 'anomaly', 'event'],
        relatedIds: a.relatedIds,
        spaceId: a.spaceId,
      })
    }
  } catch (err) {
    logger.error('QuestionGenerator: anomaly scan failed:', err instanceof Error ? err.message : String(err))
  }

  // ── B. Silent link detection ───────────────────────────────────────
  // Find entities (customers, suppliers) that haven't appeared recently
  try {
    const ENTITY_PATTERNS = /供应商|客户|公司|厂家|联系人/
    const entityBubbles = db.prepare(`
      SELECT id, type, title, content, tags, metadata, created_at, space_id
      FROM bubbles
      WHERE type IN ('memory', 'entity')
      ORDER BY created_at DESC LIMIT 500
    `).all() as RecentBubbleRow[]

    const entityMap = new Map<string, EntityActivity>()

    for (const b of entityBubbles) {
      const tags = JSON.parse(b.tags || '[]') as string[]
      const hasEntityTag = tags.some(t => ENTITY_PATTERNS.test(t))
      const contentHasEntity = ENTITY_PATTERNS.test(b.content) || ENTITY_PATTERNS.test(b.title)

      if (!hasEntityTag && !contentHasEntity) continue

      // Extract entity names from title (rough heuristic)
      const names = extractEntityNames(b.title, b.content)
      for (const name of names) {
        const existing = entityMap.get(name)
        if (!existing || b.created_at > existing.lastSeen) {
          entityMap.set(name, {
            entity: name,
            lastSeen: b.created_at,
            count: (existing?.count || 0) + 1,
            spaceId: b.space_id,
          })
        } else {
          existing.count++
        }
      }
    }

    const silenceThreshold = now - silenceDays * DAY_MS
    for (const [name, activity] of entityMap) {
      // Only flag entities that were active (count >= 3) but went silent
      if (activity.count >= 3 && activity.lastSeen < silenceThreshold) {
        const daysSilent = Math.floor((now - activity.lastSeen) / DAY_MS)
        questions.push({
          title: `${name} 已沉默 ${daysSilent} 天`,
          content: `${name} 在过去记录中出现了 ${activity.count} 次，但最近 ${daysSilent} 天没有新的相关记录。\n\n是否需要跟进？上次活动时间：${new Date(activity.lastSeen).toLocaleDateString('zh-CN')}`,
          tags: ['question', 'silent-link', name],
          relatedIds: [],
          spaceId: activity.spaceId ?? undefined,
        })
      }
    }
  } catch (err) {
    logger.error('QuestionGenerator: silent link scan failed:', err instanceof Error ? err.message : String(err))
  }

  // ── C. Information gap detection ───────────────────────────────────
  // Look for patterns that suggest missing data
  try {
    // Check: are there project/工程 bubbles without recent delivery/配送 records?
    const projectBubbles = db.prepare(`
      SELECT id, title, content, space_id FROM bubbles
      WHERE (tags LIKE '%工程%' OR tags LIKE '%项目%' OR title LIKE '%工程%' OR title LIKE '%项目%')
        AND created_at > ?
      ORDER BY created_at DESC LIMIT 50
    `).all(now - 30 * DAY_MS) as Array<{ id: string; title: string; content: string; space_id: string | null }>

    const deliveryBubbles = db.prepare(`
      SELECT id, title, content FROM bubbles
      WHERE (tags LIKE '%配送%' OR tags LIKE '%发货%' OR tags LIKE '%物流%'
             OR content LIKE '%配送%' OR content LIKE '%发货%')
        AND created_at > ?
    `).all(now - 30 * DAY_MS) as Array<{ id: string; title: string; content: string }>

    if (projectBubbles.length > 0 && deliveryBubbles.length === 0) {
      questions.push({
        title: `${projectBubbles.length} 个项目在推进，但无配送记录`,
        content: `近30天有 ${projectBubbles.length} 个项目相关记录，但没有找到任何配送/发货记录。\n\n相关项目：${projectBubbles.slice(0, 5).map(p => p.title).join('、')}\n\n是否有配送信息未录入？`,
        tags: ['question', 'info-gap', 'delivery'],
        relatedIds: projectBubbles.slice(0, 3).map(p => p.id),
        spaceId: projectBubbles[0].space_id ?? undefined,
      })
    }

    // Check: memory bubbles created this week vs last week (activity drop)
    const thisWeek = db.prepare(
      'SELECT COUNT(*) as cnt FROM bubbles WHERE created_at > ?',
    ).get(now - 7 * DAY_MS) as { cnt: number }

    const lastWeek = db.prepare(
      'SELECT COUNT(*) as cnt FROM bubbles WHERE created_at > ? AND created_at <= ?',
    ).get(now - 14 * DAY_MS, now - 7 * DAY_MS) as { cnt: number }

    if (lastWeek.cnt > 0 && thisWeek.cnt < lastWeek.cnt * 0.3) {
      questions.push({
        title: '本周数据量显著下降',
        content: `本周新增 ${thisWeek.cnt} 条记录，上周为 ${lastWeek.cnt} 条（下降 ${((1 - thisWeek.cnt / lastWeek.cnt) * 100).toFixed(0)}%）。\n\n是系统问题还是业务放缓？`,
        tags: ['question', 'info-gap', 'activity-drop'],
        relatedIds: [],
      })
    }
  } catch (err) {
    logger.error('QuestionGenerator: gap detection failed:', err instanceof Error ? err.message : String(err))
  }

  // ── Deduplicate against existing question bubbles ──────────────────
  const newQuestions = deduplicateQuestions(questions)

  if (newQuestions.length === 0) {
    return { success: true, message: '扫描完成，未发现新问题' }
  }

  // ── Create question bubbles and push ───────────────────────────────
  const bubbleIds: string[] = []

  for (const q of newQuestions) {
    const bubble = createBubble({
      type: 'question',
      title: q.title,
      content: q.content,
      tags: q.tags,
      source: 'question-generator',
      confidence: 0.8,
      decayRate: 0.15, // questions decay faster than memories
      spaceId: q.spaceId,
    })
    bubbleIds.push(bubble.id)

    // Link to related bubbles
    for (const relId of q.relatedIds) {
      addLink(bubble.id, relId, 'questions_about', 0.8, 'system')
    }
  }

  // Push summary to Feishu
  if (deps.feishu && newQuestions.length > 0) {
    const chatId = String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        const summary = newQuestions
          .map((q, i) => `${i + 1}. ${q.title}`)
          .join('\n')
        await deps.feishu.pushMessage(
          chatId,
          `系统发现了 ${newQuestions.length} 个值得关注的问题：\n\n${summary}\n\n在对话中问我可以了解详情。`,
        )
      } catch (err) {
        logger.error('QuestionGenerator Feishu push failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  logger.info(`QuestionGenerator: generated ${newQuestions.length} questions`)
  return {
    success: true,
    message: `生成 ${newQuestions.length} 个问题泡泡`,
    bubbleIds,
  }
}

// ── internal functions ───────────────────────────────────────────────

/** Detect numeric drift across ordered bubble rows (newest first) */
function detectNumericDrift(rows: RecentBubbleRow[]): Array<{ title: string; content: string; relatedIds: string[] }> {
  const results: Array<{ title: string; content: string; relatedIds: string[] }> = []

  // Extract all numbers from content for trend analysis
  const dataPoints: Array<{ id: string; date: string; numbers: number[] }> = []

  for (const row of rows) {
    const nums = (row.content.match(/\d{3,}/g) || []).map(Number).filter(n => n > 100 && n < 100000)
    if (nums.length > 0) {
      const meta = JSON.parse(row.metadata || '{}')
      dataPoints.push({
        id: row.id,
        date: meta.date || new Date(row.created_at).toISOString().slice(0, 10),
        numbers: nums,
      })
    }
  }

  if (dataPoints.length < 2) return results

  // Compare latest vs previous: check if median price shifted significantly
  const latest = dataPoints[0]
  const previous = dataPoints[1]

  const medLatest = median(latest.numbers)
  const medPrevious = median(previous.numbers)

  if (medPrevious > 0) {
    const changePct = ((medLatest - medPrevious) / medPrevious) * 100

    if (Math.abs(changePct) > 2) {
      const direction = changePct > 0 ? '上涨' : '下跌'
      results.push({
        title: `钢材价格${direction} ${Math.abs(changePct).toFixed(1)}%`,
        content: `${latest.date} 价格中位数 ${medLatest} 较 ${previous.date} 的 ${medPrevious} ${direction}了 ${Math.abs(changePct).toFixed(1)}%。\n\n这个变动是否影响当前采购计划？`,
        relatedIds: [latest.id, previous.id],
      })
    }
  }

  // Check 3+ day trend
  if (dataPoints.length >= 3) {
    const medians = dataPoints.slice(0, 5).map(d => median(d.numbers))
    const allUp = medians.every((m, i) => i === 0 || m >= medians[i - 1])
    const allDown = medians.every((m, i) => i === 0 || m <= medians[i - 1])

    if ((allUp || allDown) && medians.length >= 3) {
      const totalChange = ((medians[0] - medians[medians.length - 1]) / medians[medians.length - 1]) * 100
      if (Math.abs(totalChange) > 3) {
        const trend = allDown ? '连续下跌' : '连续上涨'
        results.push({
          title: `钢价${trend} ${medians.length} 天，累计 ${Math.abs(totalChange).toFixed(1)}%`,
          content: `近 ${medians.length} 天钢材价格${trend}，累计变动 ${Math.abs(totalChange).toFixed(1)}%。\n\n价格趋势：${medians.map((m, i) => `${dataPoints[i].date}: ${m}`).join(' → ')}\n\n是否需要调整采购节奏？`,
          relatedIds: dataPoints.slice(0, 3).map(d => d.id),
        })
      }
    }
  }

  return results
}

/** Detect anomalies in generic event bubbles */
function detectEventAnomalies(rows: RecentBubbleRow[]): Array<{ title: string; content: string; relatedIds: string[]; spaceId?: string }> {
  const results: Array<{ title: string; content: string; relatedIds: string[]; spaceId?: string }> = []

  // Group events by tag pattern and detect bursts
  const tagCounts = new Map<string, { count: number; ids: string[]; spaceId?: string }>()

  for (const row of rows) {
    const tags = JSON.parse(row.tags || '[]') as string[]
    for (const tag of tags) {
      if (['surprise', 'daily-digest', 'question'].includes(tag)) continue
      const entry = tagCounts.get(tag) || { count: 0, ids: [], spaceId: row.space_id ?? undefined }
      entry.count++
      if (entry.ids.length < 3) entry.ids.push(row.id)
      tagCounts.set(tag, entry)
    }
  }

  // Flag tags with unusual frequency (> 10 events in lookback period)
  for (const [tag, info] of tagCounts) {
    if (info.count > 10) {
      results.push({
        title: `事件激增：「${tag}」出现 ${info.count} 次`,
        content: `近期「${tag}」相关事件出现了 ${info.count} 次，频率异常。\n\n这是否正常？需要关注吗？`,
        relatedIds: info.ids,
        spaceId: info.spaceId,
      })
    }
  }

  return results
}

/** Extract potential entity names from bubble title/content */
function extractEntityNames(title: string, content: string): string[] {
  const names: string[] = []

  // Pattern: XX公司, XX厂, XX供应商 etc.
  const patterns = [
    /[\u4e00-\u9fa5]{2,8}(?:公司|集团|厂|钢铁|钢厂|供应商|客户)/g,
    /(?:客户|供应商|联系人)[：:]?\s*([\u4e00-\u9fa5]{2,6})/g,
  ]

  const text = `${title} ${content}`
  for (const pattern of patterns) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) {
      const name = match[1] || match[0]
      if (name.length >= 2 && name.length <= 12) {
        names.push(name.trim())
      }
    }
  }

  return [...new Set(names)]
}

/** Deduplicate against existing question bubbles (avoid asking same thing twice) */
function deduplicateQuestions(
  questions: Array<{ title: string; content: string; tags: string[]; relatedIds: string[]; spaceId?: string }>,
): typeof questions {
  if (questions.length === 0) return []

  const result: typeof questions = []

  for (const q of questions) {
    // Search for recent similar question bubbles
    const existing = searchBubbles(q.title, 5)
      .filter(b => b.type === 'question' && b.createdAt > Date.now() - 3 * DAY_MS)

    if (existing.length === 0) {
      result.push(q)
    }
  }

  return result
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
