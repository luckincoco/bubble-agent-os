/**
 * Mirror Enhancer — uses LLM to transform template mirror text into
 * context-aware, relationship-sensitive business notifications.
 *
 * Falls back to template text on any error.
 */

import type { LLMProvider } from '../../shared/types.js'
import { getDatabase } from '../../storage/database.js'
import { computeLindyDays } from '../biz/structured-store.js'
import { TONE_PROFILES } from '../../kernel/external-prompts.js'
import { logger } from '../../shared/logger.js'

const TENANT = 'default'
const ACTIVE_STATUS = "doc_status IN ('confirmed','completed')"
const ENHANCE_TIMEOUT_MS = 10_000

export interface MirrorEnhanceInput {
  templateText: string
  counterpartyId: string
  counterpartyName: string
  counterpartyType: 'supplier' | 'customer' | 'logistics'
  eventType: string
  spaceId: string
}

interface RelationshipContext {
  lindyDays: number | null
  recentTxCount: number
  totalTxCount: number
  lastTxDate: string | null
}

function queryRelationshipContext(counterpartyId: string, spaceId: string): RelationshipContext {
  const db = getDatabase()

  // First interaction date for Lindy days
  const cp = db.prepare(
    'SELECT first_interaction FROM biz_counterparties WHERE id = ?',
  ).get(counterpartyId) as { first_interaction: string | null } | undefined

  const lindyDays = cp?.first_interaction ? computeLindyDays(cp.first_interaction) : null

  // Transaction count + last date + recent (30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)

  const stats = db.prepare(`
    SELECT COUNT(*) as total_cnt,
           MAX(date) as last_date,
           SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) as recent_cnt
    FROM (
      SELECT date FROM biz_purchases WHERE supplier_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT date FROM biz_sales WHERE customer_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT date FROM biz_payments WHERE counterparty_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT date FROM biz_logistics WHERE carrier_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
    ) t
  `).get(thirtyDaysAgo, counterpartyId, spaceId, counterpartyId, spaceId, counterpartyId, spaceId, counterpartyId, spaceId) as {
    total_cnt: number; last_date: string | null; recent_cnt: number
  } | undefined

  return {
    lindyDays,
    recentTxCount: stats?.recent_cnt ?? 0,
    totalTxCount: stats?.total_cnt ?? 0,
    lastTxDate: stats?.last_date ?? null,
  }
}

function formatLindyDays(days: number | null): string {
  if (days == null || days <= 0) return '新合作伙伴'
  if (days < 30) return `${days}天`
  if (days < 365) return `${Math.floor(days / 30)}个月`
  const years = Math.floor(days / 365)
  const months = Math.floor((days % 365) / 30)
  return months > 0 ? `${years}年${months}个月` : `${years}年`
}

export async function enhanceMirrorText(
  llm: LLMProvider,
  input: MirrorEnhanceInput,
): Promise<string> {
  const rel = queryRelationshipContext(input.counterpartyId, input.spaceId)
  const tone = TONE_PROFILES[input.counterpartyType] || TONE_PROFILES.customer

  const relationshipInfo = [
    `合作时长：${formatLindyDays(rel.lindyDays)}`,
    `累计交易：${rel.totalTxCount}笔`,
    rel.recentTxCount > 0 ? `近30天交易：${rel.recentTxCount}笔` : null,
    rel.lastTxDate ? `上次交易：${rel.lastTxDate}` : null,
  ].filter(Boolean).join('；')

  const typeLabel = input.counterpartyType === 'supplier' ? '供应商'
    : input.counterpartyType === 'customer' ? '客户' : '物流商'

  const systemPrompt = `你是华瑞隆钢贸的对外通知助手。请将以下业务模板信息改写为一段自然、温暖的客户通知消息。

要求：
1. 保留模板中所有数字事实（金额、吨位、日期），不可篡改
2. 语气：${tone.style}
3. 可适当融入合作关系信息，但不要生硬堆砌
4. 控制在200字以内
5. 直接输出改写后的通知文本，不要加任何解释`

  const userPrompt = `对方身份：${input.counterpartyName}（${typeLabel}）
关系信息：${relationshipInfo}
原始模板：${input.templateText}

请改写为自然的业务通知：`

  const result = await Promise.race([
    llm.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('LLM enhancement timeout')), ENHANCE_TIMEOUT_MS),
    ),
  ])

  const enhanced = result.content.trim()
  if (!enhanced) throw new Error('LLM returned empty content')

  // Sanity check: verify key amounts from template appear in enhanced text
  // Extract numbers >= 100 from template
  const templateNumbers = input.templateText.match(/\d[\d,.]*\d/g) || []
  const significantNumbers = templateNumbers
    .map(n => n.replace(/,/g, ''))
    .filter(n => parseFloat(n) >= 100)

  for (const num of significantNumbers) {
    // Check plain number or comma-formatted version
    const plain = num.replace(/,/g, '')
    if (!enhanced.includes(plain) && !enhanced.includes(num)) {
      logger.warn(`MirrorEnhancer: key number ${num} missing in enhanced text, falling back`)
      throw new Error(`Key number ${num} missing in enhanced text`)
    }
  }

  return enhanced
}
