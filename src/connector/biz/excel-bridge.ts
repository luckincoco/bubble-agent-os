/**
 * Excel → Biz Bridge (v0.6.1)
 *
 * When an Excel file is imported, this module takes the same parsed rows
 * and creates structured records in the biz_* tables (purchases, sales,
 * logistics, payments), auto-resolving counterparties/products/projects.
 *
 * Records are created as draft then immediately confirmed so they appear
 * in reports, KPI, and inventory calculations.
 */

import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import { excelDateToISO, normalizeSpec } from '../tools/excel-translator.js'
import { transitionStatus } from './doc-engine.js'
import {
  createProduct, createCounterparty, createProject,
  createPurchase, createSale, createLogistics, createPayment,
  fuzzyFindCounterparty, fuzzyFindProduct, findProjectByName,
  getProductByCode,
  updateCounterparty,
} from './structured-store.js'
import type {
  BizContext,
  CreatePurchaseInput, CreateSaleInput, CreateLogisticsInput, CreatePaymentInput,
} from './structured-store.js'
import type { SheetCategory } from '../tools/excel-translator.js'

// ── Types ────────────────────────────────────────────────────────────

export interface BridgeOptions {
  confirmImmediately?: boolean  // default true
  createdBy?: string
  spaceId?: string
}

export interface BridgeStats {
  purchases: number
  sales: number
  logistics: number
  payments: number
}

export interface BridgeError {
  rowIndex: number
  message: string
}

export interface BridgeResult {
  created: BridgeStats
  skipped: BridgeStats
  errors: BridgeError[]
}

const BRIDGEABLE: SheetCategory[] = ['purchase', 'sales', 'logistics', 'payment']

function emptyStats(): BridgeStats {
  return { purchases: 0, sales: 0, logistics: 0, payments: 0 }
}

// ── Helpers (mirrored from excel-translator, kept local) ────────────

function col(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n]
  }
  return undefined
}

function str(v: unknown): string { return v != null ? String(v) : '' }
function num(v: unknown): number { return v != null && !isNaN(Number(v)) ? Number(v) : 0 }

function safeDate(v: unknown): string {
  if (!v) return ''
  const d = excelDateToISO(v as number | string)
  return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : ''
}

// ── Entity Resolution Cache ─────────────────────────────────────────

class EntityCache {
  private cpCache = new Map<string, string>()
  private prodCache = new Map<string, string>()
  private projCache = new Map<string, string>()
  private ctx: BizContext

  constructor(ctx: BizContext) {
    this.ctx = ctx
  }

  ensureCounterparty(name: string, type: 'supplier' | 'customer' | 'logistics' | 'both'): string {
    if (!name) return ''
    const key = `${name}|${type}`
    const cached = this.cpCache.get(key)
    if (cached) return cached

    // Broad search (any type) first
    const found = fuzzyFindCounterparty(this.ctx, name)
    if (found) {
      // If found with a different type, upgrade to 'both'
      if (found.type !== type && found.type !== 'both') {
        updateCounterparty(found.id, { type: 'both' })
      }
      this.cpCache.set(key, found.id)
      return found.id
    }

    const created = createCounterparty(this.ctx, { name, type })
    this.cpCache.set(key, created.id)
    return created.id
  }

  ensureProduct(brand: string, name: string, specRaw: string): string {
    const spec = normalizeSpec(specRaw) || specRaw
    const key = `${brand}|${name}|${spec}`
    const cached = this.prodCache.get(key)
    if (cached) return cached

    // Generate deterministic code first for exact-match lookup
    const code = [brand, name, spec].filter(Boolean).join('-') || `PROD-${Date.now()}`

    // Try exact code match (handles cross-bridge dedup since UNIQUE is on tenant_id+code)
    const byCode = getProductByCode(code)
    if (byCode) {
      this.prodCache.set(key, byCode.id)
      return byCode.id
    }

    // Try fuzzy match by "brand spec"
    const query = `${brand} ${spec}`.trim()
    if (query) {
      const found = fuzzyFindProduct(this.ctx, query)
      if (found) {
        this.prodCache.set(key, found.id)
        return found.id
      }
    }

    const created = createProduct(this.ctx, {
      code,
      brand: brand || '未知',
      name: name || '钢材',
      spec: spec || specRaw || '未知',
      category: '',
      measureType: '理计',
    })
    this.prodCache.set(key, created.id)
    return created.id
  }

