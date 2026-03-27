/**
 * Business reporting engine (v0.6 SaaS).
 * Aggregated queries for profit, counterparty statement, and monthly overview.
 */

import { getDatabase } from '../../storage/database.js'

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

// ── Profit Report ───────────────────────────────────────────────────

export function getProfitReport(dateFrom?: string, dateTo?: string): ProfitReportRow[] {
  const db = getDatabase()
  const conditions: string[] = [`tenant_id = ?`, `deleted_at IS NULL`, ACTIVE_STATUS]
  const baseParams: unknown[] = [TENANT]

  if (dateFrom) { conditions.push('date >= ?'); baseParams.push(dateFrom) }
  if (dateTo) { conditions.push('date <= ?'); baseParams.push(dateTo) }

  const where = conditions.join(' AND ')

  // Sales revenue by month
  const salesRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_amount) as revenue,
           SUM(tonnage) as tons
    FROM biz_sales WHERE ${where}
    GROUP BY month ORDER BY month
  `).all(...baseParams) as Array<{ month: string; revenue: number; tons: number }>

  // Purchase cost by month
  const purchaseRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_amount) as cost,
           SUM(tonnage) as tons
    FROM biz_purchases WHERE ${where}
    GROUP BY month ORDER BY month
  `).all(...baseParams) as Array<{ month: string; cost: number; tons: number }>

  // Logistics cost by month
  const logisticsRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month,
           SUM(total_fee) as cost
    FROM biz_logistics WHERE ${where}
    GROUP BY month ORDER BY month
  `).all(...baseParams) as Array<{ month: string; cost: number }>

  // Merge into unified months
  const months = new Map<string, ProfitReportRow>()

  for (const r of salesRows) {
    const row = getOrCreate(months, r.month)
    row.salesRevenue = r.revenue
    row.salesTons = r.tons
  }
  for (const r of purchaseRows) {
    const row = getOrCreate(months, r.month)
    row.purchaseCost = r.cost
    row.purchaseTons = r.tons
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
  counterpartyId: string,
  dateFrom?: string,
  dateTo?: string,
): CounterpartyStatementResult {
  const db = getDatabase()

  // Get counterparty info
  const cp = db.prepare('SELECT id, name, type FROM biz_counterparties WHERE id = ? AND tenant_id = ?')
    .get(counterpartyId, TENANT) as { id: string; name: string; type: string } | undefined
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
    WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.${ACTIVE_STATUS}
      AND p.supplier_id = ?${qualifiedDateSql('p')}
    ORDER BY p.date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...purchases)

  // Sales to this customer
  const sales = db.prepare(`
    SELECT s.date, 'sale' as type,
           COALESCE(p2.name, '') || ' ' || COALESCE(p2.spec, '') || ' x' || s.tonnage || ' @' || s.unit_price as description,
           s.total_amount as amount, s.id as doc_id
    FROM biz_sales s
    LEFT JOIN biz_products p2 ON p2.id = s.product_id
    WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.${ACTIVE_STATUS}
      AND s.customer_id = ?${qualifiedDateSql('s')}
    ORDER BY s.date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...sales)

  // Payments in from this counterparty
  const paymentsIn = db.prepare(`
    SELECT date, 'payment_in' as type,
           COALESCE(method, '收款') as description,
           amount, id as doc_id
    FROM biz_payments
    WHERE tenant_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'in'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...paymentsIn)

  // Payments out to this counterparty
  const paymentsOut = db.prepare(`
    SELECT date, 'payment_out' as type,
           COALESCE(method, '付款') as description,
           amount, id as doc_id
    FROM biz_payments
    WHERE tenant_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'out'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...paymentsOut)

  // Invoices in from this counterparty
  const invoicesIn = db.prepare(`
    SELECT date, 'invoice_in' as type,
           COALESCE(invoice_no, '进项发票') as description,
           amount, id as doc_id
    FROM biz_invoices
    WHERE tenant_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'in'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
  rawRows.push(...invoicesIn)

  // Invoices out to this counterparty
  const invoicesOut = db.prepare(`
    SELECT date, 'invoice_out' as type,
           COALESCE(invoice_no, '销项发票') as description,
           amount, id as doc_id
    FROM biz_invoices
    WHERE tenant_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      AND counterparty_id = ? AND direction = 'out'${qualifiedDateSql()}
    ORDER BY date
  `).all(TENANT, counterpartyId, ...dateParams) as RawRow[]
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

export function getMonthlyOverview(year?: number): MonthlyOverviewRow[] {
  const db = getDatabase()
  const targetYear = year ?? new Date().getFullYear()
  const yearStr = String(targetYear)

  const base = `tenant_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND date LIKE ?`
  const yearPattern = `${yearStr}-%`

  // Purchases by month
  const purchaseRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_amount) as amount, SUM(tonnage) as tons
    FROM biz_purchases WHERE ${base} GROUP BY month
  `).all(TENANT, yearPattern) as Array<{ month: string; amount: number; tons: number }>

  // Sales by month
  const salesRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_amount) as amount, SUM(tonnage) as tons
    FROM biz_sales WHERE ${base} GROUP BY month
  `).all(TENANT, yearPattern) as Array<{ month: string; amount: number; tons: number }>

  // Logistics by month
  const logisticsRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, SUM(total_fee) as amount
    FROM biz_logistics WHERE ${base} GROUP BY month
  `).all(TENANT, yearPattern) as Array<{ month: string; amount: number }>

  // Payments by month and direction
  const paymentRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, direction, SUM(amount) as amount
    FROM biz_payments WHERE ${base} GROUP BY month, direction
  `).all(TENANT, yearPattern) as Array<{ month: string; direction: string; amount: number }>

  // Invoices by month and direction
  const invoiceRows = db.prepare(`
    SELECT strftime('%Y-%m', date) as month, direction, SUM(amount) as amount
    FROM biz_invoices WHERE ${base} GROUP BY month, direction
  `).all(TENANT, yearPattern) as Array<{ month: string; direction: string; amount: number }>

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
