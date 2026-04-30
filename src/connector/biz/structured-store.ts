/**
 * Structured business data store (v0.5 进销存).
 * CRUD + query functions for all biz_* tables.
 * Coexists with BizStore (bubble-based) via dual-write.
 */

import { getDatabase } from '../../storage/database.js'
import { ulid } from 'ulid'
import { logger } from '../../shared/logger.js'
import { createDocLink } from './doc-engine.js'
import type {
  BizProduct, BizCounterparty, BizProject,
  BizPurchase, BizSale, BizLogisticsRecord, BizPayment, BizInvoice,
  BizPurchaseLine, BizSaleLine, BizTrade, SettlementMethod,
  InventoryItem, ReceivableItem, PayableItem, DashboardData, ProjectReconciliationItem,
  ExposureItem, ExposureSummary, SilenceAlertItem,
  DocLink,
} from './schema.js'

const TENANT = 'default'

// ── Context ─────────────────────────────────────────────────────────

export interface BizContext {
  spaceId: string
}

// ── Helpers ─────────────────────────────────────────────────────────

function now(): number { return Date.now() }

/**
 * Build a WHERE clause scoped by space_id when provided.
 * Returns [clause, params] to append to existing query params.
 */
function scopedWhere(id: string, spaceId?: string): { clause: string; params: unknown[] } {
  if (spaceId) return { clause: 'WHERE id = ? AND space_id = ?', params: [id, spaceId] }
  return { clause: 'WHERE id = ?', params: [id] }
}

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

/** Compute Lindy days from first interaction date to today. */
export function computeLindyDays(firstInteraction?: string): number | null {
  if (!firstInteraction) return null
  const ms = Date.now() - new Date(firstInteraction + 'T00:00:00').getTime()
  return Math.max(0, Math.floor(ms / 86400000))
}

/** Ensure first_interaction is always the earliest known transaction date. */
function ensureFirstInteraction(counterpartyId: string, date: string): void {
  const db = getDatabase()
  db.prepare(
    'UPDATE biz_counterparties SET first_interaction = ? WHERE id = ? AND (first_interaction IS NULL OR first_interaction > ?)',
  ).run(date, counterpartyId, date)
}

// ── Products ────────────────────────────────────────────────────────

export function createProduct(ctx: BizContext, input: Omit<BizProduct, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizProduct {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_products (id, tenant_id, space_id, code, brand, name, spec, spec_display, category, measure_type, weight_per_bundle, pieces_per_bundle, lifting_fee, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, ctx.spaceId, input.code, input.brand, input.name, input.spec, input.specDisplay ?? null, input.category ?? '螺纹钢', input.measureType ?? '理计', input.weightPerBundle ?? null, input.piecesPerBundle ?? null, input.liftingFee ?? null, JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, createdAt: ts, updatedAt: ts, ...input } as BizProduct
}

export function getProducts(ctx: BizContext, query?: string): BizProduct[] {
  const db = getDatabase()
  let rows: unknown[]
  if (query) {
    const q = `%${query}%`
    rows = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND space_id = ? AND (code LIKE ? OR brand LIKE ? OR name LIKE ? OR spec LIKE ?) ORDER BY code').all(TENANT, ctx.spaceId, q, q, q, q)
  } else {
    rows = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND space_id = ? ORDER BY code').all(TENANT, ctx.spaceId)
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

export function updateProduct(id: string, updates: Partial<BizProduct>, spaceId?: string): void {
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
  values.push(now())
  const { clause, params } = scopedWhere(id, spaceId)
  db.prepare(`UPDATE biz_products SET ${fields.join(', ')} ${clause}`).run(...values, ...params)
}

export function deleteProduct(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`DELETE FROM biz_products ${clause}`).run(...params)
}

// ── Counterparties ──────────────────────────────────────────────────

export function createCounterparty(ctx: BizContext, input: Omit<BizCounterparty, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizCounterparty {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  const firstInteraction = input.firstInteraction ?? new Date().toISOString().slice(0, 10)
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, space_id, name, type, contact, phone, address, bank_info, tax_id, first_interaction, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, ctx.spaceId, input.name, input.type, input.contact ?? null, input.phone ?? null, input.address ?? null, input.bankInfo ?? null, input.taxId ?? null, firstInteraction, JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, firstInteraction, createdAt: ts, updatedAt: ts, ...input } as BizCounterparty
}

export function getCounterparties(ctx: BizContext, type?: string): BizCounterparty[] {
  const db = getDatabase()
  let rows: unknown[]
  if (type) {
    rows = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND type = ? ORDER BY name').all(TENANT, ctx.spaceId, type)
  } else {
    rows = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? ORDER BY name').all(TENANT, ctx.spaceId)
  }
  return (rows as Record<string, unknown>[]).map(r => toCamel<BizCounterparty>(r))
}

export function findCounterpartyByName(ctx: BizContext, name: string, type?: string): BizCounterparty | undefined {
  const db = getDatabase()
  let row: Record<string, unknown> | undefined
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name = ? AND type = ?').get(TENANT, ctx.spaceId, name, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name = ?').get(TENANT, ctx.spaceId, name) as Record<string, unknown> | undefined
  }
  return row ? toCamel<BizCounterparty>(row) : undefined
}

export function updateCounterparty(id: string, updates: Partial<BizCounterparty>, spaceId?: string): void {
  const db = getDatabase()
  const fields: string[] = []
  const values: unknown[] = []
  const map: Record<string, string> = {
    name: 'name', type: 'type', contact: 'contact', phone: 'phone',
    address: 'address', bankInfo: 'bank_info', taxId: 'tax_id',
    firstInteraction: 'first_interaction',
  }
  for (const [ts, col] of Object.entries(map)) {
    if ((updates as Record<string, unknown>)[ts] !== undefined) {
      fields.push(`${col} = ?`)
      values.push((updates as Record<string, unknown>)[ts])
    }
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(now())
  const { clause, params } = scopedWhere(id, spaceId)
  db.prepare(`UPDATE biz_counterparties SET ${fields.join(', ')} ${clause}`).run(...values, ...params)
}

export function deleteCounterparty(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`DELETE FROM biz_counterparties ${clause}`).run(...params)
}

// ── Projects ────────────────────────────────────────────────────────

export function createProject(ctx: BizContext, input: Omit<BizProject, 'id' | 'tenantId' | 'createdAt' | 'updatedAt'>): BizProject {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_projects (id, tenant_id, space_id, name, customer_id, contract_no, address, builder, developer, contact, phone, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, ctx.spaceId, input.name, input.customerId ?? null, input.contractNo ?? null, input.address ?? null, input.builder ?? null, input.developer ?? null, input.contact ?? null, input.phone ?? null, input.status ?? 'active', JSON.stringify(input.metadata ?? {}), ts, ts)
  return { id, tenantId: TENANT, createdAt: ts, updatedAt: ts, ...input } as BizProject
}

export function getProjects(ctx: BizContext): BizProject[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM biz_projects WHERE tenant_id = ? AND space_id = ? ORDER BY name').all(TENANT, ctx.spaceId)
  return (rows as Record<string, unknown>[]).map(r => toCamel<BizProject>(r))
}

export function findProjectByName(ctx: BizContext, name: string): BizProject | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_projects WHERE tenant_id = ? AND space_id = ? AND name = ?').get(TENANT, ctx.spaceId, name) as Record<string, unknown> | undefined
  return row ? toCamel<BizProject>(row) : undefined
}

export function updateProject(id: string, updates: Partial<BizProject>, spaceId?: string): void {
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
  values.push(now())
  const { clause, params } = scopedWhere(id, spaceId)
  db.prepare(`UPDATE biz_projects SET ${fields.join(', ')} ${clause}`).run(...values, ...params)
}