  ensureProject(name: string): string {
    if (!name) return ''
    const cached = this.projCache.get(name)
    if (cached) return cached

    const found = findProjectByName(this.ctx, name)
    if (found) {
      this.projCache.set(name, found.id)
      return found.id
    }

    const created = createProject(this.ctx, { name, status: 'active' })
    this.projCache.set(name, created.id)
    return created.id
  }
}

// ── Row Mappers ─────────────────────────────────────────────────────

function mapPaymentStatus(raw: string): string {
  if (!raw) return 'unpaid'
  if (raw.includes('已付') || raw.includes('已结')) return 'paid'
  if (raw.includes('部分')) return 'partial'
  return 'unpaid'
}

function mapInvoiceStatus(raw: string): string {
  if (!raw) return 'none'
  if (raw.includes('已开') || raw.includes('已收') || raw.includes('已到')) return 'completed'
  if (raw.includes('部分')) return 'partial'
  return 'none'
}

function mapPurchaseRow(row: Record<string, unknown>, cache: EntityCache, createdBy?: string): CreatePurchaseInput | null {
  const date = safeDate(col(row, '采购日期'))
  const tonnage = num(col(row, '吨位'))
  const unitPrice = num(col(row, '单价(元/吨)', '单价'))
  const totalAmount = num(col(row, '金额(元)', '金额'))
  const supplierName = str(col(row, '供应商'))

  // Required fields check
  if (!date || !supplierName || (tonnage <= 0 && totalAmount <= 0)) return null

  const supplierId = cache.ensureCounterparty(supplierName, 'supplier')
  if (!supplierId) return null

  const brand = str(col(row, '品牌'))
  const productName = str(col(row, '商品名称'))
  const specRaw = str(col(row, '规格'))
  const productId = cache.ensureProduct(brand, productName, specRaw)

  const projectName = str(col(row, '关联项目'))
  const projectId = projectName ? cache.ensureProject(projectName) : undefined

  const docNo = str(col(row, '入库单号')) || undefined
  return {
    date,
    orderNo: docNo,
    docNo,
    supplierId,
    productId,
    bundleCount: num(col(row, '件数')) || undefined,
    tonnage: tonnage || (totalAmount && unitPrice ? totalAmount / unitPrice : 0),
    unitPrice: unitPrice || (tonnage && totalAmount ? totalAmount / tonnage : 0),
    totalAmount: totalAmount || tonnage * unitPrice,
    projectId: projectId || undefined,
    paymentStatus: mapPaymentStatus(str(col(row, '付款状态'))),
    invoiceStatus: mapInvoiceStatus(str(col(row, '发票状态'))),
    createdBy,
  }
}

function mapSaleRow(row: Record<string, unknown>, cache: EntityCache, createdBy?: string): CreateSaleInput | null {
  const date = safeDate(col(row, '销售日期'))
  const tonnage = num(col(row, '吨位'))
  const unitPrice = num(col(row, '销售单价'))
  const totalAmount = num(col(row, '销售金额'))
  const customerName = str(col(row, '客户/项目'))

  if (!date || !customerName || (tonnage <= 0 && totalAmount <= 0)) return null

  const customerId = cache.ensureCounterparty(customerName, 'customer')
  if (!customerId) return null

  const supplierName = str(col(row, '供应商'))
  const supplierId = supplierName ? cache.ensureCounterparty(supplierName, 'supplier') : undefined

  const brand = str(col(row, '品牌'))
  const productName = str(col(row, '商品名称'))
  const specRaw = str(col(row, '规格'))
  const productId = cache.ensureProduct(brand, productName, specRaw)

  const costPrice = num(col(row, '成本价(自动)', '成本价(手动)', '成本价'))
  const profit = num(col(row, '单笔毛利'))

  const docNo = str(col(row, '销售单号')) || undefined
  return {
    date,
    orderNo: docNo,
    docNo,
    customerId,
    supplierId: supplierId || undefined,
    productId,
    bundleCount: num(col(row, '件数')) || undefined,
    tonnage: tonnage || (totalAmount && unitPrice ? totalAmount / unitPrice : 0),
    unitPrice: unitPrice || (tonnage && totalAmount ? totalAmount / tonnage : 0),
    totalAmount: totalAmount || tonnage * unitPrice,
    costPrice: costPrice || undefined,
    costAmount: costPrice && tonnage ? costPrice * tonnage : undefined,
    profit: profit || undefined,
    logisticsProvider: str(col(row, '物流商')) || undefined,
    createdBy,
  }
}

