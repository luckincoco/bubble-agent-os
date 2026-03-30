/**
 * Business reporting engine (v0.6 SaaS).
 * Aggregated queries for profit, counterparty statement, and monthly overview.
 */

import { getDatabase } from '../../storage/database.js'
import type { BizContext } from './structured-store.js'

const TENANT = 'default'
const ACTIVE_STATUS = "doc_status IN ('confirmed','completed')"

// ── Types ───────────────────────────────────────────────────────────

export interface ProfitReportRow {
  month: string          // YYYY-MM
  salesRevenue: number
  purchaseCost: number
  logisticsCost: number
  grossProfit: number
  margin: number         // percentage 0–100
  salesTons: number
  purchaseTons: number
}

export interface CounterpartyStatementRow {
  date: string
  type: 'purchase' | 'sale' | 'payment_in' | 'payment_out' | 'invoice_in' | 'invoice_out'
  description: string
  debit: number          // amounts owed to us (sale) or we paid (payment_out)
  credit: number         // amounts we owe (purchase) or received (payment_in)
  balance: number        // running balance (positive = they owe us)
  docId: string
}

export interface CounterpartyStatementResult {
  counterpartyId: string
  counterpartyName: string
  counterpartyType: string
  rows: CounterpartyStatementRow[]
  totalDebit: number
  totalCredit: number
  closingBalance: number
}

export interface MonthlyOverviewRow {
  month: string          // YYYY-MM
  purchaseAmount: number
  purchaseTons: number
  salesAmount: number
  salesTons: number
  logisticsAmount: number
  paymentsIn: number
  paymentsOut: number
  invoicesIn: number
  invoicesOut: number
}

/** v0.7: 按单号(doc_no)维度的利润分析行 */
export interface ProfitByOrderRow {
  docNo: string
  date: string
  supplierName: string
  customerName: string
  purchaseAmount: number
  purchaseTons: number
  salesAmount: number
  salesTons: number
  logisticsCost: number
  grossProfit: number
  margin: number         // percentage 0–100
}

/** v0.7: 利润报表筛选参数 */
export interface ProfitReportFilter {
  dateFrom?: string
  dateTo?: string
  customerId?: string
  supplierId?: string
}

// ── Profit Report ───────────────────────────────────────────────────

