/**
 * Structured business data store (v0.5 进销存).
 * CRUD + query functions for all biz_* tables.
 * Coexists with BizStore (bubble-based) via dual-write.
 */

import { getDatabase } from '../../storage/database.js'
import { ulid } from 'ulid'
import { logger } from '../../shared/logger.js'
import type {
  BizProduct, BizCounterparty, BizProject,
  BizPurchase, BizSale, BizLogisticsRecord, BizPayment, BizInvoice,
  InventoryItem, ReceivableItem, PayableItem, DashboardData, ProjectReconciliationItem,
} from './schema.js'

const TENANT = 'default'

// ── Helpers ─────────────────────────────────────────────────────────

function now(): number { return Date.now() }

/** Convert snake_case DB row to camelCase TS object */
function toCamel<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (key === 'metadata' || key === 'related_ids') {
      try { result[camel] = JSON.parse(val as string) } catch { result[camel] = val }
    } else {
      result[camel] = val
    }
  }
  return result as T
}

// ── Products ────────────────────────────────────────────────────────

export function createProduct(input: Omit<BizProduct, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizProduct {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_products (id, tenant_id, code, brand, name, spec, spec_display, category, measure_type, weight_per_bundle, pieces_per_bundle, lifting_fee, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.code, input.brand, input.name, input.spec, input.specDisplay ?? null, input.category ?? '螺纹钢', input.measureType ?? '理计', input.weightPerBundle ?? null, input.piecesPerBundle ?? null, input.liftingFee ?? null, JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, createdAt: ts, updatedAt: ts, ...input } as BizProduct
}

export function getProducts(query?: string): BizProduct[] {
  const db = getDatabase()
  let rows: unknown[]
  if (query) {
    const q = `%${query}%`
    rows = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND (code LIKE ? OR brand LIKE ? OR name LIKE ? OR spec LIKE ?) ORDER BY code').all(TENANT, q, q, q, q)
  } else {
    rows = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? ORDER BY code').all(TENANT)
  }
  return (rows as Record<string, unknown>[]).map(r => toCamel<BizProduct>(r))
}

export function getProductByCode(code: string): BizProduct | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND code = ?').get(TENANT, code) as Record<string, unknown> | undefined
  return row ? toCamel<BizProduct>(row) : undefined
}

export function getProductById(id: string): BizProduct | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_products WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? toCamel<BizProduct>(row) : undefined
}

export function updateProduct(id: string, updates: Partial<BizProduct>): void {
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  const map: Record<string, string> = {
    code: 'code', brand: 'brand', name: 'name', spec: 'spec', specDisplay: 'spec_display',
    category: 'category', measureType: 'measure_type', weightPerBundle: 'weight_per_bundle',
    piecesPerBundle: 'pieces_per_bundle', liftingFee: 'lifting_fee',
  }
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE biz_products SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProduct(id: string): void {
  getDatabase().prepare('DELETE FROM biz_products WHERE id = ?').run(id)
}

// ── Counterparties ──────────────────────────────────────────────────

export function createCounterparty(input: Omit<BizCounterparty, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizCounterparty {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, name, type, contact, phone, address, bank_info, tax_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.name, input.type, input.contact ?? null, input.phone ?? null, input.address ?? null, input.bankInfo ?? null, input.taxId ?? null, JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, createdAt: ts, updatedAt: ts, ...input } as BizCounterparty
}

export function getCounterparties(type?: string): BizCounterparty[] {
  const db = getDatabase()
  let rows: unknown[]
  if (type) {
    rows = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND type = ? ORDER BY name').all(TENANT, type)
  } else {
    rows = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? ORDER BY name').all(TENANT)
  }
  return (rows as Record<string, unknown>[]).map(r => toCamel<BizCounterparty>(r))
}

export function findCounterpartyByName(name: string, type?: string): BizCounterparty | undefined {
  const db = getDatabase()
  let row: Record<string, unknown> | undefined
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name = ? AND type = ?').get(TENANT, name, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name = ?').get(TENANT, name) as Record<string, unknown> | undefined
  }
  return row ? toCamel<BizCounterparty>(row) : undefined
}