function mapLogisticsRow(row: Record<string, unknown>, cache: EntityCache, createdBy?: string): CreateLogisticsInput | null {
  const date = safeDate(col(row, '装车日期'))
  if (!date) return null

  const carrierName = str(col(row, '托运公司'))
  const carrierId = carrierName ? cache.ensureCounterparty(carrierName, 'logistics') : undefined

  const freight = num(col(row, '运费(元)', '运费'))
  const liftingFee = num(col(row, '吊费(元)', '吊费'))
  const totalFee = num(col(row, '费用合计'))
  const tonnage = num(col(row, '吨位'))

  // At least need carrier or destination
  const dest = str(col(row, '目的地/项目'))
  if (!carrierName && !dest) return null

  const settlement = str(col(row, '结算状态'))

  const docNo = str(col(row, '运单号')) || undefined
  return {
    date,
    waybillNo: docNo,
    docNo,
    carrierId: carrierId || undefined,
    destination: dest || undefined,
    tonnage: tonnage || undefined,
    freight,
    liftingFee,
    totalFee: totalFee || (freight + liftingFee),
    driver: str(col(row, '司机')) || undefined,
    licensePlate: str(col(row, '车牌号')) || undefined,
    settlementStatus: settlement.includes('已结') ? 'paid' : 'unpaid',
    createdBy,
  }
}

function mapPaymentRow(row: Record<string, unknown>, cache: EntityCache, createdBy?: string): CreatePaymentInput | null {
  const date = safeDate(col(row, '日期'))
  const amount = num(col(row, '金额(元)', '金额'))
  const typeName = str(col(row, '类型'))
  const target = str(col(row, '对象(客户/供应商)', '对象'))

  if (!date || amount <= 0 || !target) return null

  const direction: 'in' | 'out' = /收|回款/.test(typeName) ? 'in' : 'out'
  const counterpartyId = cache.ensureCounterparty(target, direction === 'out' ? 'supplier' : 'customer')
  if (!counterpartyId) return null

  const projectName = str(col(row, '关联项目'))
  const projectId = projectName ? cache.ensureProject(projectName) : undefined

  return {
    date,
    docNo: str(col(row, '单据号')) || undefined,
    direction,
    counterpartyId,
    projectId: projectId || undefined,
    amount,
    method: str(col(row, '方式')) || undefined,
    notes: str(col(row, '摘要')) || undefined,
    createdBy,
  }
}

// ── Dedup Queries ───────────────────────────────────────────────────

const TENANT = 'default'

function isDuplicatePurchase(date: string, supplierId: string, tonnage: number, totalAmount: number): boolean {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id FROM biz_purchases WHERE tenant_id = ? AND date = ? AND supplier_id = ? AND ABS(tonnage - ?) < 0.01 AND ABS(total_amount - ?) < 0.01 AND deleted_at IS NULL LIMIT 1',
  ).get(TENANT, date, supplierId, tonnage, totalAmount)
  return !!row
}

function isDuplicateSale(date: string, customerId: string, tonnage: number, totalAmount: number): boolean {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id FROM biz_sales WHERE tenant_id = ? AND date = ? AND customer_id = ? AND ABS(tonnage - ?) < 0.01 AND ABS(total_amount - ?) < 0.01 AND deleted_at IS NULL LIMIT 1',
  ).get(TENANT, date, customerId, tonnage, totalAmount)
  return !!row
}

function isDuplicateLogistics(date: string, carrierId: string | undefined, tonnage: number, totalFee: number): boolean {
  if (!carrierId) return false
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id FROM biz_logistics WHERE tenant_id = ? AND date = ? AND carrier_id = ? AND ABS(COALESCE(tonnage,0) - ?) < 0.01 AND ABS(total_fee - ?) < 0.01 AND deleted_at IS NULL LIMIT 1',
  ).get(TENANT, date, carrierId, tonnage, totalFee)
  return !!row
}

function isDuplicatePayment(date: string, counterpartyId: string, amount: number, direction: string): boolean {
  const db = getDatabase()
  const row = db.prepare(
    'SELECT id FROM biz_payments WHERE tenant_id = ? AND date = ? AND counterparty_id = ? AND ABS(amount - ?) < 0.01 AND direction = ? AND deleted_at IS NULL LIMIT 1',
  ).get(TENANT, date, counterpartyId, amount, direction)
  return !!row
}

// ── Main Bridge Function ────────────────────────────────────────────

type DocType = 'purchase' | 'sale' | 'logistics' | 'payment'
type StatsKey = 'purchases' | 'sales' | 'logistics' | 'payments'

const CATEGORY_TO_DOCTYPE: Record<string, DocType> = {
  purchase: 'purchase',
  sales: 'sale',
  logistics: 'logistics',
  payment: 'payment',
}