export function getProfitReport(ctx: BizContext, filter: ProfitReportFilter = {}): ProfitReportRow[] {
  const { dateFrom, dateTo, customerId, supplierId } = filter
  const db = getDatabase()

  const baseCond: string[] = [`tenant_id = ?`, `space_id = ?`, `deleted_at IS NULL`, ACTIVE_STATUS]
  const baseParams: unknown[] = [TENANT, ctx.spaceId]

  if (dateFrom) { baseCond.push('date >= ?'); baseParams.push(dateFrom) }
  if (dateTo) { baseCond.push('date <= ?'); baseParams.push(dateTo) }

  // Sales: optionally filter by customer
  const salesCond = [...baseCond]
  const salesParams = [...baseParams]
  if (customerId) { salesCond.push('customer_id = ?'); salesParams.push(customerId) }
  if (supplierId) { salesCond.push('supplier_id = ?'); salesParams.push(supplierId) }
  const salesWhere = salesCond.join(' AND ')

  // Purchases: optionally filter by supplier
  const purchaseCond = [...baseCond]
  const purchaseParams = [...baseParams]
  if (supplierId) { purchaseCond.push('supplier_id = ?'); purchaseParams.push(supplierId) }
  const purchaseWhere = purchaseCond.join(' AND ')

  // Logistics: filter by supplier if specified (carrier is effectively supplier)
  const logisticsCond = [...baseCond]
  const logisticsParams = [...baseParams]
  if (supplierId) { logisticsCond.push('carrier_id = ?'); logisticsParams.push(supplierId) }
  const logisticsWhere = logisticsCond.join(' AND ')

  // Sales revenue by month (+ cost data when customer is specified)
  const salesRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_amount) as revenue,
           SUM(tonnage) as tons,
           SUM(COALESCE(cost_amount, cost_price * tonnage, 0)) as cost_from_sales
    FROM biz_sales WHERE ${salesWhere}
    GROUP BY month ORDER BY month
  `).all(...salesParams) as Array<{ month: string; revenue: number; tons: number; cost_from_sales: number }>

  // Purchase cost by month (only used when no customer filter)
  const purchaseRows = !customerId ? db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_amount) as cost,
           SUM(tonnage) as tons
    FROM biz_purchases WHERE ${purchaseWhere}
    GROUP BY month ORDER BY month
  `).all(...purchaseParams) as Array<{ month: string; cost: number; tons: number }> : []

  // Logistics cost by month
  // When customer is specified, join via doc_no to only include logistics for that customer's sales
  const logisticsRows = customerId ? (() => {
    const lCond: string[] = [
      `l.tenant_id = ?`, `l.space_id = ?`, `l.deleted_at IS NULL`, `l.${ACTIVE_STATUS}`,
      `l.doc_no IS NOT NULL`, `l.doc_no != ''`,
    ]
    const lParams: unknown[] = [TENANT, ctx.spaceId]
    if (dateFrom) { lCond.push('l.date >= ?'); lParams.push(dateFrom) }
    if (dateTo) { lCond.push('l.date <= ?'); lParams.push(dateTo) }
    // Only include logistics whose doc_no appears in the filtered sales
    const salesDocCond = [...baseCond]
    const salesDocParams = [...baseParams]
    salesDocCond.push('customer_id = ?'); salesDocParams.push(customerId)
    if (supplierId) { salesDocCond.push('supplier_id = ?'); salesDocParams.push(supplierId) }
    lCond.push(`l.doc_no IN (SELECT doc_no FROM biz_sales WHERE ${salesDocCond.join(' AND ')} AND doc_no IS NOT NULL AND doc_no != '')`)
    lParams.push(...salesDocParams)
    return db.prepare(`
      SELECT strftime('%Y-%m', l.date) as month, SUM(l.total_fee) as cost
      FROM biz_logistics l WHERE ${lCond.join(' AND ')}
      GROUP BY month ORDER BY month
    `).all(...lParams) as Array<{ month: string; cost: number }>
  })() : db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_fee) as cost
    FROM biz_logistics WHERE ${logisticsWhere}
    GROUP BY month ORDER BY month
  `).all(...logisticsParams) as Array<{ month: string; cost: number }>

  // Merge into unified months
  const months = new Map<string, ProfitReportRow>()

  for (const r of salesRows) {
    const row = getOrCreate(months, r.month)
    row.salesRevenue = r.revenue
    row.salesTons = r.tons
    // When customer is specified, use sales' own cost data (precise per-sale cost)
    if (customerId) {
      row.purchaseCost = r.cost_from_sales
      row.purchaseTons = r.tons
    }
  }
  if (!customerId) {
    for (const r of purchaseRows) {
      const row = getOrCreate(months, r.month)
      row.purchaseCost = r.cost
      row.purchaseTons = r.tons
    }
  }
  for (const r of logisticsRows) {
    const row = getOrCreate(months, r.month)
    row.logisticsCost = r.cost
  }

  // Calculate gross profit and margin
  const result = [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
  for (const row of result) {
    row.grossProfit = row.salesRevenue - row.purchaseCost - row.logisticsCost
    row.margin = row.salesRevenue > 0
      ? Math.round(row.grossProfit / row.salesRevenue * 10000) / 100
      : 0
  }

  return result
}

function getOrCreate(map: Map<string, ProfitReportRow>, month: string): ProfitReportRow {
  let row = map.get(month)
  if (!row) {
    row = { month, salesRevenue: 0, purchaseCost: 0, logisticsCost: 0, grossProfit: 0, margin: 0, salesTons: 0, purchaseTons: 0 }
    map.set(month, row)
  }
  return row
}

// ── Counterparty Statement (往来对账单) ──────────────────────────────

export function getCounterpartyStatement(
  ctx: BizContext,
  counterpartyId: string,
  dateFrom?: string,
  dateTo?: string,
): CounterpartyStatementResult {
  const db = getDatabase()

  // Get counterparty info
  const cp = db.prepare('SELECT id, name, type FROM biz_counterparties WHERE id = ? AND tenant_id = ? AND space_id = ?')
    .get(counterpartyId, TENANT, ctx.spaceId) as { id: string; name: string; type: string } | undefined
  if (!cp) throw new Error('往来对象不存在')

  const dateConditions: string[] = []
  const dateParams: unknown[] = []
  if (dateFrom) { dateConditions.push('date >= ?'); dateParams.push(dateFrom) }
  if (dateTo) { dateConditions.push('date <= ?'); dateParams.push(dateTo) }
  /** Build qualified date filter: e.g. " AND p.date >= ? AND p.date <= ?" */
  function qualifiedDateSql(alias?: string): string {
    if (dateConditions.length === 0) return ''
    const prefix = alias ? `${alias}.` : ''
    const parts: string[] = []
    if (dateFrom) parts.push(`${prefix}date >= ?`)
    if (dateTo) parts.push(`${prefix}date <= ?`)
    return ' AND ' + parts.join(' AND ')
  }

  type RawRow = { date: string; type: string; description: string; amount: number; doc_id: string }
  const rawRows: RawRow[] = []

  // Purchases from this supplier
  const purchases = db.prepare(`
    SELECT p.date, 'purchase' as type,
           COALESCE(p2.name, '') || ' ' || COALESCE(p2.spec, '') || ' x' || p.tonnage || ' @' || p.unit_price as description,
           p.total_amount as amount, p.id as doc_id
    FROM biz_purchases p
    LEFT JOIN biz_products p2 ON p2.id = p.product_id
    WHERE p.tenant_id = ? AND p.space_id = ? AND p.deleted_at IS NULL AND p.${ACTIVE_STATUS}
      AND p.supplier_id = ?${qualifiedDateSql('p')}
    ORDER BY p.date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...purchases)

  // Sales to this customer
  const sales = db.prepare(`
    SELECT s.date, 'sale' as type,
           COALESCE(p2.name, '') || ' ' || COALESCE(p2.spec, '') || ' x' || s.tonnage || ' @' || s.unit_price as description,
           s.total_amount as amount, s.id as doc_id
    FROM biz_sales s
    LEFT JOIN biz_products p2 ON p2.id = s.product_id
    WHERE s.tenant_id = ? AND s.space_id = ? AND s.deleted_at IS NULL AND s.${ACTIVE_STATUS}
      AND s.customer_id = ?${qualifiedDateSql('s')}
    ORDER BY s.date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...sales)

  // Payments in from this counterparty
  const paymentsIn = db.prepare(`
    SELECT date, 'payment_in' as type,
           COALESCE(method, '收款') as description,
           amount, id as doc_id
    FROM biz_payments
    WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'in'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...paymentsIn)

  // Payments out to this counterparty
  const paymentsOut = db.prepare(`
    SELECT date, 'payment_out' as type,
           COALESCE(method, '付款') as description,
           amount, id as doc_id
    FROM biz_payments
    WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'out'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...paymentsOut)

  // Invoices in from this counterparty
  const invoicesIn = db.prepare(`
    SELECT date, 'invoice_in' as type,
           COALESCE(invoice_no, '进项发票') as description,
           amount, id as doc_id
    FROM biz_invoices
    WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'in'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...invoicesIn)

  // Invoices out to this counterparty
  const invoicesOut = db.prepare(`
    SELECT date, 'invoice_out' as type,
           COALESCE(invoice_no, '销项发票') as description,
           amount, id as doc_id
    FROM biz_invoices
    WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'out'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, ctx.spaceId, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...invoicesOut)

  // Sort by date
  rawRows.sort((a, b) => a.date.localeCompare(b.date))

  // Build statement with running balance
  let balance = 0
  let totalDebit = 0
  let totalCredit = 0
  const rows: CounterpartyStatementRow[] = rawRows.map(r => {
    let debit = 0
    let credit = 0

    switch (r.type) {
      case 'sale':
        // They owe us (debit)
        debit = r.amount
        break
      case 'purchase':
        // We owe them (credit)
        credit = r.amount
        break
      case 'payment_in':
        // They paid us (credit against their debt)
        credit = r.amount
        break
      case 'payment_out':
        // We paid them (debit against our debt)
        debit = r.amount
        break
      case 'invoice_out':
        // Outgoing invoice — confirms they owe us (informational, no balance impact beyond sale)
        break
      case 'invoice_in':
        // Incoming invoice — confirms we owe them (informational, no balance impact beyond purchase)
        break
    }

    balance += debit - credit
    totalDebit += debit
    totalCredit += credit

    return {
      date: r.date,
      type: r.type as CounterpartyStatementRow['type'],
      description: r.description,
      debit,
      credit,
      balance,
      docId: r.doc_id,
    }
  })

  return {
    counterpartyId: cp.id,
    counterpartyName: cp.name,
    counterpartyType: cp.type,
    rows,
    totalDebit,
    totalCredit,
    closingBalance: balance,
  }
}

// ── Monthly Overview (月度总览) ─────────────────────────────────────

export function getMonthlyOverview(ctx: BizContext, year?: number): MonthlyOverviewRow[] {
  const db = getDatabase()
  const targetYear = year ?? new Date().getFullYear()
  const yearStr = String(targetYear)

  const base = `tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND date LIKE ?`
  const yearPattern = `${yearStr}-%`

  // Purchases by month
  const purchaseRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_amount) as amount, SUM(tonnage) as tons
    FROM biz_purchases WHERE ${base} GROUP BY month
  `).all(TENANT, ctx.spaceId, yearPattern) as Array<{ month: string; amount: number; tons: number }>

  // Sales by month
  const salesRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_amount) as amount, SUM(tonnage) as tons
    FROM biz_sales WHERE ${base} GROUP BY month
  `).all(TENANT, ctx.spaceId, yearPattern) as Array<{ month: string; amount: number; tons: number }>

  // Logistics by month
  const logisticsRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_fee) as amount
    FROM biz_logistics WHERE ${base} GROUP BY month
  `).all(TENANT, ctx.spaceId, yearPattern) as Array<{ month: string; amount: number }>

  // Payments by month and direction
  const paymentRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, direction, SUM(amount) as amount
    FROM biz_payments WHERE ${base} GROUP BY month, direction
  `).all(TENANT, ctx.spaceId, yearPattern) as Array<{ month: string; direction: string; amount: number }>

  // Invoices by month and direction
  const invoiceRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, direction, SUM(amount) as amount
    FROM biz_invoices WHERE ${base} GROUP BY month, direction
  `).all(TENANT, ctx.spaceId, yearPattern) as Array<{ month: string; direction: string; amount: number }>

  // Merge into 12-month grid
  const months = new Map<string, MonthlyOverviewRow>()
  for (let m = 1; m <= 12; m++) {
    const key = `${yearStr}-${String(m).padStart(2, '0')}`
    months.set(key, {
      month: key, purchaseAmount: 0, purchaseTons: 0, salesAmount: 0, salesTons: 0,
      logisticsAmount: 0, paymentsIn: 0, paymentsOut: 0, invoicesIn: 0, invoicesOut: 0,
    })
  }

  for (const r of purchaseRows) { const row = months.get(r.month); if (row) { row.purchaseAmount = r.amount; row.purchaseTons = r.tons } }
  for (const r of salesRows) { const row = months.get(r.month); if (row) { row.salesAmount = r.amount; row.salesTons = r.tons } }
  for (const r of logisticsRows) { const row = months.get(r.month); if (row) { row.logisticsAmount = r.amount } }
  for (const r of paymentRows) {
    const row = months.get(r.month)
    if (row) { r.direction === 'in' ? row.paymentsIn = r.amount : row.paymentsOut = r.amount }
  }
  for (const r of invoiceRows) {
    const row = months.get(r.month)
    if (row) { r.direction === 'in' ? row.invoicesIn = r.amount : row.invoicesOut = r.amount }
  }

  return [...months.values()]
}

