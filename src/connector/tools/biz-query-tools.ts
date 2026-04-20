/**
 * Business query tools — wraps reports.ts + structured-store.ts for LLM agent access.
 * Each tool accepts natural-language-friendly params and returns markdown.
 */

import type { ToolDefinition } from '../registry.js'
import type { UserContext } from '../../shared/types.js'
import type { BizContext } from '../biz/structured-store.js'
import {
  getDashboard, getInventory, getReceivables, getPayables,
  getCounterparties, fuzzyFindCounterparty,
  getProjectReconciliation, getUninvoicedAmount,
  getExposure, getSilenceAlerts, computeLindyDays, getConcentrationMetrics,
} from '../biz/structured-store.js'
import {
  getProfitReport, getCounterpartyStatement, getMonthlyOverview, getProfitByOrder,
} from '../biz/reports.js'
import { searchBubbles } from '../../bubble/model.js'

// ── Helpers ──────────────────────────────────────────────────────────

function toBizCtx(ctx?: UserContext): BizContext {
  return { spaceId: ctx?.activeSpaceId ?? '' }
}

function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '暂无数据'
  const sep = headers.map(() => '---')
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ]
  return lines.join('\n')
}

/** Resolve counterparty name → id, with helpful error message */
function resolveCounterparty(
  bizCtx: BizContext,
  name: string,
  type?: string,
): { id: string; name: string } | string {
  const cp = fuzzyFindCounterparty(bizCtx, name, type)
  if (cp) return { id: cp.id, name: cp.name }
  // Provide suggestions
  const all = getCounterparties(bizCtx, type)
  const names = all.slice(0, 10).map(c => c.name)
  return `找不到"${name}"。系统中的${type === 'customer' ? '客户' : type === 'supplier' ? '供应商' : '往来对象'}：${names.join('、') || '暂无'}`
}

// ── Tool Factories ───────────────────────────────────────────────────

function createBizDashboardTool(): ToolDefinition {
  return {
    name: 'biz_dashboard',
    description: '查看业务概览：今日进销存数量、库存吨数、应收应付金额、最近交易',
    parameters: {},
    async execute(_args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const d = getDashboard(bizCtx)
      const lines = [
        `## 业务概览`,
        `今日采购 ${d.todayPurchases} 笔 | 销售 ${d.todaySales} 笔 | 物流 ${d.todayLogistics} 笔`,
        `库存 ${fmt(d.totalStockTons)} 吨 | 应收 ¥${fmt(d.totalReceivable)} | 应付 ¥${fmt(d.totalPayable)}`,
      ]
      if (d.recentTransactions.length > 0) {
        lines.push('', '### 最近交易')
        const rows = d.recentTransactions.map(t => [
          t.type, t.date, t.counterparty || '-', t.product || '-', `¥${fmt(t.amount)}`,
        ])
        lines.push(mdTable(['类型', '日期', '对方', '品名', '金额'], rows))
      }
      return lines.join('\n')
    },
  }
}

