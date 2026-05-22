import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  computeLindyDays,
  createProduct, getProducts, getProductByCode, getProductById, updateProduct, deleteProduct,
  createCounterparty, getCounterparties, findCounterpartyByName,
  createPurchase, getPurchases, updatePurchase, deletePurchase,
  getInventory, getExposure, getSilenceAlerts, getConcentrationMetrics, getDashboard,
  fuzzyFindCounterparty, fuzzyFindProduct,
  getLastPurchasePrice,
  getReceivables, getPayables,
  type BizContext,
} from '../src/connector/biz/structured-store.js'

const TENANT = 'default'
let tmpDir: string

function ctx(spaceId = 'space-1'): BizContext {
  return { spaceId }
}

// ── DB helpers ────────────────────────────────────────────────────

/** Ensure a column exists on a table (migrations may not add all columns) */
function ensureCol(table: string, col: string, def: string): void {
  const db = getDatabase()
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
}

/** Add any missing columns that structured-store code depends on */
function ensureSchema(): void {
  ensureCol('biz_counterparties', 'first_interaction', 'TEXT')
  // space_id added by migration v1.0 — check just in case
  ensureCol('biz_products', 'space_id', 'TEXT')
  ensureCol('biz_counterparties', 'space_id', 'TEXT')
}

function insertProductRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_products (id, tenant_id, space_id, code, brand, name, spec, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.code || `CODE-${id}`, overrides.brand || '品牌A',
    overrides.name || `产品${id}`, overrides.spec || 'HRB400',
    Date.now(), Date.now(),
  )
}

function insertCounterpartyRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, space_id, name, type, first_interaction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.name || `交易对手${id}`, overrides.type || 'supplier',
    overrides.first_interaction || '2024-01-15',
    Date.now(), Date.now(),
  )
}

function insertPurchaseRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  ensureCol('biz_purchases', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  ensureCol('biz_purchases', 'space_id', 'TEXT')
  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, space_id, date, doc_status, supplier_id, product_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-01-10',
    overrides.doc_status || 'confirmed',
    overrides.supplier_id || 'cp-1',
    overrides.product_id || 'prod-1',
    overrides.tonnage ?? 100, overrides.unit_price ?? 4000, overrides.total_amount ?? 400000,
    Date.now(), Date.now(),
  )
}

function insertSaleRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  ensureCol('biz_sales', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  ensureCol('biz_sales', 'space_id', 'TEXT')
  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, space_id, date, doc_status, customer_id, product_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-02-15',
    overrides.doc_status || 'confirmed',
    overrides.customer_id || 'cp-2',
    overrides.product_id || 'prod-1',
    overrides.tonnage ?? 50, overrides.unit_price ?? 4500, overrides.total_amount ?? 225000,
    Date.now(), Date.now(),
  )
}

function insertPaymentRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  ensureCol('biz_payments', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  ensureCol('biz_payments', 'space_id', 'TEXT')
  db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, space_id, date, doc_status, direction, counterparty_id, amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-03-15',
    overrides.doc_status || 'confirmed',
    overrides.direction || 'out',
    overrides.counterparty_id || 'cp-1',
    overrides.amount ?? 200000,
    Date.now(), Date.now(),
  )
}

function insertLogisticsRaw(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  ensureCol('biz_logistics', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  ensureCol('biz_logistics', 'space_id', 'TEXT')
  db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, space_id, date, doc_status, carrier_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-04-01',
    overrides.doc_status || 'confirmed',
    overrides.carrier_id || 'cp-3',
    Date.now(), Date.now(),
  )
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'structured-store-test-'))
  initDatabase(tmpDir, 'test-pass')
  ensureSchema()
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// ── Tests ───────────────────────────────────────────────────────

describe('computeLindyDays', () => {
  it('returns null for empty input', () => {
    expect(computeLindyDays()).toBeNull()
    expect(computeLindyDays('')).toBeNull()
  })

  it('returns positive number of days for a past date', () => {
    const days = computeLindyDays('2024-01-01')
    expect(days).toBeGreaterThan(400) // > 1 year
  })
})