const DOCTYPE_TO_STATS: Record<DocType, StatsKey> = {
  purchase: 'purchases',
  sale: 'sales',
  logistics: 'logistics',
  payment: 'payments',
}

// ── Fill-down for merged-cell Excel patterns ───────────────────────
// In steel-trade Excel, the first row of a group has date/supplier/project,
// subsequent rows in the same group leave those cells empty (merged cells).
// This function fills empty cells from the previous row's value.
const FILL_DOWN_KEYS: Record<string, string[]> = {
  purchase: ['采购日期', '供应商', '关联项目', '付款状态'],
  sales: ['销售日期', '供应商', '客户/项目', '关联项目'],
  logistics: ['装车日期', '物流商', '关联项目', '目的地'],
  payment: ['日期', '对象(客户/供应商)', '对象', '类型', '关联项目'],
}

function fillDown(rows: Record<string, unknown>[], category: SheetCategory): void {
  const keys = FILL_DOWN_KEYS[category]
  if (!keys) return
  for (let i = 1; i < rows.length; i++) {
    for (const k of keys) {
      if ((rows[i]![k] == null || rows[i]![k] === '') && rows[i - 1]![k] != null) {
        rows[i]![k] = rows[i - 1]![k]
      }
    }
  }
}

export function bridgeExcelSheet(
  rows: Record<string, unknown>[],
  category: SheetCategory,
  options?: BridgeOptions,
): BridgeResult {
  const result: BridgeResult = {
    created: emptyStats(),
    skipped: emptyStats(),
    errors: [],
  }

  if (!BRIDGEABLE.includes(category)) return result

  // Pre-process: fill down merged-cell gaps
  fillDown(rows, category)

  const confirm = options?.confirmImmediately !== false
  const createdBy = options?.createdBy ?? 'excel-import'
  const spaceId = options?.spaceId
  const ctx: BizContext = { spaceId: spaceId ?? '' }
  const cache = new EntityCache(ctx)
  const docType = CATEGORY_TO_DOCTYPE[category]!
  const statsKey = DOCTYPE_TO_STATS[docType]
  const db = getDatabase()

  const run = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i]!
        let record: { id: string } | null = null

        switch (category) {
          case 'purchase': {
            const input = mapPurchaseRow(row, cache, createdBy)
            if (!input) { result.skipped[statsKey]++; continue }
            if (isDuplicatePurchase(input.date, input.supplierId, input.tonnage, input.totalAmount)) {
              result.skipped[statsKey]++; continue
            }
            input.spaceId = spaceId
            record = createPurchase(input)
            break
          }
          case 'sales': {
            const input = mapSaleRow(row, cache, createdBy)
            if (!input) { result.skipped[statsKey]++; continue }
            if (isDuplicateSale(input.date, input.customerId, input.tonnage, input.totalAmount)) {
              result.skipped[statsKey]++; continue
            }
            input.spaceId = spaceId
            record = createSale(input)
            break
          }
          case 'logistics': {
            const input = mapLogisticsRow(row, cache, createdBy)
            if (!input) { result.skipped[statsKey]++; continue }
            if (isDuplicateLogistics(input.date, input.carrierId, input.tonnage ?? 0, input.totalFee ?? 0)) {
              result.skipped[statsKey]++; continue
            }
            input.spaceId = spaceId
            record = createLogistics(input)
            break
          }
          case 'payment': {
            const input = mapPaymentRow(row, cache, createdBy)
            if (!input) { result.skipped[statsKey]++; continue }
            if (isDuplicatePayment(input.date, input.counterpartyId, input.amount, input.direction)) {
              result.skipped[statsKey]++; continue
            }
            input.spaceId = spaceId
            record = createPayment(input)
            break
          }
        }

        if (record && confirm) {
          const tr = transitionStatus(docType, record.id, 'confirmed')
          if (!tr.ok) {
            result.errors.push({ rowIndex: i, message: `transition failed: ${tr.error}` })
          }
        }

        if (record) result.created[statsKey]++
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (result.errors.length < 5) {
          logger.error(`ExcelBridge: ${category} row ${i} error: ${msg}`)
        }
        result.errors.push({ rowIndex: i, message: msg })
      }
    }
  })

  try {
    run()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(`ExcelBridge: transaction failed for ${category}:`, msg)
    result.errors.push({ rowIndex: -1, message: `Transaction failed: ${msg}` })
  }

  const total = result.created[statsKey]
  if (total > 0) {
    logger.info(`ExcelBridge: ${category} → ${total} records created, ${result.skipped[statsKey]} skipped, ${result.errors.length} errors`)
  }

  return result
}