export function deleteProject(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`DELETE FROM biz_projects ${clause}`).run(...params)
}

// ── Purchases ───────────────────────────────────────────────────────

export interface CreatePurchaseInput {
  date: string
  orderNo?: string
  docNo?: string
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
  spaceId?: string
}

export function createPurchase(input: CreatePurchaseInput): BizPurchase {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, space_id, date, order_no, doc_no, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, project_id, invoice_status, payment_status, notes, bubble_id, raw_input, created_by, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, TENANT, input.spaceId ?? null, input.date, input.orderNo ?? null, input.docNo ?? input.orderNo ?? null, input.supplierId, input.productId, input.bundleCount ?? null, input.tonnage, input.unitPrice, input.totalAmount, input.projectId ?? null, input.invoiceStatus ?? 'none', input.paymentStatus ?? 'unpaid', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  ensureFirstInteraction(input.supplierId, input.date)
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
  docStatus?: string  // comma-separated: 'draft,confirmed'
  limit?: number
  offset?: number
}

/** Append docStatus filter to query conditions */
function applyDocStatusFilter(conditions: string[], params: unknown[], docStatus?: string) {
  if (docStatus) {
    const statuses = docStatus.split(',').map(s => s.trim())
    conditions.push(`doc_status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }
}

export function getPurchases(ctx: BizContext, filter: BizQueryFilter = {}): BizPurchase[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'space_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT, ctx.spaceId]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.supplierId) { conditions.push('supplier_id = ?'); params.push(filter.supplierId) }
  if (filter.productId) { conditions.push('product_id = ?'); params.push(filter.productId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  applyDocStatusFilter(conditions, params, filter.docStatus)
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_purchases WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizPurchase>(r))
}

export function updatePurchase(id: string, updates: Partial<BizPurchase>, spaceId?: string): void {
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
  values.push(now())
  const { clause, params } = scopedWhere(id, spaceId)
  db.prepare(`UPDATE biz_purchases SET ${fields.join(', ')} ${clause}`).run(...values, ...params)
}

export function deletePurchase(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`UPDATE biz_purchases SET deleted_at = ? ${clause}`).run(now(), ...params)
}

// ── Sales ───────────────────────────────────────────────────────────

export interface CreateSaleInput {
  date: string
  orderNo?: string
  docNo?: string
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
  spaceId?: string
}

export function createSale(input: CreateSaleInput): BizSale {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, space_id, date, order_no, doc_no, customer_id, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, cost_price, cost_amount, profit, project_id, logistics_provider, invoice_status, collection_status, notes, bubble_id, raw_input, created_by, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, TENANT, input.spaceId ?? null, input.date, input.orderNo ?? null, input.docNo ?? input.orderNo ?? null, input.customerId, input.supplierId ?? null, input.productId, input.bundleCount ?? null, input.tonnage, input.unitPrice, input.totalAmount, input.costPrice ?? null, input.costAmount ?? null, input.profit ?? null, input.projectId ?? null, input.logisticsProvider ?? null, input.invoiceStatus ?? 'none', input.collectionStatus ?? 'uncollected', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  ensureFirstInteraction(input.customerId, input.date)
  return toCamel<BizSale>(db.prepare('SELECT * FROM biz_sales WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getSales(ctx: BizContext, filter: BizQueryFilter = {}): BizSale[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'space_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT, ctx.spaceId]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.customerId) { conditions.push('customer_id = ?'); params.push(filter.customerId) }
  if (filter.supplierId) { conditions.push('supplier_id = ?'); params.push(filter.supplierId) }
  if (filter.productId) { conditions.push('product_id = ?'); params.push(filter.productId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  applyDocStatusFilter(conditions, params, filter.docStatus)
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_sales WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizSale>(r))
}

export function updateSale(id: string, updates: Partial<BizSale>, spaceId?: string): void {
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
  values.push(now())
  const { clause, params } = scopedWhere(id, spaceId)
  db.prepare(`UPDATE biz_sales SET ${fields.join(', ')} ${clause}`).run(...values, ...params)
}

export function deleteSale(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`UPDATE biz_sales SET deleted_at = ? ${clause}`).run(now(), ...params)
}

// ── Logistics ───────────────────────────────────────────────────────

export interface CreateLogisticsInput {
  date: string
  waybillNo?: string
  docNo?: string
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
  spaceId?: string
}

export function createLogistics(input: CreateLogisticsInput): BizLogisticsRecord {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  const freight = input.freight ?? 0
  const liftingFee = input.liftingFee ?? 0
  const totalFee = input.totalFee ?? (freight + liftingFee)
  db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, space_id, date, waybill_no, doc_no, carrier_id, project_id, destination, tonnage, freight, lifting_fee, total_fee, driver, driver_phone, license_plate, settlement_status, notes, bubble_id, raw_input, created_by, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, TENANT, input.spaceId ?? null, input.date, input.waybillNo ?? null, input.docNo ?? input.waybillNo ?? null, input.carrierId ?? null, input.projectId ?? null, input.destination ?? null, input.tonnage ?? null, freight, liftingFee, totalFee, input.driver ?? null, input.driverPhone ?? null, input.licensePlate ?? null, input.settlementStatus ?? 'unpaid', input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  if (input.carrierId) ensureFirstInteraction(input.carrierId, input.date)
  return toCamel<BizLogisticsRecord>(db.prepare('SELECT * FROM biz_logistics WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getLogistics(ctx: BizContext, filter: BizQueryFilter = {}): BizLogisticsRecord[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'space_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT, ctx.spaceId]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) { conditions.push('carrier_id = ?'); params.push(filter.counterpartyId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  applyDocStatusFilter(conditions, params, filter.docStatus)
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_logistics WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizLogisticsRecord>(r))
}

export function deleteLogistics(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`UPDATE biz_logistics SET deleted_at = ? ${clause}`).run(now(), ...params)
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
  spaceId?: string
}

export function createPayment(input: CreatePaymentInput): BizPayment {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, space_id, date, doc_no, direction, counterparty_id, project_id, amount, method, reference_no, notes, bubble_id, raw_input, created_by, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, TENANT, input.spaceId ?? null, input.date, input.docNo ?? null, input.direction, input.counterpartyId, input.projectId ?? null, input.amount, input.method ?? null, input.referenceNo ?? null, input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null, ts, ts)
  ensureFirstInteraction(input.counterpartyId, input.date)
  return toCamel<BizPayment>(db.prepare('SELECT * FROM biz_payments WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getPayments(ctx: BizContext, filter: BizQueryFilter = {}): BizPayment[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'space_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT, ctx.spaceId]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) { conditions.push('counterparty_id = ?'); params.push(filter.counterpartyId) }
  if (filter.projectId) { conditions.push('project_id = ?'); params.push(filter.projectId) }
  if (filter.status) {
    conditions.push('direction = ?')
    params.push(filter.status)
  }
  applyDocStatusFilter(conditions, params, filter.docStatus)
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_payments WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizPayment>(r))
}

export function deletePayment(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`UPDATE biz_payments SET deleted_at = ? ${clause}`).run(now(), ...params)
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
  spaceId?: string
}

export function createInvoice(input: CreateInvoiceInput): BizInvoice {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  const taxRate = input.taxRate ?? 0.13
  const taxAmount = input.taxAmount ?? Math.round(input.amount * taxRate * 100) / 100
  const totalAmount = input.totalAmount ?? Math.round((input.amount + taxAmount) * 100) / 100
  db.prepare(`
    INSERT INTO biz_invoices (id, tenant_id, space_id, date, direction, invoice_no, counterparty_id, amount, tax_rate, tax_amount, total_amount, related_ids, status, notes, bubble_id, created_by, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)
  `).run(id, TENANT, input.spaceId ?? null, input.date, input.direction, input.invoiceNo ?? null, input.counterpartyId, input.amount, taxRate, taxAmount, totalAmount, JSON.stringify(input.relatedIds ?? []), input.status ?? 'registered', input.notes ?? null, input.bubbleId ?? null, input.createdBy ?? null, ts, ts)
  return toCamel<BizInvoice>(db.prepare('SELECT * FROM biz_invoices WHERE id = ?').get(id) as Record<string, unknown>)
}

export function getInvoices(ctx: BizContext, filter: BizQueryFilter = {}): BizInvoice[] {
  const db = getDatabase()
  const conditions = ['tenant_id = ?', 'space_id = ?', 'deleted_at IS NULL']
  const params: unknown[] = [TENANT, ctx.spaceId]
  if (filter.dateFrom) { conditions.push('date >= ?'); params.push(filter.dateFrom) }
  if (filter.dateTo) { conditions.push('date <= ?'); params.push(filter.dateTo) }
  if (filter.counterpartyId) {
    conditions.push('counterparty_id = ?')
    params.push(filter.counterpartyId)
  }
  applyDocStatusFilter(conditions, params, filter.docStatus)
  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0
  const sql = `SELECT * FROM biz_invoices WHERE ${conditions.join(' AND ')} ORDER BY date DESC, created_at DESC LIMIT ? OFFSET ?`
  params.push(limit, offset)
  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[]
  return rows.map(r => toCamel<BizInvoice>(r))
}

export function deleteInvoice(id: string, spaceId?: string): void {
  const { clause, params } = scopedWhere(id, spaceId)
  getDatabase().prepare(`UPDATE biz_invoices SET deleted_at = ? ${clause}`).run(now(), ...params)
}

// ── Computed Views ──────────────────────────────────────────────────
// IMPORTANT: Only confirmed + completed documents count in computed views.
// Drafts and cancelled documents are excluded from stock/AR/AP calculations.
const ACTIVE_STATUS = "doc_status IN ('confirmed','completed')"

export function getInventory(ctx: BizContext): InventoryItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      p.id as product_id, p.code, p.brand, p.name, p.spec,
      COALESCE(pur.tons, 0) as purchase_tons,
      COALESCE(sal.tons, 0) as sales_tons,
      COALESCE(pur.tons, 0) - COALESCE(sal.tons, 0) as stock_tons
    FROM biz_products p
    LEFT JOIN (
      SELECT product_id, SUM(tonnage) as tons FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY product_id
    ) pur ON pur.product_id = p.id
    LEFT JOIN (
      SELECT product_id, SUM(tonnage) as tons FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY product_id
    ) sal ON sal.product_id = p.id
    WHERE p.tenant_id = ? AND p.space_id = ?
    ORDER BY p.brand, p.spec
  `).all(TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId) as Record<string, unknown>[]
  return rows.map(r => toCamel<InventoryItem>(r))
}

export function getReceivables(ctx: BizContext): ReceivableItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      c.id as customer_id, c.name,
      COALESCE(s.total, 0) as total_sales,
      COALESCE(pay.received, 0) as received,
      COALESCE(s.total, 0) - COALESCE(pay.received, 0) as outstanding
    FROM biz_counterparties c
    LEFT JOIN (
      SELECT customer_id, SUM(total_amount) as total FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY customer_id
    ) s ON s.customer_id = c.id
    LEFT JOIN (
      SELECT counterparty_id, SUM(amount) as received FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'in' AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY counterparty_id
    ) pay ON pay.counterparty_id = c.id
    WHERE c.tenant_id = ? AND c.space_id = ? AND c.type IN ('customer', 'both')
    AND (COALESCE(s.total, 0) > 0 OR COALESCE(pay.received, 0) > 0)
    ORDER BY outstanding DESC
  `).all(TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId) as Record<string, unknown>[]
  return rows.map(r => toCamel<ReceivableItem>(r))
}

export function getPayables(ctx: BizContext): PayableItem[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      c.id as supplier_id, c.name,
      COALESCE(p.total, 0) as total_purchases,
      COALESCE(pay.paid, 0) as paid,
      COALESCE(p.total, 0) - COALESCE(pay.paid, 0) as outstanding
    FROM biz_counterparties c
    LEFT JOIN (
      SELECT supplier_id, SUM(total_amount) as total FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY supplier_id
    ) p ON p.supplier_id = c.id
    LEFT JOIN (
      SELECT counterparty_id, SUM(amount) as paid FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'out' AND deleted_at IS NULL AND ${ACTIVE_STATUS} GROUP BY counterparty_id
    ) pay ON pay.counterparty_id = c.id
    WHERE c.tenant_id = ? AND c.space_id = ? AND c.type IN ('supplier', 'both')
    AND (COALESCE(p.total, 0) > 0 OR COALESCE(pay.paid, 0) > 0)
    ORDER BY outstanding DESC
  `).all(TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId) as Record<string, unknown>[]
  return rows.map(r => toCamel<PayableItem>(r))
}