// ── Profit by Order (按单号利润分析) v0.7 ────────────────────────────

export function getProfitByOrder(ctx: BizContext, filter: ProfitReportFilter = {}): ProfitByOrderRow[] {
  const { dateFrom, dateTo, customerId, supplierId } = filter
  const db = getDatabase()

  // Build purchase query with optional supplier filter
  const pCond: string[] = [`p.tenant_id = ?`, `p.space_id = ?`, `p.deleted_at IS NULL`, `p.${ACTIVE_STATUS}`, `p.doc_no IS NOT NULL`, `p.doc_no != ''`]
  const pParams: unknown[] = [TENANT, ctx.spaceId]
  if (dateFrom) { pCond.push('p.date >= ?'); pParams.push(dateFrom) }
  if (dateTo) { pCond.push('p.date <= ?'); pParams.push(dateTo) }
  if (supplierId) { pCond.push('p.supplier_id = ?'); pParams.push(supplierId) }

  // Build sales query with optional customer filter
  const sCond: string[] = [`s.tenant_id = ?`, `s.space_id = ?`, `s.deleted_at IS NULL`, `s.${ACTIVE_STATUS}`, `s.doc_no IS NOT NULL`, `s.doc_no != ''`]
  const sParams: unknown[] = [TENANT, ctx.spaceId]
  if (dateFrom) { sCond.push('s.date >= ?'); sParams.push(dateFrom) }
  if (dateTo) { sCond.push('s.date <= ?'); sParams.push(dateTo) }
  if (customerId) { sCond.push('s.customer_id = ?'); sParams.push(customerId) }
  if (supplierId) { sCond.push('s.supplier_id = ?'); sParams.push(supplierId) }
  const sWhere = sCond.join(' AND ')

  // When no customer filter, use purchase table directly
  const purchasesByDoc = !customerId ? db.prepare(`
    SELECT p.doc_no,
           MIN(p.date) as date,
           COALESCE(c.name, '') as supplier_name,
           SUM(p.total_amount) as purchase_amount,
           SUM(p.tonnage) as purchase_tons
    FROM biz_purchases p
    LEFT JOIN biz_counterparties c ON c.id = p.supplier_id
    WHERE ${pCond.join(' AND ')}
    GROUP BY p.doc_no
    ORDER BY date
  `).all(...pParams) as Array<{
    doc_no: string; date: string; supplier_name: string
    purchase_amount: number; purchase_tons: number
  }> : []

  // Sales by doc_no (include cost data for customer-filtered queries)
  const salesByDoc = db.prepare(`
    SELECT s.doc_no,
           COALESCE(c.name, '') as customer_name,
           COALESCE(sup.name, '') as supplier_name,
           SUM(s.total_amount) as sales_amount,
           SUM(s.tonnage) as sales_tons,
           SUM(COALESCE(s.cost_amount, s.cost_price * s.tonnage, 0)) as cost_from_sales,
           MIN(s.date) as date
    FROM biz_sales s
    LEFT JOIN biz_counterparties c ON c.id = s.customer_id
    LEFT JOIN biz_counterparties sup ON sup.id = s.supplier_id
    WHERE ${sWhere}
    GROUP BY s.doc_no
  `).all(...sParams) as Array<{
    doc_no: string; customer_name: string; supplier_name: string
    sales_amount: number; sales_tons: number; cost_from_sales: number; date: string
  }>

  // Logistics cost by doc_no
  const lCond: string[] = [`l.tenant_id = ?`, `l.space_id = ?`, `l.deleted_at IS NULL`, `l.${ACTIVE_STATUS}`, `l.doc_no IS NOT NULL`, `l.doc_no != ''`]
  const lParams: unknown[] = [TENANT, ctx.spaceId]
  if (dateFrom) { lCond.push('l.date >= ?'); lParams.push(dateFrom) }
  if (dateTo) { lCond.push('l.date <= ?'); lParams.push(dateTo) }

  const logisticsByDoc = db.prepare(`
    SELECT l.doc_no, SUM(l.total_fee) as cost
    FROM biz_logistics l
    WHERE ${lCond.join(' AND ')}
    GROUP BY l.doc_no
  `).all(...lParams) as Array<{ doc_no: string; cost: number }>

  // Merge all dimensions by doc_no
  const map = new Map<string, ProfitByOrderRow>()

  if (!customerId) {
    // No customer filter: use purchase table as primary source
    for (const p of purchasesByDoc) {
      map.set(p.doc_no, {
        docNo: p.doc_no,
        date: p.date,
        supplierName: p.supplier_name,
        customerName: '',
        purchaseAmount: p.purchase_amount,
        purchaseTons: p.purchase_tons,
        salesAmount: 0,
        salesTons: 0,
        logisticsCost: 0,
        grossProfit: 0,
        margin: 0,
      })
    }
  }

  for (const s of salesByDoc) {
    const row = map.get(s.doc_no)
    if (row) {
      row.customerName = s.customer_name
      row.salesAmount = s.sales_amount
      row.salesTons = s.sales_tons
      if (customerId) {
        row.purchaseAmount = s.cost_from_sales
        row.purchaseTons = s.sales_tons
        row.supplierName = s.supplier_name
      }
    } else {
      map.set(s.doc_no, {
        docNo: s.doc_no,
        date: s.date || '',
        supplierName: s.supplier_name || '',
        customerName: s.customer_name,
        purchaseAmount: customerId ? s.cost_from_sales : 0,
        purchaseTons: customerId ? s.sales_tons : 0,
        salesAmount: s.sales_amount,
        salesTons: s.sales_tons,
        logisticsCost: 0,
        grossProfit: 0,
        margin: 0,
      })
    }
  }

  for (const l of logisticsByDoc) {
    const row = map.get(l.doc_no)
    if (row) {
      row.logisticsCost = l.cost
    }
  }

  // Calculate profit and margin for each order
  const result = [...map.values()].sort((a, b) => a.date.localeCompare(b.date))
  for (const row of result) {
    row.grossProfit = row.salesAmount - row.purchaseAmount - row.logisticsCost
    row.margin = row.salesAmount > 0
      ? Math.round(row.grossProfit / row.salesAmount * 10000) / 100
      : 0
  }

  return result
}