function createBizInventoryTool(): ToolDefinition {
  return {
    name: 'biz_inventory',
    description: '查询当前库存（按品名/规格模糊搜索）',
    parameters: {
      product: { type: 'string', description: '品名/规格关键词（如 HRB400E、Φ25），可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const keyword = (args.product as string)?.trim()
      let items = getInventory(bizCtx)
      if (keyword) {
        const q = keyword.toLowerCase()
        items = items.filter(i =>
          [i.brand, i.name, i.spec, i.code].some(s => s?.toLowerCase().includes(q))
        )
      }
      if (items.length === 0) return keyword ? `没有找到包含"${keyword}"的库存记录` : '暂无库存数据'
      const rows = items.map(i => [
        i.brand || '-', i.name || '-', i.spec || '-',
        fmt(i.purchaseTons), fmt(i.salesTons), fmt(i.stockTons),
      ])
      const totals = items.reduce((a, i) => ({
        p: a.p + (i.purchaseTons ?? 0), s: a.s + (i.salesTons ?? 0), st: a.st + (i.stockTons ?? 0),
      }), { p: 0, s: 0, st: 0 })
      rows.push(['**合计**', '', '', fmt(totals.p), fmt(totals.s), fmt(totals.st)])
      return mdTable(['品牌', '品名', '规格', '采购(吨)', '销售(吨)', '库存(吨)'], rows)
    },
  }
}

function createBizReceivablesTool(): ToolDefinition {
  return {
    name: 'biz_receivables',
    description: '查询应收账款（谁欠我们钱），可按客户名筛选',
    parameters: {
      customer: { type: 'string', description: '客户名称关键词，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const keyword = (args.customer as string)?.trim()
      let items = getReceivables(bizCtx)
      if (keyword) {
        const q = keyword.toLowerCase()
        items = items.filter(i => i.name?.toLowerCase().includes(q))
      }
      if (items.length === 0) return '暂无应收款数据'
      const rows = items.map(i => [
        i.name, `¥${fmt(i.totalSales)}`, `¥${fmt(i.received)}`, `¥${fmt(i.outstanding)}`,
      ])
      const totals = items.reduce((a, i) => ({
        ts: a.ts + i.totalSales, r: a.r + i.received, o: a.o + i.outstanding,
      }), { ts: 0, r: 0, o: 0 })
      rows.push(['**合计**', `¥${fmt(totals.ts)}`, `¥${fmt(totals.r)}`, `¥${fmt(totals.o)}`])
      return mdTable(['客户', '销售总额', '已收款', '未收款'], rows)
    },
  }
}

function createBizPayablesTool(): ToolDefinition {
  return {
    name: 'biz_payables',
    description: '查询应付账款（我们欠谁钱），可按供应商名筛选',
    parameters: {
      supplier: { type: 'string', description: '供应商名称关键词，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const keyword = (args.supplier as string)?.trim()
      let items = getPayables(bizCtx)
      if (keyword) {
        const q = keyword.toLowerCase()
        items = items.filter(i => i.name?.toLowerCase().includes(q))
      }
      if (items.length === 0) return '暂无应付款数据'
      const rows = items.map(i => [
        i.name, `¥${fmt(i.totalPurchases)}`, `¥${fmt(i.paid)}`, `¥${fmt(i.outstanding)}`,
      ])
      const totals = items.reduce((a, i) => ({
        tp: a.tp + i.totalPurchases, p: a.p + i.paid, o: a.o + i.outstanding,
      }), { tp: 0, p: 0, o: 0 })
      rows.push(['**合计**', `¥${fmt(totals.tp)}`, `¥${fmt(totals.p)}`, `¥${fmt(totals.o)}`])
      return mdTable(['供应商', '采购总额', '已付款', '未付款'], rows)
    },
  }
}

function createBizProfitReportTool(): ToolDefinition {
  return {
    name: 'biz_profit_report',
    description: '查询月度利润报表：销售额、采购成本、运费、毛利、毛利率',
    parameters: {
      date_from: { type: 'string', description: '起始日期 YYYY-MM-DD，可选' },
      date_to: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
      customer: { type: 'string', description: '客户名称（按客户筛选），可选' },
      supplier: { type: 'string', description: '供应商名称（按供应商筛选），可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const filter: Record<string, string | undefined> = {
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
      }

      if (args.customer) {
        const result = resolveCounterparty(bizCtx, args.customer as string, 'customer')
        if (typeof result === 'string') return result
        filter.customerId = result.id
      }
      if (args.supplier) {
        const result = resolveCounterparty(bizCtx, args.supplier as string, 'supplier')
        if (typeof result === 'string') return result
        filter.supplierId = result.id
      }

      const rows = getProfitReport(bizCtx, filter)
      if (rows.length === 0) return '指定条件下暂无利润数据'

      const tableRows = rows.map(r => [
        r.month, `¥${fmt(r.salesRevenue)}`, `¥${fmt(r.purchaseCost)}`, `¥${fmt(r.logisticsCost)}`,
        `¥${fmt(r.grossProfit)}`, `${r.margin}%`, fmt(r.salesTons), fmt(r.purchaseTons),
      ])
      const totals = rows.reduce((a, r) => ({
        sr: a.sr + r.salesRevenue, pc: a.pc + r.purchaseCost, lc: a.lc + r.logisticsCost,
        gp: a.gp + r.grossProfit, st: a.st + r.salesTons, pt: a.pt + r.purchaseTons,
      }), { sr: 0, pc: 0, lc: 0, gp: 0, st: 0, pt: 0 })
      const totalMargin = totals.sr > 0 ? Math.round(totals.gp / totals.sr * 10000) / 100 : 0
      tableRows.push([
        '**合计**', `¥${fmt(totals.sr)}`, `¥${fmt(totals.pc)}`, `¥${fmt(totals.lc)}`,
        `¥${fmt(totals.gp)}`, `${totalMargin}%`, fmt(totals.st), fmt(totals.pt),
      ])
      return mdTable(['月份', '销售额', '采购成本', '运费', '毛利', '毛利率', '销售(吨)', '采购(吨)'], tableRows)
    },
  }
}

function createBizProfitByOrderTool(): ToolDefinition {
  return {
    name: 'biz_profit_by_order',
    description: '按单号查看利润明细（每笔订单的进销差价）',
    parameters: {
      date_from: { type: 'string', description: '起始日期 YYYY-MM-DD，可选' },
      date_to: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
      customer: { type: 'string', description: '客户名称，可选' },
      supplier: { type: 'string', description: '供应商名称，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const filter: Record<string, string | undefined> = {
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
      }

      if (args.customer) {
        const result = resolveCounterparty(bizCtx, args.customer as string, 'customer')
        if (typeof result === 'string') return result
        filter.customerId = result.id
      }
      if (args.supplier) {
        const result = resolveCounterparty(bizCtx, args.supplier as string, 'supplier')
        if (typeof result === 'string') return result
        filter.supplierId = result.id
      }

      const rows = getProfitByOrder(bizCtx, filter)
      if (rows.length === 0) return '指定条件下暂无按单利润数据'

      // Limit to 20 rows for LLM context
      const limited = rows.slice(0, 20)
      const tableRows = limited.map(r => [
        r.docNo || '-', r.date, r.supplierName || '-', r.customerName || '-',
        `¥${fmt(r.purchaseAmount)}`, `¥${fmt(r.salesAmount)}`, `¥${fmt(r.logisticsCost)}`,
        `¥${fmt(r.grossProfit)}`, `${r.margin}%`,
      ])
      let result = mdTable(
        ['单号', '日期', '供应商', '客户', '采购额', '销售额', '运费', '毛利', '毛利率'],
        tableRows,
      )
      if (rows.length > 20) {
        result += `\n\n共 ${rows.length} 条，仅展示前 20 条。`
      }
      return result
    },
  }
}

function createBizCounterpartyStatementTool(): ToolDefinition {
  return {
    name: 'biz_counterparty_statement',
    description: '查询往来对账单：与某客户/供应商的所有交易流水和余额',
    parameters: {
      counterparty: { type: 'string', description: '客户或供应商名称', required: true },
      date_from: { type: 'string', description: '起始日期 YYYY-MM-DD，可选' },
      date_to: { type: 'string', description: '截止日期 YYYY-MM-DD，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const name = (args.counterparty as string)?.trim()
      if (!name) return 'Error: counterparty 参数必填'

      const result = resolveCounterparty(bizCtx, name)
      if (typeof result === 'string') return result

      const stmt = getCounterpartyStatement(
        bizCtx, result.id,
        args.date_from as string | undefined,
        args.date_to as string | undefined,
      )

      const typeMap: Record<string, string> = {
        purchase: '采购', sale: '销售',
        payment_in: '收款', payment_out: '付款',
        invoice_in: '进项发票', invoice_out: '销项发票',
      }

      const lines = [`## 往来对账单: ${stmt.counterpartyName}`]
      if (stmt.rows.length === 0) {
        lines.push('暂无往来记录')
      } else {
        // Limit to 30 rows
        const limited = stmt.rows.slice(0, 30)
        const tableRows = limited.map(r => [
          r.date, typeMap[r.type] || r.type, r.description || '-',
          r.debit > 0 ? `¥${fmt(r.debit)}` : '', r.credit > 0 ? `¥${fmt(r.credit)}` : '',
          `¥${fmt(r.balance)}`,
        ])
        lines.push(mdTable(['日期', '类型', '描述', '借方', '贷方', '余额'], tableRows))
        if (stmt.rows.length > 30) {
          lines.push(`\n共 ${stmt.rows.length} 条，仅展示前 30 条。`)
        }
      }
      lines.push('')
      lines.push(`期末余额: ¥${fmt(stmt.closingBalance)}（正=对方欠我们）`)
      return lines.join('\n')
    },
  }
}

function createBizMonthlyOverviewTool(): ToolDefinition {
  return {
    name: 'biz_monthly_overview',
    description: '查看某年度的月度总览：每月采购/销售/运费/收付款/发票汇总',
    parameters: {
      year: { type: 'number', description: '年份（如 2026），默认当年' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const year = args.year ? Number(args.year) : undefined
      const rows = getMonthlyOverview(bizCtx, year)
      // Filter out all-zero months
      const active = rows.filter(r =>
        r.purchaseAmount || r.salesAmount || r.logisticsAmount ||
        r.paymentsIn || r.paymentsOut || r.invoicesIn || r.invoicesOut
      )
      if (active.length === 0) return `${year || new Date().getFullYear()} 年暂无业务数据`

      const tableRows = active.map(r => [
        r.month, `¥${fmt(r.purchaseAmount)}`, fmt(r.purchaseTons),
        `¥${fmt(r.salesAmount)}`, fmt(r.salesTons),
        `¥${fmt(r.logisticsAmount)}`,
        `¥${fmt(r.paymentsIn)}`, `¥${fmt(r.paymentsOut)}`,
      ])
      return mdTable(
        ['月份', '采购额', '采购(吨)', '销售额', '销售(吨)', '运费', '收款', '付款'],
        tableRows,
      )
    },
  }
}

function createBizProjectReconciliationTool(): ToolDefinition {
  return {
    name: 'biz_project_reconciliation',
    description: '查询项目结算情况：每个项目的销售/物流/收付款/未结金额',
    parameters: {
      project: { type: 'string', description: '项目名称关键词，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const keyword = (args.project as string)?.trim()
      let items = getProjectReconciliation(bizCtx)
      if (keyword) {
        const q = keyword.toLowerCase()
        items = items.filter(i => i.projectName?.toLowerCase().includes(q))
      }
      if (items.length === 0) return keyword ? `没有找到包含"${keyword}"的项目` : '暂无项目数据'

      const tableRows = items.map(i => [
        i.projectName, i.status || '-',
        `¥${fmt(i.totalSales)}`, `¥${fmt(i.totalLogistics)}`,
        `¥${fmt(i.totalPaymentsIn)}`, `¥${fmt(i.totalPaymentsOut)}`,
        `¥${fmt(i.outstanding)}`,
      ])
      return mdTable(['项目', '状态', '销售额', '物流费', '收款', '付款', '未结金额'], tableRows)
    },
  }
}

function createBizUninvoicedTool(): ToolDefinition {
  return {
    name: 'biz_uninvoiced',
    description: '查询某往来对象的未开票金额（进项/销项）',
    parameters: {
      counterparty: { type: 'string', description: '客户或供应商名称', required: true },
      direction: { type: 'string', description: '"in"=进项(采购)发票, "out"=销项(销售)发票', required: true },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const name = (args.counterparty as string)?.trim()
      const direction = (args.direction as string)?.trim()
      if (!name) return 'Error: counterparty 参数必填'
      if (direction !== 'in' && direction !== 'out') return 'Error: direction 必须为 "in" 或 "out"'

      const result = resolveCounterparty(bizCtx, name)
      if (typeof result === 'string') return result

      const data = getUninvoicedAmount(bizCtx, result.id, direction)
      const label = direction === 'in' ? '进项' : '销项'
      return `${result.name} ${label}发票情况:\n业务总额 ¥${fmt(data.totalAmount)} | 已开票 ¥${fmt(data.invoicedAmount)} | 未开票 ¥${fmt(data.uninvoicedAmount)}`
    },
  }
}

function createBizSilenceAlertsTool(): ToolDefinition {
  return {
    name: 'biz_silence_alerts',
    description: '查看沉默预警：哪些供应商/客户超出正常交易节奏，可能需要跟进',
    parameters: {
      name: { type: 'string', description: '交易对手名称关键词，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      let items = getSilenceAlerts(bizCtx)
      if (args.name) {
        const q = (args.name as string).toLowerCase()
        items = items.filter(i => i.name.toLowerCase().includes(q))
      }
      if (items.length === 0) return '所有交易对手活跃正常，暂无沉默预警'
      const rows = items.map(i => [
        i.name,
        i.type === 'supplier' ? '供应商' : i.type === 'customer' ? '客户' : '物流',
        i.lastDate,
        `${i.silentDays}天`,
        `${Math.round(i.avgIntervalDays)}天`,
        `${i.transactionCount}次`,
      ])
      return `## 沉默预警（${items.length} 个交易对手）\n\n` +
        mdTable(['名称', '类型', '最后交易', '沉默天数', '平均间隔', '历史交易'], rows)
    },
  }
}

function createBizExposureTool(): ToolDefinition {
  return {
    name: 'biz_exposure',
    description: '查看财务敞口：每个交易对手的应收、应付、净敞口，以及合作时长（林迪天数）',
    parameters: {
      name: { type: 'string', description: '交易对手名称关键词，可选' },
      min_amount: { type: 'number', description: '最低净敞口金额（¥），可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      const data = getExposure(bizCtx)
      let items = data.items
      if (args.name) {
        const q = (args.name as string).toLowerCase()
        items = items.filter(i => i.name.toLowerCase().includes(q))
      }
      if (args.min_amount) {
        const min = Number(args.min_amount)
        items = items.filter(i => Math.abs(i.netExposure) >= min)
      }
      if (items.length === 0) return '暂无敞口数据'
      const rows = items.map(i => [
        i.name,
        i.type === 'supplier' ? '供应商' : i.type === 'customer' ? '客户' : i.type,
        `¥${fmt(i.receivable)}`,
        `¥${fmt(i.payable)}`,
        `¥${fmt(i.netExposure)}`,
        i.lindyDays != null ? `${i.lindyDays}天` : '-',
      ])
      const summary = `净敞口合计 ¥${fmt(data.netExposure)}（应收 ¥${fmt(data.totalReceivable)} - 应付 ¥${fmt(data.totalPayable)}）`
      return `## 财务敞口\n${summary}\n\n` +
        mdTable(['名称', '类型', '应收', '应付', '净敞口', '合作时长'], rows)
    },
  }
}

function createBizRelationshipsTool(): ToolDefinition {
  return {
    name: 'biz_relationships',
    description: '查看交易对手关系概览：合作时长（林迪天数）、类型、首次交易日期',
    parameters: {
      name: { type: 'string', description: '交易对手名称关键词，可选' },
      type: { type: 'string', description: '类型筛选: supplier/customer/logistics，可选' },
    },
    async execute(args, ctx) {
      const bizCtx = toBizCtx(ctx)
      let items = getCounterparties(bizCtx, args.type as string | undefined)
      if (args.name) {
        const q = (args.name as string).toLowerCase()
        items = items.filter(i => i.name.toLowerCase().includes(q))
      }
      if (items.length === 0) return '暂无交易对手数据'
      const withLindy = items.map(i => ({
        ...i,
        lindyDays: computeLindyDays(i.firstInteraction),
      })).sort((a, b) => (b.lindyDays ?? 0) - (a.lindyDays ?? 0))

      const rows = withLindy.map(i => {
        const typeLabel = i.type === 'supplier' ? '供应商' : i.type === 'customer' ? '客户' : i.type === 'logistics' ? '物流' : '供应商/客户'
        return [
          i.name,
          typeLabel,
          i.firstInteraction ?? '-',
          i.lindyDays != null ? `${i.lindyDays}天` : '-',
        ]
      })
      return `## 交易对手关系（${withLindy.length} 个）\n\n` +
        mdTable(['名称', '类型', '首次交易', '合作时长'], rows)
    },
  }
}

function createBizConcentrationTool(): ToolDefinition {
  return {
    name: 'biz_concentration',
    description: '查看供应商/客户集中度：前N大交易对手占总额的百分比，评估业务集中风险',
    parameters: {
      top_n: { type: 'number', description: 'Top N 名次（默认3）' },
      threshold: { type: 'number', description: '预警阈值百分比（默认60）' },
      date_from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
      date_to: { type: 'string', description: '截止日期 YYYY-MM-DD' },
    },
    execute: async (args, ctx) => {
      const bizCtx = toBizCtx(ctx)
      const metrics = getConcentrationMetrics(bizCtx, {
        topN: args.top_n as number | undefined,
        threshold: args.threshold as number | undefined,
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
      })

      const formatSide = (label: string, side: typeof metrics.supplierConcentration) => {
        if (side.totalAmount === 0) return `### ${label}\n暂无数据`
        const warning = side.warning ? ' **[预警]**' : ''
        const header = `### ${label}${warning}\n前${side.topN}大占比：${side.topNShare}%（阈值${metrics.threshold}%）\n总额：¥${fmt(side.totalAmount)}\n`
        const rows = side.topItems.map((i, idx) => [
          String(idx + 1), i.name, fmt(i.amount), `${i.share}%`,
        ])
        return header + mdTable(['排名', '名称', '金额', '占比'], rows)
      }

      return `## 集中度分析\n\n${formatSide('供应商集中度（采购）', metrics.supplierConcentration)}\n\n${formatSide('客户集中度（销售）', metrics.customerConcentration)}`
    },
  }
}

// ── Export ────────────────────────────────────────────────────────────

function createBizExcelLookupTool(): ToolDefinition {
  return {
    name: 'biz_excel_lookup',
    description: '搜索原始Excel导入数据（知识卡片），用于与数据库汇总进行交叉验证',
    parameters: {
      query: { type: 'string', description: '搜索关键词（如供应商名、项目名、月份等）', required: true },
    },
    async execute(args, ctx) {
      const query = (args.query as string)?.trim()
      if (!query) return 'Error: query 参数必填'

      const spaceIds = ctx?.activeSpaceId ? [ctx.activeSpaceId] : ctx?.spaceIds
      const hits = searchBubbles(query, 10, spaceIds)
      const excelHits = hits.filter(b => b.tags?.includes('excel-summary') || b.source === 'excel-import')

      if (excelHits.length === 0) {
        const general = hits.slice(0, 5)
        if (general.length === 0) return `没有找到与"${query}"相关的Excel数据`
        const lines = general.map(b => `**${b.title}** (${b.source})\n${b.content.slice(0, 300)}`)
        return `未找到Excel原始数据，但发现相关记录：\n\n${lines.join('\n\n---\n\n')}`
      }

      const lines = excelHits.slice(0, 5).map(b => {
        const content = b.content.length > 500 ? b.content.slice(0, 500) + '...' : b.content
        return `**${b.title}**\n${content}`
      })
      return `## Excel原始数据（${excelHits.length} 条匹配）\n\n${lines.join('\n\n---\n\n')}`
    },
  }
}

export function createBizQueryTools(): ToolDefinition[] {
  return [
    createBizDashboardTool(),
    createBizInventoryTool(),
    createBizReceivablesTool(),
    createBizPayablesTool(),
    createBizProfitReportTool(),
    createBizProfitByOrderTool(),
    createBizCounterpartyStatementTool(),
    createBizMonthlyOverviewTool(),
    createBizProjectReconciliationTool(),
    createBizUninvoicedTool(),
    createBizExcelLookupTool(),
    createBizSilenceAlertsTool(),
    createBizExposureTool(),
    createBizRelationshipsTool(),
    createBizConcentrationTool(),
  ]
}
