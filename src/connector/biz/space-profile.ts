/**
 * Space Profile (SPACE.md equivalent)
 *
 * Generates a compact business context summary for a space,
 * injected into the system prompt so the LLM understands the
 * business environment without loading full data.
 *
 * Inspired by Claude Code's CLAUDE.md — persistent, space-scoped prompt context.
 */

import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import { getExposure, getSilenceAlerts, getConcentrationMetrics } from './structured-store.js'

const TENANT = 'default'

/** Format number with thousands separator, no decimals */
function fmtNum(n: number): string {
  return Math.round(n).toLocaleString('zh-CN')
}

// Cache: spaceId → { profile, generatedAt }
const profileCache = new Map<string, { profile: string; generatedAt: number }>()
const CACHE_TTL_MS = 10 * 60 * 1000  // 10 minutes

export function getSpaceProfile(spaceId: string): string {
  if (!spaceId) return ''

  const cached = profileCache.get(spaceId)
  if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
    return cached.profile
  }

  try {
    const profile = generateProfile(spaceId)
    profileCache.set(spaceId, { profile, generatedAt: Date.now() })
    return profile
  } catch (err) {
    logger.debug(`SpaceProfile: failed for ${spaceId}: ${err instanceof Error ? err.message : String(err)}`)
    return ''
  }
}

function generateProfile(spaceId: string): string {
  const db = getDatabase()

  // Space name
  const space = db.prepare('SELECT name, description FROM spaces WHERE id = ?').get(spaceId) as { name: string; description: string } | undefined
  const spaceName = space?.name || '未知空间'

  // Counterparties summary (with lindy days)
  const suppliers = db.prepare(
    `SELECT name, first_interaction, CAST(julianday('now') - julianday(first_interaction) AS INTEGER) as lindy_days FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND type IN ('supplier','both') AND deleted_at IS NULL ORDER BY name LIMIT 15`,
  ).all(TENANT, spaceId) as { name: string; first_interaction: string | null; lindy_days: number | null }[]

  const customers = db.prepare(
    `SELECT name, first_interaction, CAST(julianday('now') - julianday(first_interaction) AS INTEGER) as lindy_days FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND type IN ('customer','both') AND deleted_at IS NULL ORDER BY name LIMIT 15`,
  ).all(TENANT, spaceId) as { name: string; first_interaction: string | null; lindy_days: number | null }[]

  // Projects
  const projects = db.prepare(
    `SELECT name, status FROM biz_projects WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL ORDER BY name LIMIT 10`,
  ).all(TENANT, spaceId) as { name: string; status: string }[]

  // Data volume
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL) AS purchases,
      (SELECT COUNT(*) FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL) AS sales,
      (SELECT COUNT(*) FROM biz_logistics WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL) AS logistics,
      (SELECT COUNT(*) FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL) AS payments
  `).get(TENANT, spaceId, TENANT, spaceId, TENANT, spaceId, TENANT, spaceId) as Record<string, number>

  // Date range
  const dateRange = db.prepare(`
    SELECT MIN(d) AS earliest, MAX(d) AS latest FROM (
      SELECT date AS d FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL
      UNION ALL SELECT date FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL
    )
  `).get(TENANT, spaceId, TENANT, spaceId) as { earliest: string; latest: string } | undefined

  // Products top 5
  const topProducts = db.prepare(`
    SELECT p.brand, p.name, p.spec, COUNT(*) AS cnt
    FROM biz_purchases pu JOIN biz_products p ON p.id = pu.product_id
    WHERE pu.tenant_id = ? AND pu.space_id = ? AND pu.deleted_at IS NULL
    GROUP BY p.id ORDER BY cnt DESC LIMIT 5
  `).all(TENANT, spaceId) as { brand: string; name: string; spec: string; cnt: number }[]

  // Build profile
  const lines: string[] = [
    `\n## 当前空间：${spaceName}`,
    `行业：钢贸（钢材贸易） | 金额单位：元 | 重量单位：吨`,
  ]

  if (dateRange?.earliest) {
    lines.push(`数据范围：${dateRange.earliest} ~ ${dateRange.latest}`)
  }

  lines.push(`数据量：采购 ${counts?.purchases || 0} 笔、销售 ${counts?.sales || 0} 笔、物流 ${counts?.logistics || 0} 笔、收付款 ${counts?.payments || 0} 笔`)

  if (suppliers.length > 0) {
    lines.push(`核心供应商：${suppliers.map(s => s.lindy_days != null ? `${s.name}(${s.lindy_days}天)` : s.name).join('、')}`)
  }
  if (customers.length > 0) {
    lines.push(`核心客户：${customers.map(c => c.lindy_days != null ? `${c.name}(${c.lindy_days}天)` : c.name).join('、')}`)
  }
  if (projects.length > 0) {
    const active = projects.filter(p => p.status === 'active')
    lines.push(`项目：${active.map(p => p.name).join('、')}${active.length < projects.length ? `（另有 ${projects.length - active.length} 个已完工）` : ''}`)
  }
  if (topProducts.length > 0) {
    lines.push(`常用钢材：${topProducts.map(p => `${p.brand} ${p.name} ${p.spec}`).join('、')}`)
  }

  // ── Phase 1: 敞口摘要 ─────────────────────────────────────────
  try {
    const exposure = getExposure({ spaceId })
    if (exposure.netExposure !== 0) {
      lines.push(`净敞口 ¥${fmtNum(exposure.totalReceivable)}(应收) - ¥${fmtNum(exposure.totalPayable)}(应付) = ¥${fmtNum(exposure.netExposure)}`)
      const highRisk = exposure.items.filter(i => Math.abs(i.netExposure) >= 100000)
      if (highRisk.length > 0) {
        const top = highRisk.slice(0, 3).map(i =>
          `${i.name}(${i.netExposure > 0 ? '应收' : '应付'}¥${fmtNum(Math.abs(i.netExposure))})`,
        ).join('、')
        lines.push(`高敞口预警：${top}`)
      }
    }
  } catch { /* exposure query may fail on empty data */ }

  // ── Phase 1: 沉默预警摘要 ─────────────────────────────────────
  try {
    const silenceAlerts = getSilenceAlerts({ spaceId })
    if (silenceAlerts.length > 0) {
      const top3 = silenceAlerts.slice(0, 3).map(a => `${a.name}(${a.silentDays}天)`).join('、')
      lines.push(`沉默预警：${silenceAlerts.length} 个交易对手超出正常节奏，最突出：${top3}`)
    }
  } catch { /* silence query may fail on empty data */ }

  // ── Phase 3: 集中度预警摘要 ───────────────────────────────────
  try {
    const conc = getConcentrationMetrics({ spaceId })
    if (conc.supplierConcentration.warning) {
      const top = conc.supplierConcentration.topItems.map(i => `${i.name}(${i.share}%)`).join('、')
      lines.push(`供应商集中度预警：前${conc.supplierConcentration.topN}大占采购总额 ${conc.supplierConcentration.topNShare}%（阈值${conc.threshold}%）：${top}`)
    }
    if (conc.customerConcentration.warning) {
      const top = conc.customerConcentration.topItems.map(i => `${i.name}(${i.share}%)`).join('、')
      lines.push(`客户集中度预警：前${conc.customerConcentration.topN}大占销售总额 ${conc.customerConcentration.topNShare}%（阈值${conc.threshold}%）：${top}`)
    }
  } catch { /* concentration query may fail on empty data */ }

  return lines.join('\n')
}
