import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  getProfitReport,
  getCounterpartyStatement,
  getMonthlyOverview,
  getProfitByOrder,
} from '../src/connector/biz/reports.js'
import type { BizContext } from '../src/connector/biz/structured-store.js'

const TENANT = 'default'
const SPACE_ID = 'reports-test-space'
let tmpDir: string

function ctx(): BizContext {
  return { spaceId: SPACE_ID }
}

// ── Raw DB insert helpers ─────────────────────────────────────────────

function insertCounterparty(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, space_id, name, type, first_interaction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.name || `cp-${id}`,
    overrides.type || 'supplier',
    overrides.firstInteraction || '2024-01-01',
    Date.now(), Date.now(),
  )
}

function insertProduct(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_products (id, tenant_id, space_id, code, brand, name, spec, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.code || `PROD-${id}`,
    overrides.brand || '品牌A',
    overrides.name || `产品${id}`,
    overrides.spec || 'HRB400',
    Date.now(), Date.now(),
  )
}

function insertPurchase(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, space_id, date, doc_status, supplier_id, product_id, tonnage, unit_price, total_amount, doc_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.date || '2024-06-15',
    overrides.docStatus || 'confirmed',
    overrides.supplierId || 'cp-supplier',
    overrides.productId || 'prod-1',
    overrides.tonnage ?? 100,
    overrides.unitPrice ?? 3000,
    overrides.totalAmount ?? 300000,
    overrides.docNo || null,
    Date.now(), Date.now(),
  )
}

function insertSale(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, space_id, date, doc_status, customer_id, product_id, tonnage, unit_price, total_amount, doc_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.date || '2024-06-15',
    overrides.docStatus || 'confirmed',
    overrides.customerId || 'cp-customer',
    overrides.productId || 'prod-1',
    overrides.tonnage ?? 50,
    overrides.unitPrice ?? 4000,
    overrides.totalAmount ?? 200000,
    overrides.docNo || null,
    Date.now(), Date.now(),
  )
}

function insertLogistics(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, space_id, date, doc_status, carrier_id, total_fee, doc_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.date || '2024-06-15',
    overrides.docStatus || 'confirmed',
    overrides.carrierId || null,
    overrides.totalFee ?? 5000,
    overrides.docNo || null,
    Date.now(), Date.now(),
  )
}

function insertPayment(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, space_id, date, doc_status, counterparty_id, amount, direction, method, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.date || '2024-06-15',
    overrides.docStatus || 'confirmed',
    overrides.counterpartyId || 'cp-supplier',
    overrides.amount ?? 100000,
    overrides.direction || 'out',
    overrides.method || null,
    Date.now(), Date.now(),
  )
}

function insertInvoice(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_invoices (id, tenant_id, space_id, date, doc_status, counterparty_id, amount, direction, invoice_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, SPACE_ID,
    overrides.date || '2024-06-15',
    overrides.docStatus || 'confirmed',
    overrides.counterpartyId || 'cp-supplier',
    overrides.amount ?? 300000,
    overrides.direction || 'in',
    overrides.invoiceNo || null,
    Date.now(), Date.now(),
  )
}

function cleanTables(): void {
  const db = getDatabase()
  db.exec('DELETE FROM biz_doc_links')
  db.exec('DELETE FROM biz_purchase_lines')
  db.exec('DELETE FROM biz_sale_lines')
  db.exec('DELETE FROM biz_invoices')
  db.exec('DELETE FROM biz_payments')
  db.exec('DELETE FROM biz_logistics')
  db.exec('DELETE FROM biz_sales')
  db.exec('DELETE FROM biz_purchases')
  db.exec('DELETE FROM biz_products')
  db.exec('DELETE FROM biz_counterparties')
  db.exec('DELETE FROM biz_projects')
}

// ── Suite ─────────────────────────────────────────────────────────────