export function getExposure(ctx: BizContext): ExposureSummary {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      c.id as counterparty_id, c.name, c.type, c.first_interaction,
      COALESCE(recv.outstanding, 0) as receivable,
      COALESCE(pay.outstanding, 0) as payable,
      COALESCE(recv.outstanding, 0) - COALESCE(pay.outstanding, 0) as net_exposure
    FROM biz_counterparties c
    LEFT JOIN (
      SELECT s.customer_id as cid,
        COALESCE(SUM(s.total_amount), 0) - COALESCE(pin.total, 0) as outstanding
      FROM biz_sales s
      LEFT JOIN (
        SELECT counterparty_id, SUM(amount) as total
        FROM biz_payments
        WHERE tenant_id = ? AND space_id = ? AND direction = 'in'
          AND deleted_at IS NULL AND ${ACTIVE_STATUS}
        GROUP BY counterparty_id
      ) pin ON pin.counterparty_id = s.customer_id
      WHERE s.tenant_id = ? AND s.space_id = ? AND s.deleted_at IS NULL
        AND s.${ACTIVE_STATUS}
      GROUP BY s.customer_id
    ) recv ON recv.cid = c.id
    LEFT JOIN (
      SELECT p.supplier_id as cid,
        COALESCE(SUM(p.total_amount), 0) - COALESCE(pout.total, 0) as outstanding
      FROM biz_purchases p
      LEFT JOIN (
        SELECT counterparty_id, SUM(amount) as total
        FROM biz_payments
        WHERE tenant_id = ? AND space_id = ? AND direction = 'out'
          AND deleted_at IS NULL AND ${ACTIVE_STATUS}
        GROUP BY counterparty_id
      ) pout ON pout.counterparty_id = p.supplier_id
      WHERE p.tenant_id = ? AND p.space_id = ? AND p.deleted_at IS NULL
        AND p.${ACTIVE_STATUS}
      GROUP BY p.supplier_id
    ) pay ON pay.cid = c.id
    WHERE c.tenant_id = ? AND c.space_id = ?
      AND (COALESCE(recv.outstanding, 0) != 0 OR COALESCE(pay.outstanding, 0) != 0)
    ORDER BY ABS(COALESCE(recv.outstanding, 0) - COALESCE(pay.outstanding, 0)) DESC
  `).all(
    TENANT, ctx.spaceId, TENANT, ctx.spaceId,
    TENANT, ctx.spaceId, TENANT, ctx.spaceId,
    TENANT, ctx.spaceId,
  ) as Record<string, unknown>[]

  let totalReceivable = 0
  let totalPayable = 0
  const items: ExposureItem[] = rows.map(r => {
    const item = toCamel<ExposureItem>(r)
    item.lindyDays = computeLindyDays(item.firstInteraction)
    totalReceivable += item.receivable
    totalPayable += item.payable
    return item
  })

  return {
    items,
    totalReceivable,
    totalPayable,
    netExposure: totalReceivable - totalPayable,
  }
}

export function getSilenceAlerts(ctx: BizContext, multiplier = 2.0, minTx = 3): SilenceAlertItem[] {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10)
  const todayMs = new Date(today + 'T00:00:00').getTime()
  const maxThresholdDays = 90

  const activityRows = db.prepare(`
    SELECT counterparty_id, MAX(date) as last_date, COUNT(*) as cnt, MIN(date) as first_date
    FROM (
      SELECT supplier_id as counterparty_id, date FROM biz_purchases
        WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT customer_id, date FROM biz_sales
        WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT counterparty_id, date FROM biz_payments
        WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
      UNION ALL
      SELECT carrier_id, date FROM biz_logistics
        WHERE space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
    ) t
    WHERE counterparty_id IS NOT NULL
    GROUP BY counterparty_id
    HAVING COUNT(*) >= ?
  `).all(ctx.spaceId, ctx.spaceId, ctx.spaceId, ctx.spaceId, minTx) as Array<{
    counterparty_id: string; last_date: string; cnt: number; first_date: string
  }>

  const alerts: SilenceAlertItem[] = []

  for (const row of activityRows) {
    const lastDateMs = new Date(row.last_date + 'T00:00:00').getTime()
    const firstDateMs = new Date(row.first_date + 'T00:00:00').getTime()
    const daysSilent = Math.floor((todayMs - lastDateMs) / 86400000)
    const spanDays = Math.max(1, Math.floor((lastDateMs - firstDateMs) / 86400000))
    const avgInterval = spanDays / Math.max(1, row.cnt - 1)
    const threshold = Math.min(Math.ceil(multiplier * avgInterval), maxThresholdDays)

    if (daysSilent <= threshold) continue

    const cp = db.prepare(
      'SELECT id, name, type FROM biz_counterparties WHERE id = ?',
    ).get(row.counterparty_id) as { id: string; name: string; type: string } | undefined
    if (!cp) continue

    alerts.push({
      counterpartyId: cp.id,
      name: cp.name,
      type: cp.type,
      lastDate: row.last_date,
      transactionCount: row.cnt,
      avgIntervalDays: avgInterval,
      silentDays: daysSilent,
      threshold,
    })
  }

  return alerts.sort((a, b) => b.silentDays - a.silentDays)
}

// ── Concentration Metrics ──────────────────────────────────────────

export interface ConcentrationItem {
  name: string
  amount: number
  share: number   // 0-100
}

export interface ConcentrationSide {
  topN: number
  topItems: ConcentrationItem[]
  totalAmount: number
  topNShare: number   // 0-100
  warning: boolean
}

export interface ConcentrationMetrics {
  supplierConcentration: ConcentrationSide
  customerConcentration: ConcentrationSide
  threshold: number
}

function computeConcentration(
  rows: Array<{ name: string; total: number }>,
  topN: number,
  threshold: number,
): ConcentrationSide {
  const totalAmount = rows.reduce((s, r) => s + r.total, 0)
  if (totalAmount === 0) {
    return { topN, topItems: [], totalAmount: 0, topNShare: 0, warning: false }
  }
  const sorted = [...rows].sort((a, b) => b.total - a.total)
  const topItems = sorted.slice(0, topN).map(r => ({
    name: r.name,
    amount: r.total,
    share: Math.round((r.total / totalAmount) * 10000) / 100,
  }))
  const topNShare = Math.round(topItems.reduce((s, i) => s + i.share, 0) * 100) / 100
  return { topN, topItems, totalAmount, topNShare, warning: topNShare > threshold }
}

export function getConcentrationMetrics(
  ctx: BizContext,
  options: { topN?: number; threshold?: number; dateFrom?: string; dateTo?: string } = {},
): ConcentrationMetrics {
  const db = getDatabase()
  const topN = options.topN ?? 3
  const threshold = options.threshold ?? 60

  const dateFilter = (alias: string) => {
    const parts: string[] = []
    if (options.dateFrom) parts.push(`${alias}.date >= '${options.dateFrom}'`)
    if (options.dateTo) parts.push(`${alias}.date <= '${options.dateTo}'`)
    return parts.length > 0 ? `AND ${parts.join(' AND ')}` : ''
  }

  // Supplier concentration: total purchase amount per supplier
  const supplierRows = db.prepare(`
    SELECT c.name, COALESCE(SUM(p.total_amount), 0) as total
    FROM biz_purchases p
    JOIN biz_counterparties c ON c.id = p.supplier_id
    WHERE p.tenant_id = ? AND p.space_id = ? AND p.deleted_at IS NULL AND p.${ACTIVE_STATUS}
    ${dateFilter('p')}
    GROUP BY p.supplier_id
    HAVING total > 0
  `).all(TENANT, ctx.spaceId) as Array<{ name: string; total: number }>

  // Customer concentration: total sales amount per customer
  const customerRows = db.prepare(`
    SELECT c.name, COALESCE(SUM(s.total_amount), 0) as total
    FROM biz_sales s
    JOIN biz_counterparties c ON c.id = s.customer_id
    WHERE s.tenant_id = ? AND s.space_id = ? AND s.deleted_at IS NULL AND s.${ACTIVE_STATUS}
    ${dateFilter('s')}
    GROUP BY s.customer_id
    HAVING total > 0
  `).all(TENANT, ctx.spaceId) as Array<{ name: string; total: number }>

  return {
    supplierConcentration: computeConcentration(supplierRows, topN, threshold),
    customerConcentration: computeConcentration(customerRows, topN, threshold),
    threshold,
  }
}

export function getDashboard(ctx: BizContext): DashboardData {
  const db = getDatabase()
  const today = new Date().toISOString().slice(0, 10)

  // Today counts include all statuses (drafts too — they represent today's activity)
  const todayPurchases = (db.prepare('SELECT COUNT(*) as cnt FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, ctx.spaceId, today) as { cnt: number }).cnt
  const todaySales = (db.prepare('SELECT COUNT(*) as cnt FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, ctx.spaceId, today) as { cnt: number }).cnt
  const todayLogistics = (db.prepare('SELECT COUNT(*) as cnt FROM biz_logistics WHERE tenant_id = ? AND space_id = ? AND date = ? AND deleted_at IS NULL').get(TENANT, ctx.spaceId, today) as { cnt: number }).cnt

  // Stock/AR/AP only count confirmed + completed
  const stockRow = db.prepare(`
    SELECT
      COALESCE(SUM(pur.tons), 0) - COALESCE(SUM(sal.tons), 0) as total
    FROM (SELECT 1) dummy
    LEFT JOIN (SELECT SUM(tonnage) as tons FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}) pur ON 1=1
    LEFT JOIN (SELECT SUM(tonnage) as tons FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}) sal ON 1=1
  `).get(TENANT, ctx.spaceId, TENANT, ctx.spaceId) as { total: number }

  const recvRow = db.prepare(`
    SELECT COALESCE(SUM(s.total_amount), 0) - COALESCE((SELECT SUM(amount) FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'in' AND deleted_at IS NULL AND ${ACTIVE_STATUS}), 0) as total
    FROM biz_sales s WHERE s.tenant_id = ? AND s.space_id = ? AND s.deleted_at IS NULL AND s.${ACTIVE_STATUS}
  `).get(TENANT, ctx.spaceId, TENANT, ctx.spaceId) as { total: number }

  const payRow = db.prepare(`
    SELECT COALESCE(SUM(p.total_amount), 0) - COALESCE((SELECT SUM(amount) FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'out' AND deleted_at IS NULL AND ${ACTIVE_STATUS}), 0) as total
    FROM biz_purchases p WHERE p.tenant_id = ? AND p.space_id = ? AND p.deleted_at IS NULL AND p.${ACTIVE_STATUS}
  `).get(TENANT, ctx.spaceId, TENANT, ctx.spaceId) as { total: number }

  // Recent 5 transactions (all statuses — shows recent activity)
  const recent = db.prepare(`
    SELECT '采购' as type, date, supplier_id as cid, product_id as pid, total_amount as amount, created_at
    FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL
    UNION ALL
    SELECT '销售' as type, date, customer_id as cid, product_id as pid, total_amount as amount, created_at
    FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 5
  `).all(TENANT, ctx.spaceId, TENANT, ctx.spaceId) as Array<{ type: string; date: string; cid: string; pid: string; amount: number }>

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
export function fuzzyFindCounterparty(ctx: BizContext, name: string, type?: string): BizCounterparty | undefined {
  const db = getDatabase()
  // Try exact match first
  let row: Record<string, unknown> | undefined
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name = ? AND type = ?').get(TENANT, ctx.spaceId, name, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name = ?').get(TENANT, ctx.spaceId, name) as Record<string, unknown> | undefined
  }
  if (row) return toCamel<BizCounterparty>(row)

  // Try LIKE match
  const q = `%${name}%`
  if (type) {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name LIKE ? AND type = ? LIMIT 1').get(TENANT, ctx.spaceId, q, type) as Record<string, unknown> | undefined
  } else {
    row = db.prepare('SELECT * FROM biz_counterparties WHERE tenant_id = ? AND space_id = ? AND name LIKE ? LIMIT 1').get(TENANT, ctx.spaceId, q) as Record<string, unknown> | undefined
  }
  return row ? toCamel<BizCounterparty>(row) : undefined
}

/** Fuzzy find product by partial code, brand, or spec match */
export function fuzzyFindProduct(ctx: BizContext, query: string): BizProduct | undefined {
  const db = getDatabase()
  const q = `%${query}%`
  const row = db.prepare('SELECT * FROM biz_products WHERE tenant_id = ? AND space_id = ? AND (code LIKE ? OR brand LIKE ? OR spec LIKE ?) LIMIT 1').get(TENANT, ctx.spaceId, q, q, q) as Record<string, unknown> | undefined
  return row ? toCamel<BizProduct>(row) : undefined
}

// ── Last purchase price (for cost price auto-fill) ──────────────────

export function getLastPurchasePrice(ctx: BizContext, productId: string): number | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT unit_price FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND product_id = ? AND deleted_at IS NULL ORDER BY date DESC, created_at DESC LIMIT 1').get(TENANT, ctx.spaceId, productId) as { unit_price: number } | undefined
  return row?.unit_price
}

// ── Project Reconciliation (项目对账) ───────────────────────────────

export function getProjectReconciliation(ctx: BizContext): ProjectReconciliationItem[] {
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
      SELECT project_id, SUM(total_amount) as total FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND project_id IS NOT NULL GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(total_fee) as total FROM biz_logistics WHERE tenant_id = ? AND space_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND project_id IS NOT NULL GROUP BY project_id
    ) l ON l.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) as total FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'in' AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND project_id IS NOT NULL GROUP BY project_id
    ) pi ON pi.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) as total FROM biz_payments WHERE tenant_id = ? AND space_id = ? AND direction = 'out' AND deleted_at IS NULL AND ${ACTIVE_STATUS} AND project_id IS NOT NULL GROUP BY project_id
    ) po ON po.project_id = p.id
    WHERE p.tenant_id = ? AND p.space_id = ?
    ORDER BY outstanding DESC
  `).all(TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId, TENANT, ctx.spaceId) as Record<string, unknown>[]
  return rows.map(r => toCamel<ProjectReconciliationItem>(r))
}

