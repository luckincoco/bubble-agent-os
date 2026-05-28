/**
 * Value Proposition Generator (v2) — replaces the old monetary DataValuation.
 *
 * v1: estimated "¥0.87" per [DATA] block.
 * v2: generates human-readable ValuePropositions — connects data to user context.
 *
 * Philosophy (信息土壤):
 *   信息的价值不在信息本身，在它和需要它的人之间的匹配关系。
 *   不输出价格标签，输出"与你库存 50 吨相关"。
 */

import type { ValueProposition } from '../shared/types.js'

/** Parse a [DATA] block from a tool result string. */
function parseDataBlock(result: string): { tool: string; data: Record<string, unknown> } | null {
  const m = result.match(/\[DATA\]\n(\{[\s\S]*?\n)\[\/DATA\]/)
  if (!m) return null
  try { return JSON.parse(m[1]) } catch { return null }
}

/** Extract human-readable info from biz_inventory data. */
function inventoryProposition(data: Record<string, unknown>): string | null {
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : []
  const total = data.totals as Record<string, unknown> | undefined
  const totalTons = total?.stockTons != null ? Number(total.stockTons) : 0

  if (items.length > 0) {
    const names = items.slice(0, 3).map(i => `${i.brand || ''} ${i.name || ''} ${i.spec || ''}`.trim()).filter(Boolean)
    const stockStr = totalTons > 0 ? `库存合计 ${totalTons} 吨` : ''
    return `钢材 ${names.join('、')}${stockStr ? `，${stockStr}` : ''}`
  }

  if (totalTons > 0) return `库存 ${totalTons} 吨`
  return null
}

/** Extract human-readable info from biz_receivables / biz_payables data. */
function financialProposition(data: Record<string, unknown>, type: string): string | null {
  const total = data.totals as Record<string, unknown> | undefined
  const amount = total?.outstanding || total?.amount || 0
  if (!amount) return null
  return `${type === 'receivables' ? '应收' : '应付'}款 ¥${Number(amount).toLocaleString()}`
}

/** Extract human-readable info from biz_dashboard data. */
function dashboardProposition(data: Record<string, unknown>): string | null {
  const parts: string[] = []
  const t = data as Record<string, unknown>
  if (t.totalStockTons) parts.push(`库存 ${t.totalStockTons} 吨`)
  if (t.totalReceivable) parts.push(`应收 ¥${Number(t.totalReceivable).toLocaleString()}`)
  if (t.totalPayable) parts.push(`应付 ¥${Number(t.totalPayable).toLocaleString()}`)
  if (t.totalProfit != null) parts.push(`利润 ¥${Number(t.totalProfit).toLocaleString()}`)
  if (t.totalSalesRevenue != null) parts.push(`营收 ¥${Number(t.totalSalesRevenue).toLocaleString()}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Extract human-readable info from biz_exposure data. */
function exposureProposition(data: Record<string, unknown>): string | null {
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : []
  if (items.length === 0) return null
  const names = items.slice(0, 3).map(i => i.counterparty_name || i.name || '').filter(Boolean)
  const total = data.totals as Record<string, unknown> | undefined
  const amount = total?.totalExposure || total?.amount || 0
  return `风险敞口：${names.join('、')}${amount ? ` ¥${Number(amount).toLocaleString()}` : ''}`
}

/** Pick a human-readable label for a tool name. */
function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    biz_inventory: '库存查询',
    biz_dashboard: '业务概览',
    biz_receivables: '应收报表',
    biz_payables: '应付报表',
    biz_profit_report: '利润报表',
    biz_profit_by_order: '订单利润',
    biz_counterparty_statement: '对账单',
    biz_monthly_overview: '月度概况',
    biz_project_reconciliation: '项目对账',
    biz_uninvoiced: '未开票',
    biz_excel_lookup: 'Excel 查询',
    biz_silence_alerts: '沉默预警',
    biz_exposure: '风险敞口',
    biz_relationships: '关系图谱',
    biz_concentration: '集中度分析',
  }
  return labels[toolName] || toolName.replace(/^biz_/, '')
}

/** Generate a relevance string connecting the data to user context. */
function dataRelevance(data: Record<string, unknown>, queryContext: string): string {
  const items = Array.isArray(data.items) ? data.items as Array<Record<string, unknown>> : []
  if (items.length === 0) return ''

  // If query matches item names, highlight it
  for (const item of items) {
    const name = (item.name || item.counterparty_name || '') as string
    if (name && queryContext.includes(name)) {
      const stock = item.stockTons != null ? `（${item.stockTons} 吨）` : ''
      return `与你关注的「${name}」相关${stock}`
    }
  }
  return ''
}

/**
 * Generate ValuePropositions from [DATA]-containing tool results.
 * Returns empty array if no data blocks found or feature off.
 */
export function generateValuePropositions(
  toolCalls: Array<{ name: string; result: string }>,
  queryContext: string,
): ValueProposition[] {
  const results: ValueProposition[] = []

  for (const tc of toolCalls) {
    const block = parseDataBlock(tc.result)
    if (!block) continue

    const data = block.data as Record<string, unknown>
    const name = tc.name
    let summary: string | null = null

    if (name === 'biz_inventory') summary = inventoryProposition(data)
    else if (name === 'biz_receivables') summary = financialProposition(data, 'receivables')
    else if (name === 'biz_payables') summary = financialProposition(data, 'payables')
    else if (name === 'biz_dashboard') summary = dashboardProposition(data)
    else if (name === 'biz_exposure') summary = exposureProposition(data)
    else {
      // Generic: pick top-level numeric values
      const vals = Object.entries(data)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .slice(0, 2)
        .map(([k, v]) => `${k}: ${Number(v).toLocaleString()}`)
      if (vals.length > 0) summary = vals.join(' · ')
    }

    if (!summary) continue

    const relevance = dataRelevance(data, queryContext)

    results.push({
      label: summary,
      relevance: relevance || `来自${toolLabel(name)}`,
      source: toolLabel(name),
      confidence: 0.8,
    })
  }

  return results
}

/**
 * Build a value statement string from value propositions.
 * Replaces the old "📊 数据估值：¥0.87" format.
 */
export function buildValueStatement(propositions: ValueProposition[]): string {
  if (propositions.length === 0) return ''

  const lines = propositions.map(p => {
    let line = `  ─ ${p.label}`
    if (p.relevance) line += `（${p.relevance}）`
    return line
  })

  return [
    '',
    `与你相关的 ${propositions.length} 条信息：`,
    ...lines,
  ].join('\n')
}
