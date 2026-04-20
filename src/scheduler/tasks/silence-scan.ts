import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

/**
 * Silence Scan (沉默扫描) — Phase Zero time attribute t_silence.
 *
 * Runs on a schedule, scans structured biz_* tables to detect counterparties
 * whose transaction activity has gone silent beyond their normal rhythm.
 * Creates 'observation' type bubbles for each detected silence.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE_STATUS = "doc_status IN ('confirmed','completed')"

interface ActivityRow {
  counterparty_id: string
  last_date: string
  cnt: number
  first_date: string
}

interface CounterpartyInfo {
  id: string
  name: string
  type: string
}

export async function executeSilenceScan(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10)
  const todayMs = new Date(today + 'T00:00:00').getTime()
  const silenceMultiplier = Number(params.silenceMultiplier) || 2.0
  const minTransactions = Number(params.minTransactions) || 3
  const maxThresholdDays = 90

  const bubbleIds: string[] = []
  const silentNames: string[] = []

  // Get all spaces that have counterparties
  const spaces = db.prepare(
    "SELECT DISTINCT space_id FROM biz_counterparties WHERE tenant_id = 'default' AND space_id IS NOT NULL",
  ).all() as Array<{ space_id: string }>

  for (const { space_id: spaceId } of spaces) {
    // Batch query: get last activity date + transaction count per counterparty
    const activityRows = db.prepare(`
      SELECT counterparty_id, MAX(date) as last_date, COUNT(*) as cnt, MIN(date) as first_date
      FROM (
        SELECT supplier_id as counterparty_id, date FROM biz_purchases
          WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
        UNION ALL
        SELECT customer_id, date FROM biz_sales
          WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
        UNION ALL
        SELECT counterparty_id, date FROM biz_payments
          WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
        UNION ALL
        SELECT carrier_id, date FROM biz_logistics
          WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      ) t
      WHERE counterparty_id IS NOT NULL
      GROUP BY counterparty_id
      HAVING COUNT(*) >= ?
    `).all(spaceId, spaceId, spaceId, spaceId, minTransactions) as ActivityRow[]

    for (const row of activityRows) {
      const lastDateMs = new Date(row.last_date + 'T00:00:00').getTime()
      const firstDateMs = new Date(row.first_date + 'T00:00:00').getTime()
      const daysSilent = Math.floor((todayMs - lastDateMs) / DAY_MS)

      // Compute average interval between transactions
      const spanDays = Math.max(1, Math.floor((lastDateMs - firstDateMs) / DAY_MS))
      const avgInterval = spanDays / Math.max(1, row.cnt - 1)

      // Silence threshold with cap
      const threshold = Math.min(Math.ceil(silenceMultiplier * avgInterval), maxThresholdDays)

      if (daysSilent <= threshold) continue

      // Look up counterparty name
      const cp = db.prepare(
        'SELECT id, name, type FROM biz_counterparties WHERE id = ?',
      ).get(row.counterparty_id) as CounterpartyInfo | undefined
      if (!cp) continue

      // Deduplicate: skip if we already created a silence observation for this counterparty in the last 7 days
      const existing = searchBubbles(`${cp.name} 沉默`, 5)
        .filter(b => b.type === 'observation'
          && b.tags?.includes('t_silence')
          && b.createdAt > Date.now() - 7 * DAY_MS)
      if (existing.length > 0) continue

      // Create observation bubble
      const title = `${cp.name} 已沉默 ${daysSilent} 天`
      const content = [
        `${cp.name}（${cp.type === 'supplier' ? '供应商' : cp.type === 'customer' ? '客户' : cp.type === 'logistics' ? '物流' : '供应商/客户'}）`,
        `最后交易日期：${row.last_date}`,
        `历史交易次数：${row.cnt} 次`,
        `平均交易间隔：${Math.round(avgInterval)} 天`,
        `沉默天数：${daysSilent} 天（阈值 ${threshold} 天）`,
        '',
        '是否需要跟进？',
      ].join('\n')

      const bubble = createBubble({
        type: 'observation',
        title,
        content,
        tags: ['observation', 'silence-scan', 't_silence', cp.name],
        source: 'silence-scan',
        confidence: 0.85,
        decayRate: 0.2,
        spaceId,
      })
      bubbleIds.push(bubble.id)
      silentNames.push(cp.name)
    }
  }

  // Push summary to Feishu
  if (deps.feishu && silentNames.length > 0) {
    const chatId = deps.feishu.getAdminChatId() || String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        await deps.feishu.pushMessage(
          chatId,
          `沉默扫描发现 ${silentNames.length} 个交易对手超过正常交易节奏：\n\n${silentNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\n在对话中问我可以了解详情。`,
        )
      } catch (err) {
        logger.error('SilenceScan Feishu push failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  if (silentNames.length === 0) {
    return { success: true, message: '沉默扫描完成，所有交易对手活跃正常' }
  }

  logger.info(`SilenceScan: detected ${silentNames.length} silent counterparties`)
  return {
    success: true,
    message: `检测到 ${silentNames.length} 个沉默交易对手：${silentNames.join('、')}`,
    bubbleIds,
  }
}