describe('reports', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reports-test-'))
    initDatabase(tmpDir, 'test-pass')
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    cleanTables()
    insertCounterparty('cp-supplier', { name: '供应商A', type: 'supplier' })
    insertCounterparty('cp-customer', { name: '客户B', type: 'customer' })
    insertCounterparty('cp-logistics', { name: '物流C', type: 'logistics' })
    insertProduct('prod-1', { name: '螺纹钢', spec: 'HRB400' })
  })

  // ── getProfitReport ──────────────────────────────────────────────

  describe('getProfitReport', () => {
    it('aggregates across months', () => {
      insertSale('sale-1', { date: '2024-06-01', totalAmount: 200000, tonnage: 50 })
      insertSale('sale-2', { date: '2024-07-01', totalAmount: 300000, tonnage: 75 })
      insertPurchase('pur-1', { date: '2024-06-01', totalAmount: 120000, tonnage: 80 })
      insertLogistics('log-1', { date: '2024-06-01', totalFee: 5000 })

      const result = getProfitReport(ctx())

      expect(result).toHaveLength(2)
      expect(result[0].month).toBe('2024-06')
      expect(result[0].salesRevenue).toBe(200000)
      expect(result[0].salesTons).toBe(50)
      expect(result[0].purchaseCost).toBe(120000)
      expect(result[0].purchaseTons).toBe(80)
      expect(result[0].logisticsCost).toBe(5000)
      expect(result[0].grossProfit).toBe(75000)  // 200000 - 120000 - 5000
      expect(result[0].margin).toBe(37.5)         // 75000/200000*100

      expect(result[1].month).toBe('2024-07')
      expect(result[1].salesRevenue).toBe(300000)
      expect(result[1].purchaseCost).toBe(0)
      expect(result[1].grossProfit).toBe(300000)
      expect(result[1].margin).toBe(100)
    })

    it('filters by supplier', () => {
      insertCounterparty('cp-supplier2', { name: '供应商D', type: 'supplier' })
      insertSale('sale-1', { date: '2024-06-01', totalAmount: 200000, tonnage: 50 })
      // Purchase from the filtered supplier
      insertPurchase('pur-1', { date: '2024-06-01', totalAmount: 120000, tonnage: 80, supplierId: 'cp-supplier' })
      // Purchase from different supplier (should be excluded)
      insertPurchase('pur-2', { date: '2024-06-01', totalAmount: 50000, tonnage: 30, supplierId: 'cp-supplier2' })

      const result = getProfitReport(ctx(), { supplierId: 'cp-supplier' })
      expect(result).toHaveLength(1)
      expect(result[0].purchaseCost).toBe(120000)
    })

    it('returns zero margin when no sales', () => {
      insertPurchase('pur-1', { date: '2024-06-01', totalAmount: 100000, tonnage: 50 })

      const result = getProfitReport(ctx())
      // Purchase-only month has salesRevenue=0, purchaseCost=100000
      // margin=0 because salesRevenue=0
      expect(result).toHaveLength(1)
      expect(result[0].salesRevenue).toBe(0)
      expect(result[0].purchaseCost).toBe(100000)
      expect(result[0].margin).toBe(0)
    })

    it('returns empty when no matching data', () => {
      const result = getProfitReport(ctx(), { dateFrom: '2025-01-01', dateTo: '2025-12-31' })
      expect(result).toHaveLength(0)
    })
  })

  // ── getCounterpartyStatement ─────────────────────────────────────

  describe('getCounterpartyStatement', () => {
    it('builds statement with purchases, payments, invoices', () => {
      insertPurchase('pur-1', { date: '2024-06-01', totalAmount: 300000, tonnage: 100, unitPrice: 3000, supplierId: 'cp-supplier' })
      insertPayment('pay-1', { date: '2024-06-15', amount: 100000, direction: 'out', counterpartyId: 'cp-supplier', method: '银行转账' })
      insertInvoice('inv-1', { date: '2024-06-20', amount: 300000, direction: 'in', counterpartyId: 'cp-supplier', invoiceNo: 'INV-001' })

      const result = getCounterpartyStatement(ctx(), 'cp-supplier')

      expect(result.counterpartyId).toBe('cp-supplier')
      expect(result.counterpartyName).toBe('供应商A')
      expect(result.rows).toHaveLength(3)

      // Purchase: credit (we owe them)
      expect(result.rows[0].type).toBe('purchase')
      expect(result.rows[0].credit).toBe(300000)
      expect(result.rows[0].debit).toBe(0)
      expect(result.rows[0].balance).toBe(-300000)

      // Payment out: debit (we paid)
      expect(result.rows[1].type).toBe('payment_out')
      expect(result.rows[1].debit).toBe(100000)
      expect(result.rows[1].balance).toBe(-200000)

      // Invoice in: informational, no balance impact
      expect(result.rows[2].type).toBe('invoice_in')
      expect(result.rows[2].debit).toBe(0)
      expect(result.rows[2].credit).toBe(0)
      expect(result.rows[2].balance).toBe(-200000)

      expect(result.totalDebit).toBe(100000)
      expect(result.totalCredit).toBe(300000)
      expect(result.closingBalance).toBe(-200000)
    })

    it('throws for unknown counterparty', () => {
      expect(() => getCounterpartyStatement(ctx(), 'nonexistent')).toThrow('往来对象不存在')
    })

    it('filters by date range', () => {
      insertPurchase('pur-1', { date: '2024-06-01', totalAmount: 300000, tonnage: 100, unitPrice: 3000, supplierId: 'cp-supplier' })
      insertPayment('pay-1', { date: '2024-07-01', amount: 100000, direction: 'out', counterpartyId: 'cp-supplier' })

      const result = getCounterpartyStatement(ctx(), 'cp-supplier', '2024-06-01', '2024-06-30')
      expect(result.rows).toHaveLength(1) // only purchase, payment excluded
      expect(result.rows[0].type).toBe('purchase')
    })
  })

  // ── getMonthlyOverview ───────────────────────────────────────────

  describe('getMonthlyOverview', () => {
    it('returns 12-month grid with data in populated months', () => {
      insertPurchase('pur-1', { date: '2024-06-15', totalAmount: 300000, tonnage: 100 })
      insertSale('sale-1', { date: '2024-06-15', totalAmount: 200000, tonnage: 50 })
      insertLogistics('log-1', { date: '2024-06-15', totalFee: 5000 })
      insertPayment('pay-1', { date: '2024-06-15', amount: 100000, direction: 'out', counterpartyId: 'cp-supplier' })
      insertInvoice('inv-1', { date: '2024-06-15', amount: 300000, direction: 'in', counterpartyId: 'cp-supplier' })

      const result = getMonthlyOverview(ctx(), 2024)

      expect(result).toHaveLength(12)
      // First month: January 2024
      expect(result[0].month).toBe('2024-01')
      expect(result[0].purchaseAmount).toBe(0)

      // June (index 5)
      const june = result[5]
      expect(june.month).toBe('2024-06')
      expect(june.purchaseAmount).toBe(300000)
      expect(june.purchaseTons).toBe(100)
      expect(june.salesAmount).toBe(200000)
      expect(june.salesTons).toBe(50)
      expect(june.logisticsAmount).toBe(5000)
      expect(june.paymentsOut).toBe(100000)
      expect(june.paymentsIn).toBe(0)
      expect(june.invoicesIn).toBe(300000)
      expect(june.invoicesOut).toBe(0)
    })

    it('returns empty grid for year with no data', () => {
      const result = getMonthlyOverview(ctx(), 2023)
      expect(result).toHaveLength(12)
      for (const row of result) {
        expect(row.purchaseAmount).toBe(0)
      }
    })
  })

  // ── getProfitByOrder ─────────────────────────────────────────────

  describe('getProfitByOrder', () => {
    it('groups by doc_no', () => {
      insertSale('sale-1', { date: '2024-06-15', totalAmount: 250000, tonnage: 60, docNo: 'DOC-001', customerId: 'cp-customer' })
      insertLogistics('log-1', { date: '2024-06-15', totalFee: 3000, docNo: 'DOC-001' })

      const result = getProfitByOrder(ctx())
      expect(result).toHaveLength(1)
      expect(result[0].docNo).toBe('DOC-001')
      expect(result[0].salesAmount).toBe(250000)
      expect(result[0].salesTons).toBe(60)
      expect(result[0].logisticsCost).toBe(3000)
      expect(result[0].grossProfit).toBe(247000) // 250000 - 0 - 3000
      expect(result[0].margin).toBe(98.8)         // 247000/250000*100
    })

    it('filters by customer', () => {
      insertCounterparty('cp-customer2', { name: '客户E', type: 'customer' })
      insertSale('sale-1', { date: '2024-06-15', totalAmount: 250000, tonnage: 60, docNo: 'DOC-001', customerId: 'cp-customer' })
      insertSale('sale-2', { date: '2024-07-01', totalAmount: 100000, tonnage: 20, docNo: 'DOC-002', customerId: 'cp-customer2' })

      const result = getProfitByOrder(ctx(), { customerId: 'cp-customer' })
      expect(result).toHaveLength(1)
      expect(result[0].docNo).toBe('DOC-001')
    })
  })
})