describe('Product CRUD', () => {
  it('creates and retrieves a product', () => {
    const p = createProduct(ctx(), { code: 'HRB400E', brand: '沙钢', name: '螺纹钢', spec: 'Φ25×12m' })

    expect(p.id).toBeTruthy()
    expect(p.code).toBe('HRB400E')
    expect(p.brand).toBe('沙钢')

    const fetched = getProductById(p.id)
    expect(fetched).toBeDefined()
    expect(fetched!.name).toBe('螺纹钢')
  })

  it('getProducts returns all products in space', () => {
    createProduct(ctx('sp-a'), { code: 'P1', brand: 'A', name: '产品1', spec: 'S1' })
    createProduct(ctx('sp-a'), { code: 'P2', brand: 'B', name: '产品2', spec: 'S2' })

    const products = getProducts(ctx('sp-a'))
    expect(products).toHaveLength(2)

    // Different space returns empty
    expect(getProducts(ctx('sp-b'))).toHaveLength(0)
  })

  it('getProductByCode finds by code', () => {
    createProduct(ctx(), { code: 'HRB400-25', brand: '沙钢', name: '螺纹钢', spec: 'Φ25×12m' })

    const found = getProductByCode('HRB400-25')
    expect(found).toBeDefined()
    expect(found!.brand).toBe('沙钢')

    expect(getProductByCode('NONEXISTENT')).toBeUndefined()
  })

  it('updateProduct updates fields', () => {
    const p = createProduct(ctx(), { code: 'ORIG', brand: '旧品牌', name: '旧名', spec: 'S1' })

    updateProduct(p.id, { brand: '新品牌', name: '新名' })

    const updated = getProductById(p.id)
    expect(updated!.brand).toBe('新品牌')
    expect(updated!.name).toBe('新名')
  })

  it('deleteProduct removes the row', () => {
    const p = createProduct(ctx(), { code: 'DEL', brand: 'B', name: '待删除', spec: 'S' })

    deleteProduct(p.id)

    expect(getProductById(p.id)).toBeUndefined()
  })
})

describe('Counterparty CRUD', () => {
  it('creates, finds by name, and lists counterparties', () => {
    const cp = createCounterparty(ctx(), { name: '宝钢集团', type: 'supplier' })

    expect(cp.id).toBeTruthy()
    expect(cp.type).toBe('supplier')

    const found = findCounterpartyByName(ctx(), '宝钢集团')
    expect(found).toBeDefined()
    expect(found!.name).toBe('宝钢集团')

    const all = getCounterparties(ctx())
    expect(all.some(c => c.id === cp.id)).toBe(true)
  })

  it('getCounterparties filters by type', () => {
    createCounterparty(ctx(), { name: '供应商A', type: 'supplier' })
    createCounterparty(ctx(), { name: '客户B', type: 'customer' })

    expect(getCounterparties(ctx(), 'supplier')).toHaveLength(1)
    expect(getCounterparties(ctx(), 'customer')).toHaveLength(1)
  })
})

