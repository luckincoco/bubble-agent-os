#!/usr/bin/env npx tsx
/**
 * 华瑞隆进销存 Excel → 结构化 biz_* 表迁移脚本
 * 读取 Excel 各工作表，通过 /api/biz/* 端点写入结构化数据库。
 *
 * Usage:
 *   npx tsx scripts/migrate-excel.ts [excel-path]
 *
 * Default Excel path: ~/Desktop/2026年华瑞隆资料互导（win-mac)/2026华瑞隆进销存管理（终版）_1.0.0(1).0.0.xlsx
 */

import XLSX from 'xlsx'
import { readFileSync } from 'node:fs'

// ── Configuration (from env) ─────────────────────────────────────
const API_BASE = process.env.API_BASE
const API_KEY = process.env.API_KEY
if (!API_BASE || !API_KEY) {
  console.error('Required env vars: API_BASE, API_KEY')
  process.exit(1)
}
const DEFAULT_EXCEL = process.env.EXCEL_PATH || ''

const excelPath = process.argv[2] || DEFAULT_EXCEL

// ── Helpers ──────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${method} ${path} → ${res.status}: ${text}`)
  }
  return res.json()
}

function fmtDate(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number') {
    // Excel serial date number
    const d = XLSX.SSF.parse_date_code(v)
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  return String(v || '')
}

function num(v: unknown, decimals = 2): number {
  if (v == null || v === '') return 0
  const n = Number(v)
  return isNaN(n) ? 0 : Math.round(n * 10 ** decimals) / 10 ** decimals
}

function str(v: unknown): string {
  if (v == null) return ''
  return String(v).trim()
}

function readSheet(wb: XLSX.WorkBook, name: string): Record<string, unknown>[][] {
  const ws = wb.Sheets[name]
  if (!ws) { console.warn(`  [WARN] Sheet "${name}" not found`); return [] }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: null })
  // Skip header row, filter empty rows
  return rows.slice(1).filter(r => Array.isArray(r) && r.some(c => c != null && c !== '')) as any
}

// ── ID Maps (name → id) ─────────────────────────────────────────

const productMap = new Map<string, string>()   // code → id
const supplierMap = new Map<string, string>()  // name → id
const customerMap = new Map<string, string>()  // name → id
const logisticsMap = new Map<string, string>() // name → id
const projectMap = new Map<string, string>()   // name → id
const counterpartyMap = new Map<string, string>() // name → id (any type)

async function ensureCounterparty(name: string, type: 'supplier' | 'customer' | 'logistics'): Promise<string> {
  const map = type === 'supplier' ? supplierMap : type === 'customer' ? customerMap : logisticsMap
  if (map.has(name)) return map.get(name)!
  if (counterpartyMap.has(name)) return counterpartyMap.get(name)!

  const { data } = await api('POST', '/api/biz/counterparties', { name, type })
  map.set(name, data.id)
  counterpartyMap.set(name, data.id)
  return data.id
}

async function ensureProduct(code: string, brand: string, name: string, spec: string, extra: Record<string, unknown> = {}): Promise<string> {
  if (productMap.has(code)) return productMap.get(code)!
  const { data } = await api('POST', '/api/biz/products', {
    code, brand: brand || '', name: name || '', spec: spec || '',
    category: '螺纹钢', measureType: extra.measureType || '理计',
    weightPerBundle: extra.weightPerBundle || null,
    piecesPerBundle: extra.piecesPerBundle || null,
    liftingFee: extra.liftingFee || null,
  })
  productMap.set(code, data.id)
  return data.id
}

async function ensureProject(name: string, extra: Record<string, unknown> = {}): Promise<string> {
  if (projectMap.has(name)) return projectMap.get(name)!
  const { data } = await api('POST', '/api/biz/projects', { name, ...extra, status: extra.status || 'active' })
  projectMap.set(name, data.id)
  return data.id
}

// ── Phase 1: Master Data ─────────────────────────────────────────

async function migrateProducts(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '产品信息')
  let count = 0
  for (const row of rows) {
    const code = str(row[1])
    if (!code) continue
    const brand = str(row[2])
    const name = str(row[3])
    const spec = str(row[4])
    const measureType = str(row[5]) || '理计'
    const weightPerBundle = num(row[6], 3)
    const piecesPerBundle = num(row[7], 0)
    const liftingFee = num(row[8])

    try {
      await ensureProduct(code, brand, name, spec, { measureType, weightPerBundle, piecesPerBundle, liftingFee })
      count++
    } catch (e: any) {
      if (!e.message.includes('409') && !e.message.includes('UNIQUE')) {
        console.warn(`  [WARN] product ${code}: ${e.message}`)
      }
    }
  }
  console.log(`[产品信息] ${count} products created`)
}

