/**
 * 华瑞隆 Excel 进销存数据 → Bubble SQLite 一次性导入脚本
 * 
 * 运行方式: node scripts/import-excel.mjs <excel文件路径>
 * 
 * 安全措施:
 * - 全部在一个事务中执行，任何错误自动回滚
 * - 导入前检查表是否已有数据，避免重复导入
 * - 详细日志输出
 */
import Database from 'better-sqlite3'
import XLSX from 'xlsx'
import { ulid } from 'ulid'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── Config ────────────────────────────────────────────────────────
const TENANT = 'default'
const DB_PATH = process.env.DB_PATH
if (!DB_PATH) {
  console.error('Required env var: DB_PATH')
  process.exit(1)
}
const EXCEL_PATH = process.argv[2]

if (!EXCEL_PATH) {
  console.error('Usage: node scripts/import-excel.mjs <excel文件路径>')
  process.exit(1)
}

// ── Helpers ───────────────────────────────────────────────────────

function excelDateToISO(serial) {
  if (!serial || typeof serial === 'string') return serial || ''
  // Excel serial date → JS Date → YYYY-MM-DD
  const utcDays = Math.floor(serial - 25569)
  const d = new Date(utcDays * 86400 * 1000)
  return d.toISOString().slice(0, 10)
}

function parseSheet(wb, sheetName) {
  const ws = wb.Sheets[sheetName]
  if (!ws) throw new Error(`Sheet "${sheetName}" not found`)
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
}

function now() { return Date.now() }

// ── Main ──────────────────────────────────────────────────────────

console.log('=== 华瑞隆 Excel 数据导入 ===')
console.log('数据库:', DB_PATH)
console.log('Excel:', EXCEL_PATH)
console.log('')

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

const wb = XLSX.readFile(EXCEL_PATH)

// Check existing data
const existingProducts = db.prepare('SELECT COUNT(*) as cnt FROM biz_products WHERE tenant_id = ?').get(TENANT).cnt
const existingPurchases = db.prepare('SELECT COUNT(*) as cnt FROM biz_purchases WHERE tenant_id = ?').get(TENANT).cnt
if (existingProducts > 0 || existingPurchases > 0) {
  console.log(`⚠ 数据库已有数据: ${existingProducts} 产品, ${existingPurchases} 采购记录`)
  console.log('  为避免重复，将先清空所有业务数据再导入')
  console.log('')
}