describe('Purchase CRUD', () => {
  it('creates and queries purchases with filters', () => {
    const prod = createProduct(ctx(), { code: 'P1', brand: 'B', name: 'N', spec: 'S' })
    const cp = createCounterparty(ctx(), { name: '供应商A', type: 'supplier' })

    const purchase = createPurchase({
      spaceId: 'space-1',
      date: '2025-06-01',
      productId: prod.id,
      supplierId: cp.id,
      tonnage: 100,
      unitPrice: 3800,
      totalAmount: 380000,
    })

    expect(purchase.id).toBeTruthy()
    expect(purchase.tonnage).toBe(100)
    expect(purchase.totalAmount).toBe(380000)

    const all = getPurchases(ctx())
    expect(all.some(p => p.id === purchase.id)).toBe(true)
  })

  it('updatePurchase modifies fields', () => {
    const prod = createProduct(ctx(), { code: 'P2', brand: 'B', name: 'N', spec: 'S' })
    const cp = createCounterparty(ctx(), { name: '供应商B', type: 'supplier' })

    const p = createPurchase({
      spaceId: 'space-1', date: '2025-06-01',
      productId: prod.id, supplierId: cp.id,
      tonnage: 50, unitPrice: 4000, totalAmount: 200000,
    })

    updatePurchase(p.id, { tonnage: 60, totalAmount: 240000 })

    const updated = getPurchases(ctx()).find(x => x.id === p.id)
    expect(updated!.tonnage).toBe(60)
    expect(updated!.totalAmount).toBe(240000)
  })

  it('deletePurchase removes the row', () => {
    const prod = createProduct(ctx(), { code: 'P3', brand: 'B', name: 'N', spec: 'S' })
    const cp = createCounterparty(ctx(), { name: '供应商C', type: 'supplier' })

    const p = createPurchase({
      spaceId: 'space-1', date: '2025-06-01',
      productId: prod.id, supplierId: cp.id,
      tonnage: 10, unitPrice: 5000, totalAmount: 50000,
    })

    deletePurchase(p.id)

    const all = getPurchases(ctx())
    expect(all.find(x => x.id === p.id)).toBeUndefined()
  })
})

describe('getInventory', () => {
  it('calculates stock from purchases minus sales', () => {
    insertProductRaw('prod-1', { space_id: 'space-1', code: 'HRB400' })
    insertCounterpartyRaw('cp-1', { space_id: 'space-1', type: 'supplier' })
    insertCounterpartyRaw('cp-2', { space_id: 'space-1', type: 'customer' })
    // Buy 100 tons
    insertPurchaseRaw('pu-1', { space_id: 'space-1', supplier_id: 'cp-1', product_id: 'prod-1', tonnage: 100 })
    // Sell 30 tons
    insertSaleRaw('sa-1', { space_id: 'space-1', customer_id: 'cp-2', product_id: 'prod-1', tonnage: 30 })

    const inv = getInventory(ctx('space-1'))

    expect(inv).toHaveLength(1)
    expect(inv[0].purchaseTons).toBe(100)
    expect(inv[0].salesTons).toBe(30)
    expect(inv[0].stockTons).toBe(70)
  })
})

describe('getExposure', () => {
  it('calculates net exposure per counterparty', () => {
    insertCounterpartyRaw('cp-sup', { space_id: 'space-1', type: 'supplier', name: '供应商A' })
    insertCounterpartyRaw('cp-cus', { space_id: 'space-1', type: 'customer', name: '客户B' })
    insertProductRaw('prod-1', { space_id: 'space-1' })
    // Purchase 500k from supplier, pay 200k
    insertPurchaseRaw('pu-1', { space_id: 'space-1', supplier_id: 'cp-sup', product_id: 'prod-1', total_amount: 500000 })
    insertPaymentRaw('pm-out', { space_id: 'space-1', counterparty_id: 'cp-sup', direction: 'out', amount: 200000 })
    // Sell 300k to customer, receive 100k
    insertSaleRaw('sa-1', { space_id: 'space-1', customer_id: 'cp-cus', product_id: 'prod-1', total_amount: 300000 })
    insertPaymentRaw('pm-in', { space_id: 'space-1', counterparty_id: 'cp-cus', direction: 'in', amount: 100000 })

    const exp = getExposure(ctx('space-1'))

    expect(exp.items.length).toBeGreaterThanOrEqual(2)
    // Supplier A: purchased 500k - paid 200k = 300k payable (negative net)
    const sup = exp.items.find(i => i.name === '供应商A')
    expect(sup).toBeDefined()
    expect(sup!.payable).toBeGreaterThan(0)
    // Customer B: sold 300k - received 100k = 200k receivable (positive net)
    const cus = exp.items.find(i => i.name === '客户B')
    expect(cus).toBeDefined()
    expect(cus!.receivable).toBeGreaterThan(0)
    // Total
    expect(exp.netExposure).not.toBe(0)
  })
})