async function migrateSuppliers(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '供应商信息')
  let count = 0
  for (const row of rows) {
    const name = str(row[1])
    if (!name) continue
    try {
      await ensureCounterparty(name, 'supplier')
      count++
    } catch (e: any) {
      console.warn(`  [WARN] supplier ${name}: ${e.message}`)
    }
  }
  console.log(`[供应商信息] ${count} suppliers created`)
}

async function migrateCustomersAndProjects(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '客户与项目')
  let pCount = 0, cCount = 0
  for (const row of rows) {
    const name = str(row[1])
    if (!name) continue
    try {
      const customerId = await ensureCounterparty(name, 'customer')
      cCount++
      await ensureProject(name, {
        customerId,
        contractNo: str(row[2]),
        address: str(row[3]),
        builder: str(row[4]),
        developer: str(row[5]),
        contact: str(row[6]),
        phone: str(row[7]),
        status: str(row[8]) || 'active',
      })
      pCount++
    } catch (e: any) {
      console.warn(`  [WARN] project ${name}: ${e.message}`)
    }
  }
  console.log(`[客户与项目] ${cCount} customers, ${pCount} projects created`)
}

async function migrateLogisticsProviders(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '物流基础信息')
  let count = 0
  for (const row of rows) {
    const name = str(row[1])
    if (!name) continue
    try {
      await ensureCounterparty(name, 'logistics')
      count++
    } catch (e: any) {
      console.warn(`  [WARN] logistics provider ${name}: ${e.message}`)
    }
  }
  console.log(`[物流基础信息] ${count} logistics providers created`)
}

// ── Phase 2: Transaction Data ────────────────────────────────────

async function migratePurchases(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '采购录入')
  let count = 0, skipped = 0
  let lastDate = '', lastOrder = ''

  for (const row of rows) {
    const dateVal = row[0] || lastDate
    const orderNo = row[1] || lastOrder
    const supplier = str(row[2])
    const productCode = str(row[3])
    const tonnage = num(row[9], 3)
    const unitPrice = num(row[10])
    const amount = num(row[11])

    if (dateVal) lastDate = dateVal as string
    if (orderNo) lastOrder = orderNo as string

    if ((!tonnage && !amount) || !productCode) { skipped++; continue }

    const dateStr = fmtDate(dateVal)
    if (!dateStr || dateStr === '0' || dateStr.length < 8) { skipped++; continue }

    try {
      const supplierId = supplier ? await ensureCounterparty(supplier, 'supplier') : await ensureCounterparty('未知供应商', 'supplier')
      const productId = productMap.get(productCode)
      if (!productId) {
        // Auto-create product from purchase row
        const brand = str(row[4])
        const name = str(row[5])
        const spec = str(row[6])
        await ensureProduct(productCode, brand, name, spec, { weightPerBundle: num(row[7], 3) })
      }
      const pid = productMap.get(productCode)!
      const bundleCount = num(row[8], 0) || undefined
      const invoiceStatus = str(row[12]) || 'none'
      const paymentStatus = str(row[13]) || 'unpaid'
      const project = str(row[14])
      const projectId = project ? await ensureProject(project) : undefined

      await api('POST', '/api/biz/purchases', {
        date: dateStr,
        orderNo: str(orderNo),
        supplierId,
        productId: pid,
        bundleCount,
        tonnage: tonnage || num(row[8], 0) * num(row[7], 3),
        unitPrice,
        totalAmount: amount || tonnage * unitPrice,
        projectId,
        invoiceStatus,
        paymentStatus,
      })
      count++
    } catch (e: any) {
      console.warn(`  [WARN] purchase row: ${e.message}`)
    }
  }
  console.log(`[采购录入] ${count} purchases created (${skipped} skipped)`)
}

async function migrateSales(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '销售录入')
  let count = 0, skipped = 0
  let lastDate = '', lastOrder = '', lastSupplier = '', lastCustomer = ''

  for (const row of rows) {
    const dateVal = row[0] || lastDate
    const orderNo = row[1] || lastOrder
    const supplier = str(row[2]) || lastSupplier
    const customer = str(row[3]) || lastCustomer
    const productCode = str(row[4])
    const tonnage = num(row[9], 3)
    const salePrice = num(row[10])
    const saleAmount = num(row[11])

    if (dateVal) lastDate = dateVal as string
    if (orderNo) lastOrder = orderNo as string
    if (str(row[2])) lastSupplier = str(row[2])
    if (str(row[3])) lastCustomer = str(row[3])

    if ((!tonnage && !saleAmount) || !productCode) { skipped++; continue }

    const dateStr = fmtDate(dateVal)
    if (!dateStr || dateStr === '0' || dateStr.length < 8) { skipped++; continue }

    try {
      const customerId = customer ? await ensureCounterparty(customer, 'customer') : await ensureCounterparty('未知客户', 'customer')
      const supplierId = supplier ? await ensureCounterparty(supplier, 'supplier') : undefined

      if (!productMap.has(productCode)) {
        const brand = str(row[5])
        const name = str(row[6])
        const spec = str(row[7])
        await ensureProduct(productCode, brand, name, spec)
      }
      const productId = productMap.get(productCode)!
      const bundleCount = num(row[8], 0) || undefined
      const costAuto = num(row[12])
      const costManual = num(row[13])
      const costPrice = costManual || costAuto || undefined
      const costAmount = num(row[14]) || undefined
      const profit = num(row[15]) || undefined
      const paymentStatus = str(row[16]) || 'uncollected'
      const logistics = str(row[17])
      const projectId = customer ? await ensureProject(customer) : undefined

      await api('POST', '/api/biz/sales', {
        date: dateStr,
        orderNo: str(orderNo),
        customerId,
        supplierId,
        productId,
        bundleCount,
        tonnage,
        unitPrice: salePrice,
        totalAmount: saleAmount || tonnage * salePrice,
        costPrice,
        costAmount,
        profit,
        projectId,
        logisticsProvider: logistics,
        collectionStatus: paymentStatus,
      })
      count++
    } catch (e: any) {
      console.warn(`  [WARN] sale row: ${e.message}`)
    }
  }
  console.log(`[销售录入] ${count} sales created (${skipped} skipped)`)
}