// ── Create-From helpers (v0.6 document linking) ─────────────────────

export interface CreateFromResult<T> {
  doc: T
  link: DocLink
}

/** Create a logistics draft pre-filled from an existing sale */
export function createLogisticsFromSale(saleId: string): CreateFromResult<BizLogisticsRecord> {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_sales WHERE id = ? AND deleted_at IS NULL').get(saleId) as Record<string, unknown> | undefined
  if (!row) throw new Error('销售单不存在')
  const sale = toCamel<BizSale>(row)
  if (sale.docStatus !== 'confirmed') throw new Error('只有已确认的销售单可以创建下游单据')

  const doc = createLogistics({
    date: sale.date,
    projectId: sale.projectId,
    tonnage: sale.tonnage,
    notes: `由销售单创建`,
    spaceId: row.space_id as string ?? undefined,
  })

  // Mark source on the newly created doc
  db.prepare('UPDATE biz_logistics SET source_type = ?, source_id = ? WHERE id = ?').run('sale', saleId, doc.id)
  doc.sourceType = 'sale'
  doc.sourceId = saleId

  const link = createDocLink('sale', saleId, 'logistics', doc.id)
  logger.info(`CreateFrom: logistics/${doc.id} ← sale/${saleId}`)
  return { doc, link }
}

