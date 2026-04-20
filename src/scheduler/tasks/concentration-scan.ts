import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { getConcentrationMetrics } from '../../connector/biz/structured-store.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'

const DAY_MS = 24 * 60 * 60 * 1000

export async function executeConcentrationScan(
  params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const db = getDatabase()
  const topN = Number(params.topN) || 3
  const threshold = Number(params.threshold) || 60

  const warnings: string[] = []
  const bubbleIds: string[] = []

  const spaces = db.prepare(
    "SELECT DISTINCT space_id FROM biz_counterparties WHERE tenant_id = 'default' AND space_id IS NOT NULL",
  ).all() as Array<{ space_id: string }>

  for (const { space_id: spaceId } of spaces) {
    const metrics = getConcentrationMetrics({ spaceId }, { topN, threshold })

    const sides = [
      { label: '供应商', side: metrics.supplierConcentration, tag: 'supplier' },
      { label: '客户', side: metrics.customerConcentration, tag: 'customer' },
    ]

    for (const { label, side, tag } of sides) {
      if (!side.warning) continue

      const topNames = side.topItems.map(i => `${i.name}(${i.share}%)`).join('、')
      const summary = `前${side.topN}大${label}占${label === '供应商' ? '采购' : '销售'}总额 ${side.topNShare}%（阈值${threshold}%）：${topNames}`

      // Deduplicate: skip if a concentration-warning bubble for this side exists within 7 days
      const existing = searchBubbles(`集中度 ${label}`, 5)
        .filter(b => b.type === 'observation'
          && b.tags?.includes('concentration-warning')
          && b.tags?.includes(tag)
          && b.createdAt > Date.now() - 7 * DAY_MS)
      if (existing.length > 0) continue

      const bubble = createBubble({
        type: 'observation',
        title: `${label}集中度预警：Top ${side.topN} 占 ${side.topNShare}%`,
        content: summary,
        tags: ['observation', 'concentration-warning', tag],
        source: 'concentration-scan',
        confidence: 0.85,
        decayRate: 0.15,
        spaceId,
      })
      bubbleIds.push(bubble.id)
      warnings.push(summary)
    }
  }

  // Push to Feishu
  if (deps.feishu && warnings.length > 0) {
    const chatId = deps.feishu.getAdminChatId() || String(params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        await deps.feishu.pushMessage(
          chatId,
          `集中度扫描发现 ${warnings.length} 项预警：\n\n${warnings.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n\n在对话中问我"查看集中度"可以了解详情。`,
        )
      } catch (err) {
        logger.error('ConcentrationScan Feishu push failed:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  if (warnings.length === 0) {
    return { success: true, message: '集中度扫描完成，未发现过度集中' }
  }

  logger.info(`ConcentrationScan: ${warnings.length} warnings detected`)
  return {
    success: true,
    message: `检测到 ${warnings.length} 项集中度预警`,
    bubbleIds,
  }
}