async function migrateLogistics(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '物流录入')
  let count = 0, skipped = 0

  for (const row of rows) {
    const dateVal = row[0]
    if (!dateVal) { skipped++; continue }
    const tonnage = num(row[7], 1)
    const totalFee = num(row[10])
    if (!tonnage && !totalFee) { skipped++; continue }

    const dateStr = fmtDate(dateVal)
    if (!dateStr || dateStr.length < 8) { skipped++; continue }

    try {
      const carrier = str(row[2])
      const carrierId = carrier ? await ensureCounterparty(carrier, 'logistics') : undefined
      const destination = str(row[3])
      const projectId = destination ? await ensureProject(destination) : undefined

      await api('POST', '/api/biz/logistics', {
        date: dateStr,
        waybillNo: str(row[1]),
        carrierId,
        projectId,
        destination,
        tonnage,
        freight: num(row[8]),
        liftingFee: num(row[9]),
        totalFee,
        driver: str(row[5]),
        driverPhone: str(row[6]),
        licensePlate: str(row[4]),
        settlementStatus: str(row[11]) || 'unpaid',
      })
      count++
    } catch (e: any) {
      console.warn(`  [WARN] logistics row: ${e.message}`)
    }
  }
  console.log(`[物流录入] ${count} logistics created (${skipped} skipped)`)
}

async function migratePayments(wb: XLSX.WorkBook) {
  const rows = readSheet(wb, '收付款记录')
  let count = 0, skipped = 0

  for (const row of rows) {
    const dateVal = row[0]
    const amount = num(row[5])
    if (!dateVal || !amount) { skipped++; continue }

    const dateStr = fmtDate(dateVal)
    if (!dateStr || dateStr.length < 8) { skipped++; continue }

    try {
      const payType = str(row[2])
      const target = str(row[3])
      const project = str(row[4])
      const direction: 'in' | 'out' = payType === '收款' ? 'in' : 'out'
      const counterpartyId = target ? await ensureCounterparty(target, 'both' as any) : await ensureCounterparty('未知', 'both' as any)
      const projectId = project ? await ensureProject(project) : undefined

      await api('POST', '/api/biz/payments', {
        date: dateStr,
        docNo: str(row[1]),
        direction,
        counterpartyId,
        projectId,
        amount,
        method: str(row[6]),
        notes: str(row[7]),
      })
      count++
    } catch (e: any) {
      console.warn(`  [WARN] payment row: ${e.message}`)
    }
  }
  console.log(`[收付款记录] ${count} payments created (${skipped} skipped)`)
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📊 华瑞隆 Excel → 结构化数据库 迁移工具`)
  console.log(`Excel: ${excelPath}`)
  console.log(`API:   ${API_BASE}\n`)

  const wb = XLSX.read(readFileSync(excelPath))
  console.log(`Sheets: ${wb.SheetNames.join(', ')}\n`)

  // Phase 1: Master data (order matters — products before transactions)
  console.log('=== Phase 1: Master Data ===')
  await migrateProducts(wb)
  await migrateSuppliers(wb)
  await migrateCustomersAndProjects(wb)
  await migrateLogisticsProviders(wb)

  console.log(`\nMaster data loaded: ${productMap.size} products, ${counterpartyMap.size} counterparties, ${projectMap.size} projects\n`)

  // Phase 2: Transaction data
  console.log('=== Phase 2: Transaction Data ===')
  await migratePurchases(wb)
  await migrateSales(wb)
  await migrateLogistics(wb)
  await migratePayments(wb)

  console.log('\n✅ Migration complete!')
}

main().catch(err => {
  console.error('Migration failed:', err)
  process.exit(1)
})