/** Create an outgoing invoice draft pre-filled from an existing sale */
export function createInvoiceFromSale(saleId: string): CreateFromResult<BizInvoice> {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_sales WHERE id = ? AND deleted_at IS NULL').get(saleId) as Record<string, unknown> | undefined
  if (!row) throw new Error('销售单不存在')
  const sale = toCamel<BizSale>(row)
  if (sale.docStatus !== 'confirmed') throw new Error('只有已确认的销售单可以创建下游单据')

  const doc = createInvoice({
    date: new Date().toISOString().slice(0, 10),
    direction: 'out',
    counterpartyId: sale.customerId,
    amount: sale.totalAmount,
    relatedIds: [saleId],
    notes: `由销售单创建`,
    spaceId: row.space_id as string ?? undefined,
  })

  db.prepare('UPDATE biz_invoices SET source_type = ?, source_id = ? WHERE id = ?').run('sale', saleId, doc.id)
  doc.sourceType = 'sale'
  doc.sourceId = saleId

  const link = createDocLink('sale', saleId, 'invoice', doc.id)
  logger.info(`CreateFrom: invoice/${doc.id} ← sale/${saleId}`)
  return { doc, link }
}

/** Create an incoming invoice draft pre-filled from an existing purchase */
export function createInvoiceFromPurchase(purchaseId: string): CreateFromResult<BizInvoice> {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM biz_purchases WHERE id = ? AND deleted_at IS NULL').get(purchaseId) as Record<string, unknown> | undefined
  if (!row) throw new Error('采购单不存在')
  const purchase = toCamel<BizPurchase>(row)
  if (purchase.docStatus !== 'confirmed') throw new Error('只有已确认的采购单可以创建下游单据')

  const doc = createInvoice({
    date: new Date().toISOString().slice(0, 10),
    direction: 'in',
    counterpartyId: purchase.supplierId,
    amount: purchase.totalAmount,
    relatedIds: [purchaseId],
    notes: `由采购单创建`,
    spaceId: row.space_id as string ?? undefined,
  })

  db.prepare('UPDATE biz_invoices SET source_type = ?, source_id = ? WHERE id = ?').run('purchase', purchaseId, doc.id)
  doc.sourceType = 'purchase'
  doc.sourceId = purchaseId

  const link = createDocLink('purchase', purchaseId, 'invoice', doc.id)
  logger.info(`CreateFrom: invoice/${doc.id} ← purchase/${purchaseId}`)
  return { doc, link }
}