describe('getSilenceAlerts', () => {
  it('returns alerts for counterparties past their expected activity threshold', () => {
    insertCounterpartyRaw('cp-active', { space_id: 'space-1', type: 'supplier', name: '活跃供应商' })
    insertCounterpartyRaw('cp-silent', { space_id: 'space-1', type: 'customer', name: '沉默客户' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    // Active: 5 transactions with recent date
    const today = new Date().toISOString().slice(0, 10)
    for (let i = 0; i < 5; i++) {
      const d = new Date(Date.now() - i * 7 * 86400000).toISOString().slice(0, 10)
      insertSaleRaw(`sa-active-${i}`, { space_id: 'space-1', customer_id: 'cp-active', product_id: 'prod-1', date: d, doc_status: 'confirmed' })
    }
    // Silent: 3 transactions but last one was 100 days ago
    for (let i = 0; i < 3; i++) {
      const d = new Date(Date.now() - (100 + i * 30) * 86400000).toISOString().slice(0, 10)
      insertSaleRaw(`sa-silent-${i}`, { space_id: 'space-1', customer_id: 'cp-silent', product_id: 'prod-1', date: d, doc_status: 'confirmed' })
    }

    const alerts = getSilenceAlerts(ctx('space-1'), 2.0, 3)

    // Silent customer should be in alerts
    const silentAlert = alerts.find(a => a.name === '沉默客户')
    expect(silentAlert).toBeDefined()
    expect(silentAlert!.silentDays).toBeGreaterThan(50)

    // Active supplier should NOT be in alerts
    const activeAlert = alerts.find(a => a.name === '活跃供应商')
    expect(activeAlert).toBeUndefined()
  })
})

describe('getConcentrationMetrics', () => {
  it('shows warning when top N suppliers exceed threshold', () => {
    insertCounterpartyRaw('cp-s1', { space_id: 'space-1', type: 'supplier', name: '大供应商' })
    insertCounterpartyRaw('cp-s2', { space_id: 'space-1', type: 'supplier', name: '小供应商' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    // One big supplier: 900k out of 1M total
    insertPurchaseRaw('pu-1', { space_id: 'space-1', supplier_id: 'cp-s1', product_id: 'prod-1', total_amount: 900000 })
    insertPurchaseRaw('pu-2', { space_id: 'space-1', supplier_id: 'cp-s2', product_id: 'prod-1', total_amount: 100000 })

    const conc = getConcentrationMetrics(ctx('space-1'), { topN: 1, threshold: 50 })

    expect(conc.supplierConcentration.warning).toBe(true)
    expect(conc.supplierConcentration.topN).toBe(1)
    expect(conc.supplierConcentration.topNShare).toBeGreaterThan(50)
  })

  it('no warning when concentration is below threshold', () => {
    insertCounterpartyRaw('cp-s1', { space_id: 'space-1', type: 'supplier', name: '供应商A' })
    insertCounterpartyRaw('cp-s2', { space_id: 'space-1', type: 'supplier', name: '供应商B' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    insertPurchaseRaw('pu-1', { space_id: 'space-1', supplier_id: 'cp-s1', product_id: 'prod-1', total_amount: 300000 })
    insertPurchaseRaw('pu-2', { space_id: 'space-1', supplier_id: 'cp-s2', product_id: 'prod-1', total_amount: 250000 })

    const conc = getConcentrationMetrics(ctx('space-1'), { topN: 1, threshold: 60 })
    // Top 1 share = 300k/550k ≈ 54.5% < 60% threshold
    expect(conc.supplierConcentration.warning).toBe(false)
  })
})

describe('getDashboard', () => {
  it('returns dashboard with today activity and totals', () => {
    insertCounterpartyRaw('cp-1', { space_id: 'space-1', type: 'supplier' })
    insertCounterpartyRaw('cp-2', { space_id: 'space-1', type: 'customer' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    const today = new Date().toISOString().slice(0, 10)
    insertPurchaseRaw('pu-1', { space_id: 'space-1', date: today, supplier_id: 'cp-1', product_id: 'prod-1', total_amount: 100000 })
    insertSaleRaw('sa-1', { space_id: 'space-1', date: today, customer_id: 'cp-2', product_id: 'prod-1', total_amount: 50000 })

    const dash = getDashboard(ctx('space-1'))

    expect(dash.todayPurchases).toBe(1)
    expect(dash.todaySales).toBe(1)
    expect(dash.recentTransactions.length).toBeGreaterThanOrEqual(1)
  })
})

describe('Fuzzy and lookup', () => {
  it('fuzzyFindCounterparty matches by partial name', () => {
    createCounterparty(ctx(), { name: '宝山钢铁', type: 'supplier' })

    const found = fuzzyFindCounterparty(ctx(), '宝山')
    expect(found).toBeDefined()
    expect(found!.name).toBe('宝山钢铁')

    expect(fuzzyFindCounterparty(ctx(), '不存在的公司')).toBeUndefined()
  })

  it('fuzzyFindProduct matches by partial code or brand', () => {
    createProduct(ctx(), { code: 'HRB400E', brand: '沙钢', name: '螺纹钢', spec: 'Φ25' })

    const byCode = fuzzyFindProduct(ctx(), 'HRB400')
    expect(byCode).toBeDefined()

    const byBrand = fuzzyFindProduct(ctx(), '沙钢')
    expect(byBrand).toBeDefined()

    expect(fuzzyFindProduct(ctx(), 'NONEXIST')).toBeUndefined()
  })

  it('getLastPurchasePrice returns most recent unit price', () => {
    insertCounterpartyRaw('cp-1', { space_id: 'space-1', type: 'supplier' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    insertPurchaseRaw('pu-old', { space_id: 'space-1', supplier_id: 'cp-1', product_id: 'prod-1', date: '2025-01-01', unit_price: 3500 })
    insertPurchaseRaw('pu-new', { space_id: 'space-1', supplier_id: 'cp-1', product_id: 'prod-1', date: '2025-06-01', unit_price: 3800 })

    const price = getLastPurchasePrice(ctx('space-1'), 'prod-1')
    expect(price).toBe(3800)
  })
})

describe('getReceivables / getPayables', () => {
  it('getReceivables returns outstanding amounts for customers', () => {
    insertCounterpartyRaw('cp-cus', { space_id: 'space-1', type: 'customer', name: '客户A' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    // Sell 200k, receive 50k → outstanding 150k
    insertSaleRaw('sa-1', { space_id: 'space-1', customer_id: 'cp-cus', product_id: 'prod-1', total_amount: 200000 })
    insertPaymentRaw('pm-1', { space_id: 'space-1', counterparty_id: 'cp-cus', direction: 'in', amount: 50000 })

    const recv = getReceivables(ctx('space-1'))
    const item = recv.find(r => r.name === '客户A')
    expect(item).toBeDefined()
    expect(item!.outstanding).toBe(150000)
  })

  it('getPayables returns outstanding amounts for suppliers', () => {
    insertCounterpartyRaw('cp-sup', { space_id: 'space-1', type: 'supplier', name: '供应商X' })
    insertProductRaw('prod-1', { space_id: 'space-1' })

    // Purchase 300k, pay 100k → outstanding 200k
    insertPurchaseRaw('pu-1', { space_id: 'space-1', supplier_id: 'cp-sup', product_id: 'prod-1', total_amount: 300000 })
    insertPaymentRaw('pm-1', { space_id: 'space-1', counterparty_id: 'cp-sup', direction: 'out', amount: 100000 })

    const pay = getPayables(ctx('space-1'))
    const item = pay.find(p => p.name === '供应商X')
    expect(item).toBeDefined()
    expect(item!.outstanding).toBe(200000)
  })
})