export function updateCounterparty(id: string, updates: Partial<BizCounterparty>): void {
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  const map: Record<string, string> = {
    name: 'name', type: 'type', contact: 'contact', phone: 'phone',
    address: 'address', bankInfo: 'bank_info', taxId: 'tax_id',
  }
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE biz_counterparties SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteCounterparty(id: string): void {
  getDatabase().prepare('DELETE FROM biz_counterparties WHERE id = ?').run(id)
}

// ── Projects ────────────────────────────────────────────────────────

export function createProject(input: Omit<BizProject, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizProject {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_projects (id, tenant_id, name, customer_id, contract_no, address, builder, developer, contact, phone, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.name, input.customerId ?? null, input.contractNo ?? null, input.address ?? null, input.builder ?? null, input.developer ?? null, input.contact ?? null, input.phone ?? null, input.status ?? 'active', JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, createdAt: ts, updatedAt: ts, ...input } as BizProject
}

export function getProjects(): BizProject[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM biz_projects WHERE tenant_id = ? ORDER BY name').all(TENANT)
  return (rows as Record<string, unknown>[]).map(r => toCamel<BizProject>(r))
}

export function findProjectByName(name: string): BizProject | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_projects WHERE tenant_id = ? AND name = ?').get(TENANT, name) as Record<string, unknown> | undefined
  return row ? toCamel<BizProject>(row) : undefined
}

export function updateProject(id: string, updates: Partial<BizProject>): void {
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  const map: Record<string, string> = {
    name: 'name', customerId: 'customer_id', contractNo: 'contract_no',
    address: 'address', builder: 'builder', developer: 'developer',
    contact: 'contact', phone: 'phone', status: 'status',
  }
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE biz_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteProject(id: string): void {
  getDatabase().prepare('DELETE FROM biz_projects WHERE id = ?').run(id)
}

// ── Purchases ───────────────────────────────────────────────────────

export interface CreatePurchaseInput {
  date: string
  orderNo?: string
  supplierId: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  projectId?: string
  invoiceStatus?: string
  paymentStatus?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
}

export function createPurchase(input: CreatePurchaseInput): BizPurchase {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, date, order_no, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, project_id, invoice_status, payment_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.date, input.orderNo ?? null, input.supplierId, input.productId, input.bundleCount ?? null, input.tonnage, input.unitPrice, input.totalAmount, input.projectId ?? null, input.invoiceStatus ?? 'none', input.paymentStatus ?? 'unpaid', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizPurchase>(db.prepare('SELECT * FROM biz_purchases WHERE id = ?').get(id) as Record<string, unknown>)
}

export interface BizQueryFilter {
  dateFrom?: string
  dateTo?: string
  supplierId?: string
  customerId?: string
  productId?: string
  projectId?: string
  counterpartyId?: string
  status?: string
  limit?: number
  offset?: number
}

export function getPurchases(filter: BizQueryFilter = {}): BizPurchase[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.supplierId) { conditions.push('supplier_id = ?'); params.push(filter.supplierId) }
  if (filter.productId) { conditions.push('product_id = ?'); params.push(filter.productId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_purchases WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizPurchase>(r))
}

export function updatePurchase(id: string, updates: Partial<BizPurchase>): void {
  const db = getDatabase()
  const map: Record<string, string> = {
    date: 'date', orderNo: 'order_no', supplierId: 'supplier_id', productId: 'product_id',
    bundleCount: 'bundle_count', tonnage: 'tonnage', unitPrice: 'unit_price', totalAmount: 'total_amount',
    projectId: 'project_id', invoiceStatus: 'invoice_status', paymentStatus: 'payment_status', notes: 'notes',
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE biz_purchases SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deletePurchase(id: string): void {
  getDatabase().prepare('UPDATE biz_purchases SET deleted_at = ? WHERE id = ?').run(now(), id)
}

// ── Sales ───────────────────────────────────────────────────────────

export interface CreateSaleInput {
  date: string
  orderNo?: string
  customerId: string
  supplierId?: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  costPrice?: number
  costAmount?: number
  profit?: number
  projectId?: string
  logisticsProvider?: string
  invoiceStatus?: string
  collectionStatus?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
}

export function createSale(input: CreateSaleInput): BizSale {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, date, order_no, customer_id, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, cost_price, cost_amount, profit, project_id, logistics_provider, invoice_status, collection_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.date, input.orderNo ?? null, input.customerId, input.supplierId ?? null, input.productId, input.bundleCount ?? null, input.tonnage, input.unitPrice, input.totalAmount, input.costPrice ?? null, input.costAmount ?? null, input.profit ?? null, input.projectId ?? null, input.logisticsProvider ?? null, input.invoiceStatus ?? 'none', input.collectionStatus ?? 'uncollected', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizSale>(db.prepare('SELECT * FROM biz_sales WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getSales(filter: BizQueryFilter = {}): BizSale[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.customerId) { conditions.push('customer_id = ?'); params.push(filter.customerId) }
  if (filter.supplierId) { conditions.push('supplier_id = ?'); params.push(filter.supplierId) }
  if (filter.productId) { conditions.push('product_id = ?'); params.push(filter.productId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_sales WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizSale>(r))
}

export function updateSale(id: string, updates: Partial<BizSale>): void {
  const db = getDatabase()
  const map: Record<string, string> = {
    date: 'date', orderNo: 'order_no', customerId: 'customer_id', supplierId: 'supplier_id',
    productId: 'product_id', bundleCount: 'bundle_count', tonnage: 'tonnage', unitPrice: 'unit_price',
    totalAmount: 'total_amount', costPrice: 'cost_price', costAmount: 'cost_amount', profit: 'profit',
    projectId: 'project_id', logisticsProvider: 'logistics_provider',
    invoiceStatus: 'invoice_status', collectionStatus: 'collection_status', notes: 'notes',
  }
  const fields: string[] = []
  const values: unknown[] = []
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now(), id)
  db.prepare(`UPDATE biz_sales SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function deleteSale(id: string): void {
  getDatabase().prepare('UPDATE biz_sales SET deleted_at = ? WHERE id = ?').run(now(), id)
}

// ── Logistics ───────────────────────────────────────────────────────

export interface CreateLogisticsInput {
  date: string
  waybillNo?: string
  carrierId?: string
  projectId?: string
  destination?: string
  tonnage?: number
  freight?: number
  liftingFee?: number
  totalFee?: number
  driver?: string
  driverPhone?: string
  licensePlate?: string
  settlementStatus?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
}

export function createLogistics(input: CreateLogisticsInput): BizLogisticsRecord {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  const freight = input.freight ?? 0
  const liftingFee = input.liftingFee ?? 0
  const totalFee = input.totalFee ?? (freight + liftingFee)
  db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, date, waybill_no, carrier_id, project_id, destination, tonnage, freight, lifting_fee, total_fee, driver, driver_phone, license_plate, settlement_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.date, input.waybillNo ?? null, input.carrierId ?? null, input.projectId ?? null, input.destination ?? null, input.tonnage ?? null, freight, liftingFee, totalFee, input.driver ?? null, input.driverPhone ?? null, input.licensePlate ?? null, input.settlementStatus ?? 'unpaid', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizLogisticsRecord>(db.prepare('SELECT * FROM biz_logistics WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getLogistics(filter: BizQueryFilter = {}): BizLogisticsRecord[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) { conditions.push('carrier_id = ?'); params.push(filter.counterpartyId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_logistics WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizLogisticsRecord>(r))
}

export function deleteLogistics(id: string): void {
  getDatabase().prepare('UPDATE biz_logistics SET deleted_at = ? WHERE id = ?').run(now(), id)
}

// ── Payments ────────────────────────────────────────────────────────

export interface CreatePaymentInput {
  date: string
  docNo?: string
  direction: 'in' | 'out'
  counterpartyId: string
  projectId?: string
  amount: number
  method?: string
  referenceNo?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
}

export function createPayment(input: CreatePaymentInput): BizPayment {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, date, doc_no, direction, counterparty_id, project_id, amount, method, reference_no, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.date, input.docNo ?? null, input.direction, input.counterpartyId, input.projectId ?? null, input.amount, input.method ?? null, input.referenceNo ?? null, input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizPayment>(db.prepare('SELECT * FROM biz_payments WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getPayments(filter: BizQueryFilter = {}): BizPayment[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) { conditions.push('counterparty_id = ?'); params.push(filter.counterpartyId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  if (filter.status) { conditions.push('direction = ?'); params.push(filter.status) }
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_payments WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizPayment>(r))
}

export function deletePayment(id: string): void {
  getDatabase().prepare('UPDATE biz_payments SET deleted_at = ? WHERE id = ?').run(now(), id)
}

// ── Invoices ────────────────────────────────────────────────────────

export interface CreateInvoiceInput {
  date: string
  direction: 'in' | 'out'
  invoiceNo?: string
  counterpartyId: string
  amount: number
  taxRate?: number
  taxAmount?: number
  totalAmount?: number
  relatedIds?: string[]
  status?: string
  notes?: string
  bubbleId?: string
  createdBy?: string
}

export function createInvoice(input: CreateInvoiceInput): BizInvoice {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  const taxRate = input.taxRate ?? 0.13
  const taxAmount = input.taxAmount ?? Math.round(input.amount * taxRate * 100) / 100
  const totalAmount = input.totalAmount ?? Math.round((input.amount + taxAmount) * 100) / 100
  db.prepare(`
    INSERT INTO biz_invoices (id, tenant_id, date, direction, invoice_no, counterparty_id, amount, tax_rate, tax_amount, total_amount, related_ids, status, notes, bubble_id, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, input.date, input.direction, input.invoiceNo ?? null, input.counterpartyId, input.amount, taxRate, taxAmount, totalAmount, JSON.stringify(input.relatedIds ?? []), input.status ?? 'registered', input.notes ?? null, input.bubbleId ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizInvoice>(db.prepare('SELECT * FROM biz_invoices WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getInvoices(filter: BizQueryFilter = {}): BizInvoice[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) { conditions.push('counterparty_id = ?'); params.push(filter.counterpartyId) }
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_invoices WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizInvoice>(r))
}

export function deleteInvoice(id: string): void {
  getDatabase().prepare('UPDATE biz_invoices SET deleted_at = ? WHERE id = ?').run(now(), id)
}

// ── Computed Views ──────────────────────────────────────────────────

export function getInventory(): InventoryItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      p.id as product_id, p.code, p.brand, p.name, p.spec,
      COALESCE(pur.tons, 0) as purchase_tons,
      COALESCE(sal.tons, 0) as sales_tons,
      COALESCE(pur.tons, 0) - COALESCE(sal.tons, 0) as stock_tons
    FROM biz_products p
    LEFT JOIN (
      SELECT product_id, SUM(tonnage) as tons FROM biz_purchases WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY product_id
    ) pur ON pur.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(tonnage) as tons FROM biz_sales WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY product_id
    ) sal ON sal.product_id = p.id
    WHERE p.tenant_id = ?
    ORDER BY p.brand, p.spec
  `).all(TENANT, TENANT, TENANT) as Record<string, unknown>[]
  return rows.map(r => toCamel<InventoryItem>(r))
}

export function getReceivables(): ReceivableItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      c.id as customer_id, c.name,
      COALESCE(s.total, 0) as total_sales,
      COALESCE(pay.received, 0) as received,
      COALESCE(s.total, 0) - COALESCE(pay.received, 0) as outstanding
    FROM biz_counterparties c
    LEFT JOIN (
      SELECT customer_id, SUM(total_amount) as total FROM biz_sales WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY customer_id
    ) s ON s.customer_id = c.id
    LEFT JOIN (
      SELECT counterparty_id, SUM(amount) as received FROM biz_payments WHERE tenant_id = ? AND direction = 'in' AND deleted_at IS NULL GROUP BY counterparty_id
    ) pay ON pay.counterparty_id = c.id
    WHERE c.tenant_id = ? AND c.type IN ('customer', 'both')
    AND (COALESCE(s.total, 0) > 0 OR COALESCE(pay.received, 0) > 0)
    ORDER BY outstanding DESC
  `).all(TENANT, TENANT, TENANT) as Record<string, unknown>[]
  return rows.map(r => toCamel<ReceivableItem>(r))
}

export function getPayables(): PayableItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      c.id as supplier_id, c.name,
      COALESCE(p.total, 0) as total_purchases,
      COALESCE(pay.paid, 0) as paid,
      COALESCE(p.total, 0) - COALESCE(pay.paid, 0) as outstanding
    FROM biz_counterparties c
    LEFT JOIN (
      SELECT supplier_id, SUM(total_amount) as total FROM biz_purchases WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY supplier_id
    ) p ON p.supplier_id = c.id
    LEFT JOIN (
      SELECT counterparty_id, SUM(amount) as paid FROM biz_payments WHERE tenant_id = ? AND direction = 'out' AND deleted_at IS NULL GROUP BY counterparty_id
    ) pay ON pay.counterparty_id = c.id
    WHERE c.tenant_id = ? AND c.type IN ('supplier', 'both')
    AND (COALESCE(p.total, 0) > 0 OR COALESCE(pay.paid, 0) > 0)
    ORDER BY outstanding DESC
  `).all(TENANT, TENANT, TENANT) as Record<string, unknown>[]
  return rows.map(r => toCamel<PayableItem>(r))
}

export function getDashboard(): DashboardData {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10)

  const todayPurchases = (db.prepare('SELECT COUNT(*) as cnt FROM biz_purchases WHERE tenant_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, today) as { cnt: number }).cnt
  const todaySales = (db.prepare('SELECT COUNT(*) as cnt FROM biz_sales WHERE tenant_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, today) as { cnt: number }).cnt
  const todayLogistics = (db.prepare('SELECT COUNT(*) as cnt FROM biz_logistics WHERE tenant_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, today) as { cnt: number }).cnt

  const stockRow = db.prepare(`
    SELECT
      COALESCE(SUM(pur.tons), 0) - COALESCE(SUM(sal.tons), 0) as total
    FROM (SELECT 1) dummy
    LEFT JOIN (SELECT SUM(tonnage) as tons FROM biz_purchases WHERE tenant_id = ? AND deleted_at IS NULL) pur ON 1=1
    LEFT JOIN (SELECT SUM(tonnage) as tons FROM biz_sales WHERE tenant_id = ? AND deleted_at IS NULL) sal ON 1=1
  `).get(TENANT, TENANT) as { total: number }

  const recvRow = db.prepare(`
    SELECT COALESCE(SUM(s.total_amount), 0) - COALESCE((SELECT SUM(amount) FROM biz_payments WHERE tenant_id = ? AND direction = 'in' AND deleted_at IS NULL), 0) as total
    FROM biz_sales s WHERE s.tenant_id = ? AND s.deleted_at IS NULL
  `).get(TENANT, TENANT) as { total: number }

  const payRow = db.prepare(`
    SELECT COALESCE(SUM(p.total_amount), 0) - COALESCE((SELECT SUM(amount) FROM biz_payments WHERE tenant_id = ? AND direction = 'out' AND deleted_at IS NULL), 0) as total
    FROM biz_purchases p WHERE p.tenant_id = ? AND p.deleted_at IS NULL
  `).get(TENANT, TENANT) as { total: number }

  // Recent 5 transactions (union purchases + sales)
  const recent = db.prepare(`
    SELECT '采购' as type, date, supplier_id as cid, product_id as pid, total_amount as amount, created_at
    FROM biz_purchases WHERE tenant_id = ? AND deleted_at IS NULL
    UNION ALL
    SELECT '销售' as type, date, customer_id as cid, product_id as pid, total_amount as amount, created_at
    FROM biz_sales WHERE tenant_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 5
  `).all(TENANT, TENANT) as Array<{ type: string; date: string; cid: string; pid: string; amount: number }>

  const recentTransactions = recent.map(r => {
    const cp = r.cid ? (db.prepare('SELECT name FROM biz_counterparties WHERE id = ?').get(r.cid) as { name: string } | undefined) : undefined
    const prod = r.pid ? (db.prepare('SELECT name, spec FROM biz_products WHERE id = ?').get(r.pid) as { name: string; spec: string } | undefined) : undefined
    return {
      type: r.type,
      date: r.date,
      counterparty: cp?.name ?? '',
      product: prod ? `${prod.name} ${prod.spec}` : undefined,
      amount: r.amount,
    }
  })

  return {
    todayPurchases,
    todaySales,
    todayLogistics,
    totalStockTons: stockRow.total ?? 0,
    totalReceivable: recvRow.total ?? 0,
    totalPayable: payRow.total ?? 0,
    recentTransactions,
  }
}

// ── Lookup (VLOOKUP replacement) ────────────────────────────────────

export function lookupProduct(code: string): BizProduct | undefined {
  return getProductByCode(code)
}

/** Fuzzy find counterparty by partial name match */
export function fuzzyFindCounterparty(name: string, type?: string): BizCounterparty | undefined {
  const db = getDatabase()
  // Try exact match first
  let row: Record<string, unknown> | undefined
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name = ? AND type = ?').get(TENANT, name, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name = ?').get(TENANT, name) as Record<string, unknown> | undefined
  }
  if (row) return toCamel<BizCounterparty>(row)

  // Try LIKE match
  const q = `%${name}%`
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name LIKE ? AND type = ? LIMIT 1').get(TENANT, q, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND name LIKE ? LIMIT 1').get(TENANT, q) as Record<string, unknown> | undefined
  }
  return row ? toCamel<BizCounterparty>(row) : undefined
}

/** Fuzzy find product by partial code, brand, or spec match */
export function fuzzyFindProduct(query: string): BizProduct | undefined {
  const db = getDatabase()
  const q = `%${query}%`
  const row = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND (code LIKE ? OR brand LIKE ? OR spec LIKE ?) LIMIT 1').get(TENANT, q, q, q) as Record<string, unknown> | undefined
  return row ? toCamel<BizProduct>(row) : undefined
}

// ── Last purchase price (for cost price auto-fill) ──────────────────

export function getLastPurchasePrice(productId: string): number | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT unit_price FROM biz_purchases WHERE tenant_id = ? AND product_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 1').get(TENANT, productId) as { unit_price: number } | undefined
  return row?.unit_price
}

// ── Project Reconciliation (项目对账) ───────────────────────────────

export function getProjectReconciliation(): ProjectReconciliationItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      p.id as project_id, p.name as project_name, p.status,
      COALESCE(s.total, 0) as total_sales,
      COALESCE(l.total, 0) as total_logistics,
      COALESCE(pi.total, 0) as total_payments_in,
      COALESCE(po.total, 0) as total_payments_out,
      COALESCE(s.total, 0) - COALESCE(pi.total, 0) as outstanding
    FROM biz_projects p
    LEFT JOIN (
      SELECT project_id, SUM(total_amount) as total FROM biz_sales WHERE tenant_id = ? AND deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(total_fee) as total FROM biz_logistics WHERE tenant_id = ? AND deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id
    ) l ON l.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) as total FROM biz_payments WHERE tenant_id = ? AND direction = 'in' AND deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id
    ) pi ON pi.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) as total FROM biz_payments WHERE tenant_id = ? AND direction = 'out' AND deleted_at IS NULL AND project_id IS NOT NULL GROUP BY project_id
    ) po ON po.project_id = p.id
    WHERE p.tenant_id = ?
    ORDER BY outstanding DESC
  `).all(TENANT, TENANT, TENANT, TENANT, TENANT) as Record<string, unknown>[]
  return rows.map(r => toCamel<ProjectReconciliationItem>(r))
}