/** Link an existing payment to an invoice (for reconciliation) */
export function linkPaymentToInvoice(paymentId: string, invoiceId: string): DocLink {
  const link = createDocLink('invoice', invoiceId, 'payment', paymentId)
  logger.info(`DocLink: payment/${paymentId} → invoice/${invoiceId}`)
  return link
}

// ── v0.7: Purchase with Line Items ──────────────────────────────────

export interface CreatePurchaseLineInput {
  productId?: string
  brand?: string
  material?: string
  spec?: string
  measureUnit?: string
  weighMode?: '理计' | '过磅'
  bundleCount?: number
  weightPerPc?: number
  quantity: number
  unitPrice: number
  taxInclusive?: boolean
  subtotal: number
  notes?: string
}

export interface CreatePurchaseWithLinesInput {
  date: string
  location?: string
  supplierId: string
  docNo?: string
  projectId?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  lines: CreatePurchaseLineInput[]
  payment?: {
    amount: number
    method?: string
    notes?: string
  }
  spaceId?: string
}

/** Internal core: creates purchase header + lines + optional payment. Called within an existing transaction. */
function _createPurchaseCore(
  db: ReturnType<typeof getDatabase>,
  input: CreatePurchaseWithLinesInput,
  tradeId?: string,
): { purchase: BizPurchase; lines: BizPurchaseLine[]; paymentId?: string } {
  const purchaseId = ulid()
  const ts = now()

  const totalTonnage = input.lines.reduce((sum, l) => sum + l.quantity, 0)
  const totalAmount = input.lines.reduce((sum, l) => sum + l.subtotal, 0)
  const avgUnitPrice = totalTonnage > 0 ? Math.round((totalAmount / totalTonnage) * 100) / 100 : 0

  const paidAmount = input.payment?.amount ?? 0
  const unpaidAmount = Math.round((totalAmount - paidAmount) * 100) / 100
  const paymentStatus = paidAmount <= 0 ? 'unpaid' : (paidAmount >= totalAmount ? 'paid' : 'partial')

  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, space_id, date, order_no, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, project_id, invoice_status, payment_status, notes, bubble_id, raw_input, created_by, doc_status, location, doc_no, paid_amount, unpaid_amount, payment_method, payment_notes, trade_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    purchaseId, TENANT, input.spaceId ?? null, input.date, null,
    input.supplierId,
    input.lines[0]?.productId ?? null,
    null,
    totalTonnage, avgUnitPrice, totalAmount,
    input.projectId ?? null,
    paymentStatus,
    input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null,
    input.location ?? null, input.docNo ?? null,
    paidAmount, unpaidAmount,
    input.payment?.method ?? null, input.payment?.notes ?? null,
    tradeId ?? null,
    ts, ts,
  )

  const insertLine = db.prepare(`
    INSERT INTO biz_purchase_lines (id, purchase_id, line_no, product_id, brand, material, spec, measure_unit, weigh_mode, bundle_count, weight_per_pc, quantity, unit_price, tax_inclusive, subtotal, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const lines: BizPurchaseLine[] = input.lines.map((line, i) => {
    const lineId = ulid()
    insertLine.run(
      lineId, purchaseId, i + 1,
      line.productId ?? null,
      line.brand ?? null, line.material ?? null, line.spec ?? null,
      line.measureUnit ?? '吨', line.weighMode ?? '理计',
      line.bundleCount ?? null, line.weightPerPc ?? null,
      line.quantity, line.unitPrice,
      (line.taxInclusive ?? true) ? 1 : 0,
      line.subtotal, line.notes ?? null,
      ts, ts,
    )
    return {
      id: lineId, purchaseId, lineNo: i + 1,
      productId: line.productId, brand: line.brand, material: line.material, spec: line.spec,
      measureUnit: line.measureUnit ?? '吨', weighMode: line.weighMode ?? '理计',
      bundleCount: line.bundleCount, weightPerPc: line.weightPerPc,
      quantity: line.quantity, unitPrice: line.unitPrice,
      taxInclusive: line.taxInclusive ?? true,
      subtotal: line.subtotal, notes: line.notes,
      createdAt: ts, updatedAt: ts,
    }
  })

  let paymentId: string | undefined
  if (paidAmount > 0) {
    const payment = createPayment({
      date: input.date,
      direction: 'out',
      counterpartyId: input.supplierId,
      projectId: input.projectId,
      amount: paidAmount,
      method: input.payment?.method,
      notes: input.payment?.notes ?? '采购付款',
      createdBy: input.createdBy,
      spaceId: input.spaceId,
    })
    paymentId = payment.id
    createDocLink('purchase', purchaseId, 'payment', payment.id)
  }

  const purchase = toCamel<BizPurchase>(
    db.prepare('SELECT * FROM biz_purchases WHERE id = ?').get(purchaseId) as Record<string, unknown>
  )
  return { purchase, lines, paymentId }
}

export function createPurchaseWithLines(input: CreatePurchaseWithLinesInput): { purchase: BizPurchase; lines: BizPurchaseLine[]; paymentId?: string } {
  const db = getDatabase()
  return db.transaction(() => _createPurchaseCore(db, input))()
}

export function getPurchaseLines(purchaseId: string): BizPurchaseLine[] {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT * FROM biz_purchase_lines WHERE purchase_id = ? ORDER BY line_no'
  ).all(purchaseId) as Record<string, unknown>[]
  return rows.map(r => {
    const line = toCamel<BizPurchaseLine>(r)
    line.taxInclusive = (r.tax_inclusive as number) === 1
    return line
  })
}

export function updatePurchaseLines(purchaseId: string, lines: CreatePurchaseLineInput[]): BizPurchaseLine[] {
  const db = getDatabase()
  const ts = now()

  return db.transaction(() => {
    db.prepare('DELETE FROM biz_purchase_lines WHERE purchase_id = ?').run(purchaseId)

    const insertLine = db.prepare(`
      INSERT INTO biz_purchase_lines (id, purchase_id, line_no, product_id, brand, material, spec, measure_unit, weigh_mode, bundle_count, weight_per_pc, quantity, unit_price, tax_inclusive, subtotal, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const result: BizPurchaseLine[] = lines.map((line, i) => {
      const lineId = ulid()
      insertLine.run(
        lineId, purchaseId, i + 1,
        line.productId ?? null,
        line.brand ?? null, line.material ?? null, line.spec ?? null,
        line.measureUnit ?? '吨', line.weighMode ?? '理计',
        line.bundleCount ?? null, line.weightPerPc ?? null,
        line.quantity, line.unitPrice,
        (line.taxInclusive ?? true) ? 1 : 0,
        line.subtotal, line.notes ?? null,
        ts, ts,
      )
      return {
        id: lineId, purchaseId, lineNo: i + 1,
        productId: line.productId, brand: line.brand, material: line.material, spec: line.spec,
        measureUnit: line.measureUnit ?? '吨', weighMode: line.weighMode ?? '理计',
        bundleCount: line.bundleCount, weightPerPc: line.weightPerPc,
        quantity: line.quantity, unitPrice: line.unitPrice,
        taxInclusive: line.taxInclusive ?? true,
        subtotal: line.subtotal, notes: line.notes,
        createdAt: ts, updatedAt: ts,
      }
    })

    const totalTonnage = lines.reduce((sum, l) => sum + l.quantity, 0)
    const totalAmount = lines.reduce((sum, l) => sum + l.subtotal, 0)
    const avgUnitPrice = totalTonnage > 0 ? Math.round((totalAmount / totalTonnage) * 100) / 100 : 0
    db.prepare(
      'UPDATE biz_purchases SET tonnage = ?, unit_price = ?, total_amount = ?, product_id = ?, updated_at = ? WHERE id = ?'
    ).run(totalTonnage, avgUnitPrice, totalAmount, lines[0]?.productId ?? null, ts, purchaseId)

    return result
  })()
}

