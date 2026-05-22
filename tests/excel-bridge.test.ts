import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { bridgeExcelSheet } from '../src/connector/biz/excel-bridge.js'

const TENANT = 'default'
const SPACE_ID = 'ebridge-space'
let tmpDir: string

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

describe('bridgeExcelSheet', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'excel-bridge-test-'))
    initDatabase(tmpDir, 'test-pass')
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    cleanTables()
  })

  // ── fillDown (tested via side effects on input rows) ─────────────

  describe('fillDown behavior', () => {
    it('fills merged-cell gaps for purchase rows', () => {
      const rows: Record<string, unknown>[] = [
        { '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 },
        { '吨位': 50, '单价(元/吨)': 3000, '金额(元)': 150000 },
      ]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })

      // fillDown should have copied date and supplier from row 0 to row 1
      expect(rows[1]['采购日期']).toBe('2024-06-15')
      expect(rows[1]['供应商']).toBe('供应商A')
      // Both rows should have been created
      expect(result.created.purchases).toBe(2)
      expect(result.errors).toHaveLength(0)
    })

    it('does not affect rows that already have all data', () => {
      const rows: Record<string, unknown>[] = [
        { '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 },
        { '采购日期': '2024-07-01', '供应商': '供应商B', '吨位': 80, '单价(元/吨)': 3200, '金额(元)': 256000 },
      ]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(2)
      expect(rows[1]['采购日期']).toBe('2024-07-01')
      expect(rows[1]['供应商']).toBe('供应商B')
    })
  })

  // ── validateRow (tested via guardrail triggers) ─────────────────

  describe('validateRow guardrails', () => {
    it('rejects date before 2020-01-01', () => {
      const rows = [{ '采购日期': '2019-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(0)
      expect(result.skipped.purchases).toBe(1)
      expect(result.errors[0].message).toContain('guardrail')
      expect(result.errors[0].message).toContain('日期')
    })

    it('rejects excessive amount (> 50M)', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 60000000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.skipped.purchases).toBe(1)
      expect(result.errors[0].message).toContain('guardrail')
      expect(result.errors[0].message).toContain('异常大')
    })

    it('rejects negative tonnage', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': -10, '单价(元/吨)': 3000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.skipped.purchases).toBe(1)
      expect(result.errors[0].message).toContain('guardrail')
      expect(result.errors[0].message).toContain('吨位为负')
    })

    it('rejects excessive unit price (> 20000)', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 25000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.skipped.purchases).toBe(1)
      expect(result.errors[0].message).toContain('guardrail')
      expect(result.errors[0].message).toContain('单价异常')
    })
  })

  // ── Purchase rows ───────────────────────────────────────────────

  describe('purchase rows', () => {
    it('creates record with valid data', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })

      expect(result.created.purchases).toBe(1)
      expect(result.skipped.purchases).toBe(0)
      expect(result.errors).toHaveLength(0)

      // Verify record in DB
      const db = getDatabase()
      const purchases = db.prepare('SELECT * FROM biz_purchases WHERE space_id = ?').all(SPACE_ID) as any[]
      expect(purchases).toHaveLength(1)
      expect(purchases[0].doc_status).toBe('confirmed') // transitionStatus was called
      expect(purchases[0].tonnage).toBe(100)
      expect(purchases[0].total_amount).toBe(300000)
    })

    it('skips row missing required date', () => {
      const rows = [{ '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(0)
      expect(result.skipped.purchases).toBe(1)
    })

    it('skips duplicate row', () => {
      const rows = [
        { '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 },
        { '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 },
      ]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(1)
      expect(result.skipped.purchases).toBe(1) // duplicate skipped
    })

    it('computes totalAmount from tonnage * unitPrice when amount is missing', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(1)
      // totalAmount should be computed as 100 * 3000 = 300000
      const db = getDatabase()
      const p = db.prepare('SELECT total_amount FROM biz_purchases WHERE space_id = ?').get(SPACE_ID) as any
      expect(p.total_amount).toBe(300000)
    })
  })

  // ── Sales rows ──────────────────────────────────────────────────

  describe('sales rows', () => {
    it('creates record with valid data', () => {
      const rows = [{ '销售日期': '2024-06-20', '客户/项目': '客户B', '吨位': 50, '销售单价': 4000, '销售金额': 200000, '品牌': '品牌A', '商品名称': '螺纹钢', '规格': 'HRB400' }]
      const result = bridgeExcelSheet(rows, 'sales', { spaceId: SPACE_ID })

      expect(result.created.sales).toBe(1)
      expect(result.errors).toHaveLength(0)

      const db = getDatabase()
      const sales = db.prepare('SELECT * FROM biz_sales WHERE space_id = ?').all(SPACE_ID) as any[]
      expect(sales).toHaveLength(1)
      expect(sales[0].doc_status).toBe('confirmed')
      expect(sales[0].tonnage).toBe(50)
      expect(sales[0].total_amount).toBe(200000)
    })

    it('skips row missing customer', () => {
      const rows = [{ '销售日期': '2024-06-20', '吨位': 50, '销售单价': 4000, '销售金额': 200000 }]
      const result = bridgeExcelSheet(rows, 'sales', { spaceId: SPACE_ID })
      expect(result.created.sales).toBe(0)
      expect(result.skipped.sales).toBe(1)
    })
  })

  // ── Logistics rows ──────────────────────────────────────────────

  describe('logistics rows', () => {
    it('creates record with valid data', () => {
      const rows = [{ '装车日期': '2024-06-25', '托运公司': '物流C', '运费(元)': 3000, '吊费(元)': 500, '吨位': 80 }]
      const result = bridgeExcelSheet(rows, 'logistics', { spaceId: SPACE_ID })

      expect(result.created.logistics).toBe(1)
      expect(result.errors).toHaveLength(0)

      const db = getDatabase()
      const logs = db.prepare('SELECT * FROM biz_logistics WHERE space_id = ?').all(SPACE_ID) as any[]
      expect(logs).toHaveLength(1)
      expect(logs[0].doc_status).toBe('confirmed')
      expect(logs[0].total_fee).toBe(3500) // freight + liftingFee
    })

    it('skips row missing both carrier and destination', () => {
      const rows = [{ '装车日期': '2024-06-25', '运费(元)': 3000 }]
      const result = bridgeExcelSheet(rows, 'logistics', { spaceId: SPACE_ID })
      expect(result.created.logistics).toBe(0)
      expect(result.skipped.logistics).toBe(1)
    })
  })

  // ── Payment rows ────────────────────────────────────────────────

  describe('payment rows', () => {
    it('creates payment_out record', () => {
      const rows = [{ '日期': '2024-06-30', '金额(元)': 50000, '类型': '付款', '对象(客户/供应商)': '供应商A' }]
      const result = bridgeExcelSheet(rows, 'payment', { spaceId: SPACE_ID })

      expect(result.created.payments).toBe(1)
      expect(result.errors).toHaveLength(0)

      const db = getDatabase()
      const pays = db.prepare('SELECT * FROM biz_payments WHERE space_id = ?').all(SPACE_ID) as any[]
      expect(pays).toHaveLength(1)
      expect(pays[0].doc_status).toBe('confirmed')
      expect(pays[0].direction).toBe('out')
      expect(pays[0].amount).toBe(50000)
    })

    it('maps "回款" type to direction=in', () => {
      const rows = [{ '日期': '2024-06-30', '金额(元)': 80000, '类型': '回款', '对象': '客户B' }]
      const result = bridgeExcelSheet(rows, 'payment', { spaceId: SPACE_ID })

      expect(result.created.payments).toBe(1)
      const db = getDatabase()
      const p = db.prepare('SELECT direction, amount FROM biz_payments WHERE space_id = ?').get(SPACE_ID) as any
      expect(p.direction).toBe('in')
      expect(p.amount).toBe(80000)
    })

    it('skips row missing target', () => {
      const rows = [{ '日期': '2024-06-30', '金额(元)': 50000, '类型': '付款' }]
      const result = bridgeExcelSheet(rows, 'payment', { spaceId: SPACE_ID })
      expect(result.created.payments).toBe(0)
      expect(result.skipped.payments).toBe(1)
    })
  })

  // ── Category handling ───────────────────────────────────────────

  describe('category handling', () => {
    it('returns empty result for non-bridgeable category', () => {
      const rows = [{ name: 'test' }]
      const result = bridgeExcelSheet(rows, 'inventory' as any, { spaceId: SPACE_ID })
      expect(result.created.purchases).toBe(0)
      expect(result.created.sales).toBe(0)
      expect(result.created.logistics).toBe(0)
      expect(result.created.payments).toBe(0)
      expect(result.errors).toHaveLength(0)
    })
  })

  // ── Options ─────────────────────────────────────────────────────

  describe('options', () => {
    it('confirmImmediately=false leaves records as draft', () => {
      const rows = [{ '采购日期': '2024-06-15', '供应商': '供应商A', '吨位': 100, '单价(元/吨)': 3000, '金额(元)': 300000 }]
      const result = bridgeExcelSheet(rows, 'purchase', { spaceId: SPACE_ID, confirmImmediately: false })

      expect(result.created.purchases).toBe(1)
      const db = getDatabase()
      const p = db.prepare('SELECT doc_status FROM biz_purchases WHERE space_id = ?').get(SPACE_ID) as any
      expect(p.doc_status).toBe('draft') // not confirmed
    })
  })
})