// Prepared statements
const stmts = {
  clearProducts: db.prepare('DELETE FROM biz_products WHERE tenant_id = ?'),
  clearCounterparties: db.prepare('DELETE FROM biz_counterparties WHERE tenant_id = ?'),
  clearProjects: db.prepare('DELETE FROM biz_projects WHERE tenant_id = ?'),
  clearPurchases: db.prepare('DELETE FROM biz_purchases WHERE tenant_id = ?'),
  clearSales: db.prepare('DELETE FROM biz_sales WHERE tenant_id = ?'),
  clearLogistics: db.prepare('DELETE FROM biz_logistics WHERE tenant_id = ?'),
  clearPayments: db.prepare('DELETE FROM biz_payments WHERE tenant_id = ?'),

  insertProduct: db.prepare(`
    INSERT INTO biz_products (id, tenant_id, code, brand, name, spec, spec_display, category, measure_type, weight_per_bundle, pieces_per_bundle, lifting_fee, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `),
  insertCounterparty: db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, name, type, contact, phone, address, bank_info, tax_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `),
  insertProject: db.prepare(`
    INSERT INTO biz_projects (id, tenant_id, name, customer_id, contract_no, address, builder, developer, contact, phone, status, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)
  `),
  insertPurchase: db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, date, order_no, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, project_id, invoice_status, payment_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'excel-import', ?, ?)
  `),
  insertSale: db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, date, order_no, customer_id, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, cost_price, cost_amount, profit, project_id, logistics_provider, invoice_status, collection_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'excel-import', ?, ?)
  `),
  insertLogistics: db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, date, waybill_no, carrier_id, project_id, destination, tonnage, freight, lifting_fee, total_fee, driver, driver_phone, license_plate, settlement_status, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'excel-import', ?, ?)
  `),
  insertPayment: db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, date, doc_no, direction, counterparty_id, project_id, amount, method, reference_no, notes, bubble_id, raw_input, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'excel-import', ?, ?)
  `),
}

// ── Lookup maps (populated during import) ─────────────────────────
const productMap = new Map()   // code → id
const counterpartyMap = new Map() // name → id
const projectMap = new Map()   // name → id

// ── Transaction ───────────────────────────────────────────────────
const importAll = db.transaction(() => {
  const ts = now()

  // Clear existing data
  stmts.clearPayments.run(TENANT)
  stmts.clearLogistics.run(TENANT)
  stmts.clearSales.run(TENANT)
  stmts.clearPurchases.run(TENANT)
  stmts.clearProjects.run(TENANT)
  stmts.clearCounterparties.run(TENANT)
  stmts.clearProducts.run(TENANT)
  console.log('✓ 已清空旧数据')

  // ── 1. 产品信息 ─────────────────────────────────────────────────
  const prodRows = parseSheet(wb, '产品信息')
  let prodCount = 0
  for (let i = 1; i < prodRows.length; i++) {
    const r = prodRows[i]
    const code = String(r[1] || '').trim()
    if (!code) continue
    const id = ulid()
    const brand = String(r[2] || '').trim()
    const name = String(r[3] || '').trim()
    const spec = String(r[4] || '').trim()
    const specDisplay = String(r[5] || '').trim() || null
    const measureType = String(r[6] || '理计').trim()
    const weightPerBundle = r[7] ? Number(r[7]) : null
    const piecesPerBundle = r[8] ? Number(r[8]) : null
    const liftingFee = r[9] ? Number(r[9]) : null
    const category = String(r[10] || '螺纹钢').trim()

    stmts.insertProduct.run(id, TENANT, code, brand, name, spec, specDisplay, category, measureType, weightPerBundle, piecesPerBundle, liftingFee, ts, ts)
    productMap.set(code, id)
    prodCount++
  }
  console.log(`✓ 产品信息: ${prodCount} 条`)

  // ── 2. 供应商信息 ───────────────────────────────────────────────
  const supRows = parseSheet(wb, '供应商信息')
  let supCount = 0
  for (let i = 1; i < supRows.length; i++) {
    const r = supRows[i]
    const name = String(r[1] || '').trim()
    if (!name) continue
    const id = ulid()
    const contact = String(r[4] || '').trim() || null
    const phone = String(r[5] || '').trim() || null
    const address = String(r[3] || '').trim() || null
    const bankInfo = String(r[6] || '').trim() || null

    stmts.insertCounterparty.run(id, TENANT, name, 'supplier', contact, phone, address, bankInfo, null, ts, ts)
    counterpartyMap.set(name, id)
    supCount++
  }
  console.log(`✓ 供应商信息: ${supCount} 条`)

  // ── 3. 物流基础信息 ──────────────────────────────────────────────
  const logBaseRows = parseSheet(wb, '物流基础信息')
  let logBaseCount = 0
  for (let i = 1; i < logBaseRows.length; i++) {
    const r = logBaseRows[i]
    const name = String(r[1] || '').trim()
    if (!name) continue
    // Avoid duplicate if already exists as supplier
    if (counterpartyMap.has(name)) continue
    const id = ulid()
    const phone = String(r[7] || '').trim() || null

    stmts.insertCounterparty.run(id, TENANT, name, 'logistics', null, phone, null, null, null, ts, ts)
    counterpartyMap.set(name, id)
    logBaseCount++
  }
  console.log(`✓ 物流基础信息: ${logBaseCount} 条`)

  // ── 4. 客户与项目 ───────────────────────────────────────────────
  const projRows = parseSheet(wb, '客户与项目')
  let projCount = 0
  for (let i = 1; i < projRows.length; i++) {
    const r = projRows[i]
    const projName = String(r[1] || '').trim()
    if (!projName) continue

    // Create customer counterparty (use project name as customer name, since that's how sales reference it)
    let customerId = counterpartyMap.get(projName)
    if (!customerId) {
      customerId = ulid()
      const contact = String(r[6] || '').trim() || null
      const phone = String(r[7] || '').trim() || null
      const address = String(r[3] || '').trim() || null
      stmts.insertCounterparty.run(customerId, TENANT, projName, 'customer', contact, phone, address, null, null, ts, ts)
      counterpartyMap.set(projName, customerId)
    }

    // Create project
    const projId = ulid()
    const contractNo = String(r[2] || '').trim() || null
    const address = String(r[3] || '').trim() || null
    const builder = String(r[4] || '').trim() || null
    const developer = String(r[5] || '').trim() || null
    const contact = String(r[6] || '').trim() || null
    const phone = String(r[7] || '').trim() || null
    const statusText = String(r[8] || '').trim()
    const status = statusText === '已完工' ? 'completed' : statusText === '暂停' ? 'suspended' : 'active'

    stmts.insertProject.run(projId, TENANT, projName, customerId, contractNo, address, builder, developer, contact, phone, status, ts, ts)
    projectMap.set(projName, projId)
    projCount++
  }
  console.log(`✓ 客户与项目: ${projCount} 条`)

  // ── 5. 采购录入 ─────────────────────────────────────────────────
  const purRows = parseSheet(wb, '采购录入')
  // Headers: 采购日期, 入库单号, 供应商, 商品代码, 品牌, 商品名称, 规格, 件重, 件数, 吨位, 单价(元/吨), 金额(元), 发票状态, 付款状态, 关联项目, 辅助月
  let purCount = 0
  let lastDate = '', lastOrderNo = '', lastSupplier = ''
  for (let i = 1; i < purRows.length; i++) {
    const r = purRows[i]
    const productCode = String(r[3] || '').trim()
    if (!productCode) continue  // skip empty rows

    // Forward-fill date, orderNo, supplier
    if (r[0] !== '' && r[0] !== null && r[0] !== undefined) lastDate = excelDateToISO(r[0])
    if (r[1] !== '' && r[1] !== null) lastOrderNo = String(r[1]).trim()
    if (r[2] !== '' && r[2] !== null) lastSupplier = String(r[2]).trim()

    const date = lastDate
    const orderNo = lastOrderNo || null
    const supplierName = lastSupplier

    // Lookup IDs
    let supplierId = counterpartyMap.get(supplierName)
    if (!supplierId) {
      // Auto-create supplier
      supplierId = ulid()
      stmts.insertCounterparty.run(supplierId, TENANT, supplierName, 'supplier', null, null, null, null, null, ts, ts)
      counterpartyMap.set(supplierName, supplierId)
      console.log(`  + 自动创建供应商: ${supplierName}`)
    }

    let productId = productMap.get(productCode)
    if (!productId) {
      // Auto-create product from row data
      productId = ulid()
      const brand = String(r[4] || '').trim()
      const pname = String(r[5] || '').trim()
      const spec = String(r[6] || '').trim()
      stmts.insertProduct.run(productId, TENANT, productCode, brand, pname, spec, null, '螺纹钢', '理计', null, null, null, ts, ts)
      productMap.set(productCode, productId)
      console.log(`  + 自动创建产品: ${productCode}`)
    }

    const bundleCount = r[8] ? Number(r[8]) : null
    const tonnage = Number(r[9]) || 0
    const unitPrice = Number(r[10]) || 0
    const totalAmount = Number(r[11]) || (tonnage * unitPrice)
    const invoiceStatus = String(r[12] || '').trim() || 'none'
    const paymentStatus = String(r[13] || '').trim() || 'unpaid'
    const projectName = String(r[14] || '').trim()
    const projectId = projectName ? (projectMap.get(projectName) || null) : null

    const id = ulid()
    stmts.insertPurchase.run(id, TENANT, date, orderNo, supplierId, productId, bundleCount, tonnage, unitPrice, totalAmount, projectId, invoiceStatus, paymentStatus, null, null, null, ts, ts)
    purCount++
  }
  console.log(`✓ 采购录入: ${purCount} 条`)

  // ── 6. 销售录入 ─────────────────────────────────────────────────
  const salRows = parseSheet(wb, '销售录入')
  // Headers: 销售日期, 销售单号, 供应商, 客户/项目, 商品代码, 品牌, 商品名称, 规格, 件数, 吨位, 销售单价, 销售金额, 成本价(自动), 成本价(手动), 采购成本, 单笔毛利, 款项状态, 物流商, 辅助月
  let salCount = 0
  lastDate = ''; lastOrderNo = ''; lastSupplier = ''
  let lastCustomer = ''
  for (let i = 1; i < salRows.length; i++) {
    const r = salRows[i]
    const productCode = String(r[4] || '').trim()
    if (!productCode) continue

    // Forward-fill
    if (r[0] !== '' && r[0] !== null && r[0] !== undefined) lastDate = excelDateToISO(r[0])
    if (r[1] !== '' && r[1] !== null && String(r[1]).trim()) lastOrderNo = String(r[1]).trim()
    if (r[2] !== '' && r[2] !== null && String(r[2]).trim()) lastSupplier = String(r[2]).trim()
    if (r[3] !== '' && r[3] !== null && String(r[3]).trim()) lastCustomer = String(r[3]).trim()

    const date = lastDate
    const orderNo = lastOrderNo || null
    const supplierName = lastSupplier
    const customerName = lastCustomer

    // Lookup customer (project name used as customer name)
    let customerId = counterpartyMap.get(customerName)
    if (!customerId) {
      customerId = ulid()
      stmts.insertCounterparty.run(customerId, TENANT, customerName, 'customer', null, null, null, null, null, ts, ts)
      counterpartyMap.set(customerName, customerId)
      console.log(`  + 自动创建客户: ${customerName}`)
    }

    // Lookup supplier
    let supplierId = counterpartyMap.get(supplierName) || null

    // Lookup product
    let productId = productMap.get(productCode)
    if (!productId) {
      productId = ulid()
      const brand = String(r[5] || '').trim()
      const pname = String(r[6] || '').trim()
      const spec = String(r[7] || '').trim()
      stmts.insertProduct.run(productId, TENANT, productCode, brand, pname, spec, null, '螺纹钢', '理计', null, null, null, ts, ts)
      productMap.set(productCode, productId)
      console.log(`  + 自动创建产品: ${productCode}`)
    }

    // Lookup project
    const projectId = projectMap.get(customerName) || null

    const bundleCount = r[8] ? Number(r[8]) : null
    const tonnage = Number(r[9]) || 0
    const unitPrice = Number(r[10]) || 0
    const totalAmount = Number(r[11]) || (tonnage * unitPrice)
    const costPrice = Number(r[12]) || Number(r[13]) || null  // 自动 or 手动
    const costAmount = Number(r[14]) || null
    const profit = Number(r[15]) || null
    const collectionStatus = String(r[16] || '').trim() || 'uncollected'
    const logisticsProvider = String(r[17] || '').trim() || null

    const id = ulid()
    stmts.insertSale.run(id, TENANT, date, orderNo, customerId, supplierId, productId, bundleCount, tonnage, unitPrice, totalAmount, costPrice, costAmount, profit, projectId, logisticsProvider, 'none', collectionStatus, null, null, null, ts, ts)
    salCount++
  }
  console.log(`✓ 销售录入: ${salCount} 条`)

  // ── 7. 物流录入 ─────────────────────────────────────────────────
  const logRows = parseSheet(wb, '物流录入')
  // Headers: 装车日期, 运单号, 托运公司, 目的地/项目, 车牌号, 司机, 司机电话, 吨位, 运费(元), 吊费(元), 费用合计, 结算状态, 辅助月
  let logCount = 0
  for (let i = 1; i < logRows.length; i++) {
    const r = logRows[i]
    const waybillNo = String(r[1] || '').trim()
    if (!waybillNo) continue

    const date = excelDateToISO(r[0])
    const carrierName = String(r[2] || '').trim()
    const destination = String(r[3] || '').trim()
    const licensePlate = String(r[4] || '').trim() || null
    const driver = String(r[5] || '').trim() || null
    const driverPhone = String(r[6] || '').trim() || null
    const tonnage = Number(r[7]) || null
    const freight = Number(r[8]) || 0
    const liftingFee = Number(r[9]) || 0
    const totalFee = Number(r[10]) || (freight + liftingFee)
    const settlementStatus = String(r[11] || '').trim() || 'unpaid'

    const carrierId = counterpartyMap.get(carrierName) || null
    const projectId = projectMap.get(destination) || null

    const id = ulid()
    stmts.insertLogistics.run(id, TENANT, date, waybillNo, carrierId, projectId, destination, tonnage, freight, liftingFee, totalFee, driver, driverPhone, licensePlate, settlementStatus, null, null, null, ts, ts)
    logCount++
  }
  console.log(`✓ 物流录入: ${logCount} 条`)

  // ── 8. 收付款记录 ───────────────────────────────────────────────
  const payRows = parseSheet(wb, '收付款记录')
  // Headers: 日期, 单据号, 类型, 对象(客户/供应商), 关联项目, 金额(元), 方式, 摘要
  let payCount = 0
  for (let i = 1; i < payRows.length; i++) {
    const r = payRows[i]
    const typeText = String(r[2] || '').trim()
    if (!typeText) continue  // skip empty rows

    const date = excelDateToISO(r[0])
    const docNo = String(r[1] || '').trim() || null
    const direction = typeText === '收款' ? 'in' : 'out'
    const cpName = String(r[3] || '').trim()
    const projectName = String(r[4] || '').trim()
    const amount = Math.abs(Number(r[5]) || 0)
    const method = String(r[6] || '').trim() || null
    const notes = String(r[7] || '').trim() || null

    let counterpartyId = counterpartyMap.get(cpName)
    if (!counterpartyId) {
      counterpartyId = ulid()
      const cpType = direction === 'in' ? 'customer' : 'supplier'
      stmts.insertCounterparty.run(counterpartyId, TENANT, cpName, cpType, null, null, null, null, null, ts, ts)
      counterpartyMap.set(cpName, counterpartyId)
      console.log(`  + 自动创建交易对象: ${cpName} (${cpType})`)
    }

    const projectId = projectName ? (projectMap.get(projectName) || null) : null

    const id = ulid()
    stmts.insertPayment.run(id, TENANT, date, docNo, direction, counterpartyId, projectId, amount, method, null, notes, null, null, ts, ts)
    payCount++
  }
  console.log(`✓ 收付款记录: ${payCount} 条`)

  // ── Summary ─────────────────────────────────────────────────────
  console.log('')
  console.log('=== 导入完成 ===')
  console.log(`产品: ${prodCount}`)
  console.log(`供应商/客户/物流商: ${counterpartyMap.size}`)
  console.log(`项目: ${projCount}`)
  console.log(`采购: ${purCount}`)
  console.log(`销售: ${salCount}`)
  console.log(`物流: ${logCount}`)
  console.log(`收付款: ${payCount}`)
})

try {
  importAll()
  console.log('\n✓ 所有数据已安全写入数据库')
} catch (err) {
  console.error('\n✗ 导入失败，已自动回滚，数据库未做任何修改')
  console.error('错误:', err.message)
  process.exit(1)
} finally {
  db.close()
}