// ── v0.7: Sale with Line Items ──────────────────────────────────────

export interface CreateSaleWithLinesInput {
  date: string
  location?: string
  customerId: string
  supplierId?: string
  docNo?: string
  projectId?: string
  logisticsProvider?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  lines: CreatePurchaseLineInput[]
  payment?: {
    amount: number
    method?: string
    notes?: string
  }
  spaceId?: string
}

/** Internal core: creates sale header + lines + optional payment. Called within an existing transaction. */
function _createSaleCore(
  db: ReturnType<typeof getDatabase>,
  input: CreateSaleWithLinesInput,
  tradeId?: string,
): { sale: BizSale; lines: BizSaleLine[]; paymentId?: string } {
  const saleId = ulid()
  const ts = now()

  const totalTonnage = input.lines.reduce((sum, l) => sum + l.quantity, 0)
  const totalAmount = input.lines.reduce((sum, l) => sum + l.subtotal, 0)
  const avgUnitPrice = totalTonnage > 0 ? Math.round((totalAmount / totalTonnage) * 100) / 100 : 0

  const paidAmount = input.payment?.amount ?? 0
  const unpaidAmount = Math.round((totalAmount - paidAmount) * 100) / 100
  const collectionStatus = paidAmount <= 0 ? 'uncollected' : (paidAmount >= totalAmount ? 'collected' : 'partial')

  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, space_id, date, order_no, customer_id, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, cost_price, cost_amount, profit, project_id, logistics_provider, invoice_status, collection_status, notes, bubble_id, raw_input, created_by, doc_status, location, doc_no, paid_amount, unpaid_amount, payment_method, payment_notes, trade_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    saleId, TENANT, input.spaceId ?? null, input.date, null,
    input.customerId, input.supplierId ?? null,
    input.lines[0]?.productId ?? null, null,
    totalTonnage, avgUnitPrice, totalAmount,
    null, null, null,
    input.projectId ?? null, input.logisticsProvider ?? null,
    collectionStatus,
    input.notes ?? null, input.bubbleId ?? null, input.rawInput ?? null, input.createdBy ?? null,
    input.location ?? null, input.docNo ?? null,
    paidAmount, unpaidAmount,
    input.payment?.method ?? null, input.payment?.notes ?? null,
    tradeId ?? null,
    ts, ts,
  )

  const insertLine = db.prepare(`
    INSERT INTO biz_sale_lines (id, sale_id, line_no, product_id, brand, material, spec, measure_unit, weigh_mode, bundle_count, weight_per_pc, quantity, unit_price, tax_inclusive, subtotal, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const lines: BizSaleLine[] = input.lines.map((line, i) => {
    const lineId = ulid()
    insertLine.run(
      lineId, saleId, i + 1,
      line.productId ?? null,
      line.brand ?? null, line.material ?? null, line.spec ?? null,
      line.measureUnit ?? '吨', line.weighMode ?? '理计',
      line.bundleCount ?? null, line.weightPerPc ?? null,
      line.quantity, line.unitPrice,
      (line.taxInclusive ?? true) ? 1 : 0,
      line.subtotal, line.notes ?? null,
      ts, ts,
    )
    return {
      id: lineId, saleId, lineNo: i + 1,
      productId: line.productId, brand: line.brand, material: line.material, spec: line.spec,
      measureUnit: line.measureUnit ?? '吨', weighMode: line.weighMode ?? '理计',
      bundleCount: line.bundleCount, weightPerPc: line.weightPerPc,
      quantity: line.quantity, unitPrice: line.unitPrice,
      taxInclusive: line.taxInclusive ?? true,
      subtotal: line.subtotal, notes: line.notes,
      createdAt: ts, updatedAt: ts,
    }
  })

  let paymentId: string | undefined
  if (paidAmount > 0) {
    const payment = createPayment({
      date: input.date,
      direction: 'in',
      counterpartyId: input.customerId,
      projectId: input.projectId,
      amount: paidAmount,
      method: input.payment?.method,
      notes: input.payment?.notes ?? '销售收款',
      createdBy: input.createdBy,
      spaceId: input.spaceId,
    })
    paymentId = payment.id
    createDocLink('sale', saleId, 'payment', payment.id)
  }

  const sale = toCamel<BizSale>(
    db.prepare('SELECT * FROM biz_sales WHERE id = ?').get(saleId) as Record<string, unknown>
  )
  return { sale, lines, paymentId }
}

export function createSaleWithLines(input: CreateSaleWithLinesInput): { sale: BizSale; lines: BizSaleLine[]; paymentId?: string } {
  const db = getDatabase()
  return db.transaction(() => _createSaleCore(db, input))()
}

// ── v1.0.2: Trade Cascade ───────────────────────────────────────────

export interface CreateTradeInput {
  tradeType: 'purchase' | 'sale'
  date: string
  docNo?: string
  counterpartyId: string
  secondaryCounterpartyId?: string
  contact?: string
  phone?: string
  settlementMethod: SettlementMethod
  creditTermDays?: number
  projectId?: string
  location?: string
  notes?: string
  createdBy?: string
  spaceId?: string
  lines: CreatePurchaseLineInput[]
  payment?: { amount: number; method?: string; notes?: string }
  logistics?: {
    carrier?: string
    freight?: number
    liftingFee?: number
    destination?: string
  }
}

export interface TradeResult {
  trade: BizTrade
  purchase?: BizPurchase
  sale?: BizSale
  lines: (BizPurchaseLine | BizSaleLine)[]
  cascaded: { paymentId?: string; logisticsId?: string }
}

/** Compute due date by adding days to a YYYY-MM-DD string */
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00')
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Create a trade with cascaded records in a single atomic transaction.
 * - Creates biz_trades parent record
 * - Creates purchase or sale with line items
 * - Optionally creates payment (when not credit settlement)
 * - Optionally creates logistics draft (for sales)
 * - Links all records via biz_doc_links and trade_id
 */
export function createTradeWithCascade(input: CreateTradeInput): TradeResult {
  const db = getDatabase()

  return db.transaction(() => {
    const tradeId = ulid()
    const ts = now()

    // Compute totals from lines
    const totalTonnage = input.lines.reduce((sum, l) => sum + l.quantity, 0)
    const totalAmount = input.lines.reduce((sum, l) => sum + l.subtotal, 0)

    // Compute due_date for credit settlement
    const dueDate = (input.settlementMethod === 'credit' && input.creditTermDays)
      ? addDays(input.date, input.creditTermDays)
      : null

    // 1. Create biz_trades parent record
    db.prepare(`
      INSERT INTO biz_trades (id, tenant_id, space_id, trade_type, date, doc_no, counterparty_id, contact, phone, settlement_method, credit_term_days, due_date, total_amount, total_tonnage, project_id, location, logistics_carrier, logistics_freight, logistics_lifting_fee, logistics_destination, notes, doc_status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
    `).run(
      tradeId, TENANT, input.spaceId ?? null,
      input.tradeType, input.date, input.docNo ?? null,
      input.counterpartyId, input.contact ?? null, input.phone ?? null,
      input.settlementMethod, input.creditTermDays ?? null, dueDate,
      totalAmount, totalTonnage,
      input.projectId ?? null, input.location ?? null,
      input.logistics?.carrier ?? null, input.logistics?.freight ?? null,
      input.logistics?.liftingFee ?? null, input.logistics?.destination ?? null,
      input.notes ?? null, input.createdBy ?? null,
      ts, ts,
    )

    ensureFirstInteraction(input.counterpartyId, input.date)

    let purchase: BizPurchase | undefined
    let sale: BizSale | undefined
    let lines: (BizPurchaseLine | BizSaleLine)[] = []
    let paymentId: string | undefined
    let logisticsId: string | undefined

    // Suppress payment for credit settlement
    const paymentInput = input.settlementMethod !== 'credit' ? input.payment : undefined

    // 2. Create purchase or sale with lines
    if (input.tradeType === 'purchase') {
      const result = _createPurchaseCore(db, {
        date: input.date,
        supplierId: input.counterpartyId,
        location: input.location,
        docNo: input.docNo,
        projectId: input.projectId,
        notes: input.notes,
        createdBy: input.createdBy,
        spaceId: input.spaceId,
        lines: input.lines,
        payment: paymentInput,
      }, tradeId)

      purchase = result.purchase
      lines = result.lines
      paymentId = result.paymentId

      // Set settlement fields on purchase
      db.prepare(`
        UPDATE biz_purchases SET settlement_method = ?, credit_term_days = ?, due_date = ? WHERE id = ?
      `).run(input.settlementMethod, input.creditTermDays ?? null, dueDate, purchase.id)

      // Link trade → purchase
      createDocLink('trade', tradeId, 'purchase', purchase.id)

    } else {
      const result = _createSaleCore(db, {
        date: input.date,
        customerId: input.counterpartyId,
        supplierId: input.secondaryCounterpartyId,
        location: input.location,
        docNo: input.docNo,
        projectId: input.projectId,
        logisticsProvider: input.logistics?.carrier,
        notes: input.notes,
        createdBy: input.createdBy,
        spaceId: input.spaceId,
        lines: input.lines,
        payment: paymentInput,
      }, tradeId)

      sale = result.sale
      lines = result.lines
      paymentId = result.paymentId

      // Set settlement fields on sale
      db.prepare(`
        UPDATE biz_sales SET settlement_method = ?, credit_term_days = ?, due_date = ? WHERE id = ?
      `).run(input.settlementMethod, input.creditTermDays ?? null, dueDate, sale.id)

      // Link trade → sale
      createDocLink('trade', tradeId, 'sale', sale.id)

      // 3. Cascade: create draft logistics for sale
      if (input.logistics && (input.logistics.carrier || input.logistics.destination)) {
        const logRecord = createLogistics({
          date: input.date,
          docNo: input.docNo,
          destination: input.logistics.destination,
          tonnage: totalTonnage,
          freight: input.logistics.freight,
          liftingFee: input.logistics.liftingFee,
          notes: '由销售交易自动创建',
          createdBy: input.createdBy,
          spaceId: input.spaceId,
        })
        logisticsId = logRecord.id
        // Set trade_id on logistics
        db.prepare('UPDATE biz_logistics SET trade_id = ? WHERE id = ?').run(tradeId, logisticsId)
        // Link trade → logistics, sale → logistics
        createDocLink('trade', tradeId, 'logistics', logisticsId)
        createDocLink('sale', sale.id, 'logistics', logisticsId)
      }
    }

    // 4. Link trade → payment (if payment was created by _core)
    if (paymentId) {
      createDocLink('trade', tradeId, 'payment', paymentId)
      db.prepare('UPDATE biz_payments SET trade_id = ? WHERE id = ?').run(tradeId, paymentId)
    }

    // 5. Re-read trade record
    const trade = toCamel<BizTrade>(
      db.prepare('SELECT * FROM biz_trades WHERE id = ?').get(tradeId) as Record<string, unknown>
    )

    return { trade, purchase, sale, lines, cascaded: { paymentId, logisticsId } }
  })()
}

export function getSaleLines(saleId: string): BizSaleLine[] {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT * FROM biz_sale_lines WHERE sale_id = ? ORDER BY line_no'
  ).all(saleId) as Record<string, unknown>[]
  return rows.map(r => {
    const line = toCamel<BizSaleLine>(r)
    line.taxInclusive = (r.tax_inclusive as number) === 1
    return line
  })
}

export function updateSaleLines(saleId: string, lines: CreatePurchaseLineInput[]): BizSaleLine[] {
  const db = getDatabase()
  const ts = now()

  return db.transaction(() => {
    db.prepare('DELETE FROM biz_sale_lines WHERE sale_id = ?').run(saleId)

    const insertLine = db.prepare(`
      INSERT INTO biz_sale_lines (id, sale_id, line_no, product_id, brand, material, spec, measure_unit, weigh_mode, bundle_count, weight_per_pc, quantity, unit_price, tax_inclusive, subtotal, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const result: BizSaleLine[] = lines.map((line, i) => {
      const lineId = ulid()
      insertLine.run(
        lineId, saleId, i + 1,
        line.productId ?? null,
        line.brand ?? null, line.material ?? null, line.spec ?? null,
        line.measureUnit ?? '吨', line.weighMode ?? '理计',
        line.bundleCount ?? null, line.weightPerPc ?? null,
        line.quantity, line.unitPrice,
        (line.taxInclusive ?? true) ? 1 : 0,
        line.subtotal, line.notes ?? null,
        ts, ts,
      )
      return {
        id: lineId, saleId, lineNo: i + 1,
        productId: line.productId, brand: line.brand, material: line.material, spec: line.spec,
        measureUnit: line.measureUnit ?? '吨', weighMode: line.weighMode ?? '理计',
        bundleCount: line.bundleCount, weightPerPc: line.weightPerPc,
        quantity: line.quantity, unitPrice: line.unitPrice,
        taxInclusive: line.taxInclusive ?? true,
        subtotal: line.subtotal, notes: line.notes,
        createdAt: ts, updatedAt: ts,
      }
    })

    const totalTonnage = lines.reduce((sum, l) => sum + l.quantity, 0)
    const totalAmount = lines.reduce((sum, l) => sum + l.subtotal, 0)
    const avgUnitPrice = totalTonnage > 0 ? Math.round((totalAmount / totalTonnage) * 100) / 100 : 0
    db.prepare(
      'UPDATE biz_sales SET tonnage = ?, unit_price = ?, total_amount = ?, product_id = ?, updated_at = ? WHERE id = ?'
    ).run(totalTonnage, avgUnitPrice, totalAmount, lines[0]?.productId ?? null, ts, saleId)

    return result
  })()
}

