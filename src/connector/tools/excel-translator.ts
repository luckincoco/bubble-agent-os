/**
 * Excel Semantic Translation Layer
 *
 * Converts raw Excel rows into LLM-friendly natural language content
 * and generates knowledge card skeletons from base-info sheets.
 *
 * Three outputs per import:
 * 1. Row bubbles with natural language content + precise tags
 * 2. Entity knowledge cards from base-info sheets (supplier, customer, product)
 * 3. Pre-computed aggregation bubbles (by supplier, project, month)
 */

import { logger } from '../../shared/logger.js'

// --- Excel date conversion ---

/** Convert Excel serial number to ISO date string (YYYY-MM-DD) */
export function excelDateToISO(serial: number | string): string {
  if (typeof serial === 'string') {
    // Already a date string — normalize to zero-padded YYYY-MM-DD
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(serial)) {
      const parts = serial.split(/[-/]/)
      return `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
    }
    // Try parsing as number
    const n = Number(serial)
    if (isNaN(n)) return serial
    serial = n
  }
  if (serial < 1 || serial > 100000) return String(serial) // Not a date serial
  // Excel epoch: 1900-01-01 = serial 1, but Excel wrongly counts 1900 as leap year
  // Use UTC to avoid timezone-dependent date shifts (local time for 1899 may not be standard UTC+8)
  const ms = Date.UTC(1899, 11, 30) + serial * 86400000
  const date = new Date(ms)
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// --- Sheet type detection ---

export type SheetCategory = 'purchase' | 'sales' | 'logistics' | 'payment' | 'inventory'
  | 'receivable' | 'payable' | 'product_info' | 'supplier_info' | 'customer_info'
  | 'logistics_info' | 'summary' | 'dashboard' | 'unknown'

const SHEET_PATTERNS: Array<[RegExp, SheetCategory]> = [
  [/采购录入|采购记录|采购明细/, 'purchase'],
  [/销售录入|销售记录|销售明细/, 'sales'],
  [/物流录入|物流记录|运输/, 'logistics'],
  [/收付款|付款记录|收款/, 'payment'],
  [/库存动态|库存表|库存管理/, 'inventory'],
  [/应收账款|应收/, 'receivable'],
  [/应付账款|应付/, 'payable'],
  [/产品信息|商品信息|物料/, 'product_info'],
  [/供应商信息|供应商/, 'supplier_info'],
  [/客户与项目|客户信息|项目信息/, 'customer_info'],
  [/物流基础|物流信息/, 'logistics_info'],
  [/年度汇总|月度汇总|汇总/, 'summary'],
  [/仪表盘|经营仪表|dashboard/, 'dashboard'],
  [/利润分析|利润/, 'summary'],
  [/使用说明|说明/, 'unknown'],
]

export function detectSheetCategory(sheetName: string): SheetCategory {
  for (const [pattern, category] of SHEET_PATTERNS) {
    if (pattern.test(sheetName)) return category
  }
  return 'unknown'
}

// --- Spec normalization ---

/** Normalize steel spec "25*12" → "Φ25×12m", "6mm" → "Φ6" */
export function normalizeSpec(raw: string): string {
  if (!raw) return raw
  const s = String(raw).trim()
  // Pattern: "25*12" or "25*9"
  const match = s.match(/^(\d+)\s*[*×x]\s*(\d+)$/)
  if (match) return `Φ${match[1]}×${match[2]}m`
  // Pattern: "6mm" or "8mm"
  const mmMatch = s.match(/^(\d+)\s*mm$/i)
  if (mmMatch) return `Φ${mmMatch[1]}`
  return s
}

// --- Row translation by sheet type ---

export interface TranslatedRow {
  content: string       // Natural language sentence for LLM
  tags: string[]        // Precise business tags for retrieval
  title: string         // Short title
  metadata: Record<string, unknown>  // Original structured data
}

/** Get a value from a row, trying multiple possible column names */
function col(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (row[n] != null && row[n] !== '') return row[n]
  }
  return undefined
}

function str(v: unknown): string { return v != null ? String(v) : '' }
function num(v: unknown): number { return v != null && !isNaN(Number(v)) ? Number(v) : 0 }

export function translatePurchaseRow(row: Record<string, unknown>, companyName = '示例公司'): TranslatedRow {
  const date = col(row, '采购日期')
  const dateStr = date ? excelDateToISO(date as number | string) : ''
  const docNo = str(col(row, '入库单号'))
  const supplier = str(col(row, '供应商'))
  const brand = str(col(row, '品牌'))
  const productName = str(col(row, '商品名称'))
  const specRaw = str(col(row, '规格'))
  const spec = normalizeSpec(specRaw)
  const pieces = num(col(row, '件数'))
  const tons = num(col(row, '吨位'))
  const price = num(col(row, '单价(元/吨)', '单价'))
  const amount = num(col(row, '金额(元)', '金额'))
  const payStatus = str(col(row, '付款状态'))
  const project = str(col(row, '关联项目'))
  const invoiceStatus = str(col(row, '发票状态'))

  const parts: string[] = []
  if (dateStr) parts.push(dateStr)
  parts.push(`${companyName}通过${supplier || '(未知供应商)'}采购${brand ? brand + '牌' : ''}${productName || '钢材'}`)
  if (spec) parts.push(`（规格${spec}）`)
  if (docNo) parts.push(`，入库单号${docNo}`)
  if (pieces > 0 && tons > 0) parts.push(`，共${pieces}件${tons}吨`)
  else if (tons > 0) parts.push(`，${tons}吨`)
  if (price > 0) parts.push(`，单价${price}元/吨`)
  if (amount > 0) parts.push(`，金额${amount}元`)
  if (payStatus) parts.push(`。${payStatus === '已付' ? '货款已付' : `付款状态：${payStatus}`}`)
  if (project) parts.push(`。该批材料供${project}使用`)

  const content = parts.join('')
  const tags = ['采购', supplier, brand, productName, specRaw, project].filter(Boolean) as string[]

  return {
    content,
    tags: [...new Set(tags)],
    title: `采购: ${supplier} ${spec || specRaw} ${tons > 0 ? tons + '吨' : ''}`.trim(),
    metadata: { ...row, _dateISO: dateStr, _spec: spec, _sheetType: 'purchase' },
  }
}

export function translateSalesRow(row: Record<string, unknown>, companyName = '示例公司'): TranslatedRow {
  const date = col(row, '销售日期')
  const dateStr = date ? excelDateToISO(date as number | string) : ''
  const docNo = str(col(row, '销售单号'))
  const supplier = str(col(row, '供应商'))
  const customer = str(col(row, '客户/项目'))
  const brand = str(col(row, '品牌'))
  const productName = str(col(row, '商品名称'))
  const specRaw = str(col(row, '规格'))
  const spec = normalizeSpec(specRaw)
  const pieces = num(col(row, '件数'))
  const tons = num(col(row, '吨位'))
  const salePrice = num(col(row, '销售单价'))
  const saleAmount = num(col(row, '销售金额'))
  const costPrice = num(col(row, '成本价(自动)', '成本价(手动)'))
  const profit = num(col(row, '单笔毛利'))
  const logistics = str(col(row, '物流商'))

  const parts: string[] = []
  if (dateStr) parts.push(dateStr)
  parts.push(`${companyName}向${customer || '(未知客户)'}销售${brand ? brand + '牌' : ''}${productName || '钢材'}`)
  if (spec) parts.push(`（规格${spec}）`)
  if (docNo) parts.push(`，销售单号${docNo}`)
  if (pieces > 0 && tons > 0) parts.push(`，共${pieces}件${tons}吨`)
  else if (tons > 0) parts.push(`，${tons}吨`)
  if (salePrice > 0) parts.push(`，售价${salePrice}元/吨`)
  if (saleAmount > 0) parts.push(`，销售额${saleAmount}元`)
  if (costPrice > 0 && profit !== 0) parts.push(`。成本${costPrice}元/吨，单笔毛利${(Math.round(profit * 100) / 100)}元`)
  if (supplier) parts.push(`。货源来自${supplier}`)
  if (logistics) parts.push(`，物流由${logistics}承运`)

  const content = parts.join('')
  const tags = ['销售', customer, supplier, brand, productName, specRaw].filter(Boolean) as string[]

  return {
    content,
    tags: [...new Set(tags)],
    title: `销售: ${customer} ${spec || specRaw} ${tons > 0 ? tons + '吨' : ''}`.trim(),
    metadata: { ...row, _dateISO: dateStr, _spec: spec, _sheetType: 'sales' },
  }
}

export function translateLogisticsRow(row: Record<string, unknown>): TranslatedRow {
  const date = col(row, '装车日期')
  const dateStr = date ? excelDateToISO(date as number | string) : ''
  const docNo = str(col(row, '运单号'))
  const carrier = str(col(row, '托运公司'))
  const dest = str(col(row, '目的地/项目'))
  const plate = str(col(row, '车牌号'))
  const driver = str(col(row, '司机'))
  const tons = num(col(row, '吨位'))
  const freight = num(col(row, '运费(元)', '运费'))
  const crane = num(col(row, '吊费(元)', '吊费'))
  const total = num(col(row, '费用合计'))
  const status = str(col(row, '结算状态'))

  const parts: string[] = []
  if (dateStr) parts.push(dateStr)
  parts.push(`${carrier || '(未知物流)'}承运货物至${dest || '(未知目的地)'}`)
  if (docNo) parts.push(`，运单号${docNo}`)
  if (tons > 0) parts.push(`，${tons}吨`)
  if (driver) parts.push(`，司机${driver}`)
  if (plate) parts.push(`（${plate}）`)
  if (freight > 0) parts.push(`。运费${freight}元`)
  if (crane > 0) parts.push(`，吊费${crane}元`)
  if (total > 0) parts.push(`，合计${total}元`)
  if (status) parts.push(`。${status}`)

  const content = parts.join('')
  const tags = ['物流', carrier, dest, driver].filter(Boolean) as string[]

  return {
    content,
    tags: [...new Set(tags)],
    title: `物流: ${carrier} → ${dest} ${tons > 0 ? tons + '吨' : ''}`.trim(),
    metadata: { ...row, _dateISO: dateStr, _sheetType: 'logistics' },
  }
}

export function translatePaymentRow(row: Record<string, unknown>, companyName = '示例公司'): TranslatedRow {
  const date = col(row, '日期')
  const dateStr = date ? excelDateToISO(date as number | string) : ''
  const docNo = str(col(row, '单据号'))
  const type = str(col(row, '类型'))
  const target = str(col(row, '对象(客户/供应商)', '对象'))
  const project = str(col(row, '关联项目'))
  const amount = num(col(row, '金额(元)', '金额'))
  const method = str(col(row, '方式'))
  const note = str(col(row, '摘要'))

  const direction = type === '付款' ? '向' : '收到'
  const directionEnd = type === '付款' ? '付款' : '回款'

  const parts: string[] = []
  if (dateStr) parts.push(dateStr)
  parts.push(`${companyName}${direction}${target || '(未知对象)'}${directionEnd}${amount}元`)
  if (method) parts.push(`（${method}）`)
  if (project) parts.push(`，关联${project}`)
  if (note) parts.push(`，摘要：${note}`)

  const content = parts.join('')
  const tags = [type || '收付款', target, project].filter(Boolean) as string[]

  return {
    content,
    tags: [...new Set(tags)],
    title: `${type}: ${target} ${amount}元`.trim(),
    metadata: { ...row, _dateISO: dateStr, _sheetType: 'payment' },
  }
}

/** Fallback: generic row translation with key: value pairs */
export function translateGenericRow(row: Record<string, unknown>, sheetName: string): TranslatedRow {
  const headers = Object.keys(row)
  const contentParts = headers
    .filter(h => row[h] != null && row[h] !== '')
    .map(h => {
      const v = row[h]
      // Try to convert date serials in columns containing '日期' or '时间'
      if ((h.includes('日期') || h.includes('时间')) && typeof v === 'number' && v > 40000 && v < 100000) {
        return `${h}: ${excelDateToISO(v)}`
      }
      return `${h}: ${v}`
    })

  return {
    content: contentParts.join(', '),
    tags: [sheetName],
    title: `${sheetName} - ${str(Object.values(row).find(v => v != null && v !== ''))}`,
    metadata: { ...row, _sheetType: 'generic' },
  }
}

/** Main dispatcher: translate a row based on sheet category */
export function translateRow(row: Record<string, unknown>, sheetName: string, category: SheetCategory): TranslatedRow {
  switch (category) {
    case 'purchase': return translatePurchaseRow(row)
    case 'sales': return translateSalesRow(row)
    case 'logistics': return translateLogisticsRow(row)
    case 'payment': return translatePaymentRow(row)
    default: return translateGenericRow(row, sheetName)
  }
}

// --- Knowledge card generation from base-info sheets ---

export interface KnowledgeCard {
  type: 'entity'
  title: string
  content: string
  tags: string[]
  pinned: boolean
  confidence: number
  decayRate: number
  abstractionLevel: number
  metadata: Record<string, unknown>
}

export function generateSupplierCard(row: Record<string, unknown>): KnowledgeCard | null {
  const name = str(col(row, '供应商名称'))
  if (!name) return null

  const brands = str(col(row, '经销品牌'))
  const address = str(col(row, '提货地址'))
  const contact = str(col(row, '联系人'))
  const phone = str(col(row, '联系电话'))
  const paid = num(col(row, '已付金额'))
  const unpaid = num(col(row, '未付余款'))

  const parts: string[] = [`${name}是示例公司的钢材供应商`]
  if (brands) parts.push(`，经销${brands}品牌`)
  parts.push('。')
  if (address) parts.push(`提货地点在${address}。`)
  if (contact) {
    parts.push(`联系人${contact}`)
    if (phone) parts.push(`（${phone}）`)
    parts.push('。')
  }
  if (paid > 0) {
    parts.push(`累计已付金额${(paid / 10000).toFixed(1)}万元`)
    if (unpaid === 0 || Math.abs(unpaid) < 100) parts.push('，货款基本结清')
    else if (unpaid > 0) parts.push(`，尚欠${(unpaid / 10000).toFixed(1)}万元`)
    else parts.push(`，存在超付${(Math.abs(unpaid) / 10000).toFixed(1)}万元`)
    parts.push('。')
  }

  const brandList = brands.split(/[、,，]/).map(b => b.trim()).filter(Boolean)
  const tags = ['实体', '供应商', name, ...brandList]

  return {
    type: 'entity',
    title: `供应商: ${name}`,
    content: parts.join(''),
    tags: [...new Set(tags)],
    pinned: true,
    confidence: 1.0,
    decayRate: 0.01,
    abstractionLevel: 1,
    metadata: { entityType: 'supplier', name, brands: brandList, address, contact, phone, _sheetType: 'supplier_info' },
  }
}

export function generateCustomerCard(row: Record<string, unknown>): KnowledgeCard | null {
  const name = str(col(row, '项目名称'))
  if (!name) return null

  const contractNo = str(col(row, '合同编号'))
  const address = str(col(row, '工程地址'))
  const builder = str(col(row, '施工单位'))
  const owner = str(col(row, '建设单位'))
  const contact = str(col(row, '联系人'))
  const phone = str(col(row, '电话'))
  const status = str(col(row, '项目状态'))
  const totalSales = num(col(row, '累计销售额'))
  const received = num(col(row, '已回款'))
  const unpaid = num(col(row, '未回款余额'))

  const parts: string[] = [`${name}是示例公司的销售项目`]
  if (status) parts.push(`，当前状态：${status}`)
  parts.push('。')
  if (address) parts.push(`工程地址：${address}。`)
  if (builder) parts.push(`施工单位：${builder}。`)
  if (owner) parts.push(`建设单位：${owner}。`)
  if (contact) {
    parts.push(`联系人${contact}`)
    if (phone) parts.push(`（${phone}）`)
    parts.push('。')
  }
  if (totalSales > 0) {
    parts.push(`累计销售额${(totalSales / 10000).toFixed(1)}万元`)
    if (unpaid > 0) parts.push(`，未回款${(unpaid / 10000).toFixed(1)}万元`)
    if (received > 0) parts.push(`，已回款${(received / 10000).toFixed(1)}万元`)
    parts.push('。')
  }

  const tags = ['实体', '项目', '客户', name]
  if (builder) tags.push(builder)

  return {
    type: 'entity',
    title: `项目: ${name}`,
    content: parts.join(''),
    tags: [...new Set(tags)],
    pinned: true,
    confidence: 1.0,
    decayRate: 0.01,
    abstractionLevel: 1,
    metadata: { entityType: 'project', name, contractNo, address, builder, owner, contact, phone, status, _sheetType: 'customer_info' },
  }
}

export function generateProductCard(row: Record<string, unknown>): KnowledgeCard | null {
  const code = str(col(row, '商品代码'))
  const brand = str(col(row, '品牌'))
  const productName = str(col(row, '商品名称'))
  const specRaw = str(col(row, '规格'))
  if (!code && !productName) return null

  const spec = normalizeSpec(specRaw)
  const specFmt = str(col(row, '规格(调整格式)'))
  const method = str(col(row, '计量方式'))
  const weight = num(col(row, '件重(吨)', '件重'))
  const pieces = num(col(row, '支数'))
  const craneFee = num(col(row, '吊费(元/吨)', '吊费'))
  const type = str(col(row, '类型'))

  const parts: string[] = [`${brand}${productName} ${spec || specRaw}`]
  if (type) parts.push(`（${type}）`)
  if (code) parts.push(`，商品代码${code}`)
  if (method) parts.push(`，${method}计量`)
  if (weight > 0) parts.push(`，每件约${weight}吨`)
  if (pieces > 0) parts.push(`（${pieces}支/件）`)
  if (craneFee > 0) parts.push(`，吊费标准${craneFee}元/吨`)
  parts.push('。')

  return {
    type: 'entity',
    title: `产品: ${brand} ${spec || specRaw}`,
    content: parts.join(''),
    tags: ['实体', '产品', brand, productName, specRaw].filter(Boolean) as string[],
    pinned: false,
    confidence: 1.0,
    decayRate: 0.03,
    abstractionLevel: 0,
    metadata: { entityType: 'product', code, brand, productName, spec: specRaw, specNorm: spec, weight, type, _sheetType: 'product_info' },
  }
}

export function generateLogisticsInfoCard(row: Record<string, unknown>): KnowledgeCard | null {
  const company = str(col(row, '托运公司'))
  if (!company) return null

  const dest = str(col(row, '常送目的地'))
  const plate = str(col(row, '车牌号'))
  const driver = str(col(row, '司机'))
  const phone = str(col(row, '司机电话'))

  const parts: string[] = [`${company}是示例公司使用的物流运输方`]
  if (dest) parts.push(`，常送目的地：${dest}`)
  parts.push('。')
  if (driver) {
    parts.push(`司机${driver}`)
    if (phone) parts.push(`（${phone}）`)
    if (plate) parts.push(`，车牌${plate}`)
    parts.push('。')
  } else if (plate) {
    parts.push(`车牌${plate}。`)
  }

  return {
    type: 'entity',
    title: `物流: ${company}`,
    content: parts.join(''),
    tags: ['实体', '物流', company, dest].filter(Boolean) as string[],
    pinned: true,
    confidence: 1.0,
    decayRate: 0.02,
    abstractionLevel: 1,
    metadata: { entityType: 'logistics', company, dest, driver, phone, plate, _sheetType: 'logistics_info' },
  }
}

/** Generate knowledge cards from a base-info sheet */
export function generateKnowledgeCards(rows: Record<string, unknown>[], category: SheetCategory): KnowledgeCard[] {
  const cards: KnowledgeCard[] = []
  for (const row of rows) {
    let card: KnowledgeCard | null = null
    switch (category) {
      case 'supplier_info': card = generateSupplierCard(row); break
      case 'customer_info': card = generateCustomerCard(row); break
      case 'product_info': card = generateProductCard(row); break
      case 'logistics_info': card = generateLogisticsInfoCard(row); break
    }
    if (card) cards.push(card)
  }
  logger.debug(`Generated ${cards.length} knowledge cards from ${category}`)
  return cards
}

// --- Pre-computed aggregations ---

export interface AggregationBubble {
  title: string
  content: string
  tags: string[]
  abstractionLevel: number
  metadata: Record<string, unknown>
}

export function computePurchaseAggregations(rows: Record<string, unknown>[]): AggregationBubble[] {
  const results: AggregationBubble[] = []

  // Group by supplier
  const bySupplier = new Map<string, { tons: number; amount: number; count: number; specs: Set<string> }>()
  // Group by project
  const byProject = new Map<string, { tons: number; amount: number; count: number; suppliers: Set<string> }>()

  for (const row of rows) {
    const supplier = str(col(row, '供应商'))
    const project = str(col(row, '关联项目'))
    const tons = num(col(row, '吨位'))
    const amount = num(col(row, '金额(元)', '金额'))
    const spec = str(col(row, '规格'))

    if (supplier) {
      const s = bySupplier.get(supplier) ?? { tons: 0, amount: 0, count: 0, specs: new Set<string>() }
      s.tons += tons; s.amount += amount; s.count++
      if (spec) s.specs.add(spec)
      bySupplier.set(supplier, s)
    }
    if (project) {
      const p = byProject.get(project) ?? { tons: 0, amount: 0, count: 0, suppliers: new Set<string>() }
      p.tons += tons; p.amount += amount; p.count++
      if (supplier) p.suppliers.add(supplier)
      byProject.set(project, p)
    }
  }

  // Supplier aggregation bubbles
  for (const [supplier, data] of bySupplier) {
    if (data.count === 0) continue
    const avgPrice = data.tons > 0 ? Math.round(data.amount / data.tons) : 0
    const specs = [...data.specs].map(s => normalizeSpec(s)).join('、')
    results.push({
      title: `采购汇总: ${supplier}`,
      content: `示例公司通过${supplier}共采购${data.count}笔，合计${data.tons.toFixed(1)}吨，总金额${data.amount.toFixed(0)}元（约${(data.amount / 10000).toFixed(1)}万元），吨均价约${avgPrice}元/吨。涉及规格：${specs}。`,
      tags: ['采购汇总', supplier],
      abstractionLevel: 1,
      metadata: { aggregationType: 'purchase_by_supplier', supplier, tons: data.tons, amount: data.amount, count: data.count, avgPrice },
    })
  }

  // Project aggregation bubbles
  for (const [project, data] of byProject) {
    if (data.count === 0) continue
    const suppliers = [...data.suppliers].join('、')
    results.push({
      title: `项目采购汇总: ${project}`,
      content: `${project}累计采购${data.count}笔，合计${data.tons.toFixed(1)}吨，采购成本${data.amount.toFixed(0)}元（约${(data.amount / 10000).toFixed(1)}万元）。供应商：${suppliers}。`,
      tags: ['采购汇总', project],
      abstractionLevel: 1,
      metadata: { aggregationType: 'purchase_by_project', project, tons: data.tons, amount: data.amount, count: data.count },
    })
  }

  return results
}

export function computeSalesAggregations(rows: Record<string, unknown>[]): AggregationBubble[] {
  const results: AggregationBubble[] = []

  const byCustomer = new Map<string, { tons: number; amount: number; profit: number; count: number }>()

  for (const row of rows) {
    const customer = str(col(row, '客户/项目'))
    const tons = num(col(row, '吨位'))
    const amount = num(col(row, '销售金额'))
    const profit = num(col(row, '单笔毛利'))

    if (customer) {
      const c = byCustomer.get(customer) ?? { tons: 0, amount: 0, profit: 0, count: 0 }
      c.tons += tons; c.amount += amount; c.profit += profit; c.count++
      byCustomer.set(customer, c)
    }
  }

  for (const [customer, data] of byCustomer) {
    if (data.count === 0) continue
    const avgPrice = data.tons > 0 ? Math.round(data.amount / data.tons) : 0
    const profitRate = data.amount > 0 ? ((data.profit / data.amount) * 100).toFixed(1) : '0'
    results.push({
      title: `销售汇总: ${customer}`,
      content: `示例公司向${customer}累计销售${data.count}笔，合计${data.tons.toFixed(1)}吨，销售额${data.amount.toFixed(0)}元（约${(data.amount / 10000).toFixed(1)}万元），吨均售价约${avgPrice}元/吨。累计毛利${data.profit.toFixed(0)}元，毛利率${profitRate}%。`,
      tags: ['销售汇总', customer],
      abstractionLevel: 1,
      metadata: { aggregationType: 'sales_by_customer', customer, tons: data.tons, amount: data.amount, profit: data.profit, count: data.count, avgPrice },
    })
  }

  return results
}

/** Check if a sheet is a base-info type that should generate knowledge cards */
export function isBaseInfoSheet(category: SheetCategory): boolean {
  return ['supplier_info', 'customer_info', 'product_info', 'logistics_info'].includes(category)
}

/** Check if a sheet is a transaction type that should generate aggregations */
export function isTransactionSheet(category: SheetCategory): boolean {
  return ['purchase', 'sales'].includes(category)
}

/** Check if a sheet should generate translated row bubbles */
export function isTranslatableSheet(category: SheetCategory): boolean {
  return ['purchase', 'sales', 'logistics', 'payment'].includes(category)
}