// ── v0.7: Invoice hint (未开票金额查询) ─────────────────────────────

export function getUninvoicedAmount(ctx: BizContext, counterpartyId: string, direction: 'in' | 'out'): { totalAmount: number; invoicedAmount: number; uninvoicedAmount: number } {
  const db = getDatabase()

  let totalAmount = 0
  if (direction === 'out') {
    const row = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total
      FROM biz_sales WHERE tenant_id = ? AND space_id = ? AND customer_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
    `).get(TENANT, ctx.spaceId, counterpartyId) as { total: number }
    totalAmount = row.total
  } else {
    const row = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) as total
      FROM biz_purchases WHERE tenant_id = ? AND space_id = ? AND supplier_id = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
    `).get(TENANT, ctx.spaceId, counterpartyId) as { total: number }
    totalAmount = row.total
  }

  const invoiceDir = direction === 'out' ? 'out' : 'in'
  const invRow = db.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) as total
    FROM biz_invoices WHERE tenant_id = ? AND space_id = ? AND counterparty_id = ? AND direction = ? AND deleted_at IS NULL AND ${ACTIVE_STATUS}
  `).get(TENANT, ctx.spaceId, counterpartyId, invoiceDir) as { total: number }

  const invoicedAmount = invRow.total
  const uninvoicedAmount = Math.round((totalAmount - invoicedAmount) * 100) / 100

  return { totalAmount, invoicedAmount, uninvoicedAmount }
}
