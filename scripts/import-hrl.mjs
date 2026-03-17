/**
 * 华瑞隆进销存数据 → 泡泡记忆系统导入脚本
 * 
 * 读取微信小程序导出的 JSON 数据，转换为 Bubble 格式，
 * 通过 POST /api/import 批量导入，并自动建立关联关系。
 * 
 * 用法：node scripts/import-hrl.mjs [SERVER_URL]
 * 默认：http://101.34.243.245:3000
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER = process.argv[2] || 'http://101.34.243.245:3000'
const DATA_DIR = '/Users/jiangchunyu/Desktop/huaruilong-miniapp/scripts/output'

function readJsonLines(filename) {
  const content = readFileSync(resolve(DATA_DIR, filename), 'utf-8').trim()
  if (!content) return []
  return content.split('\n').map(line => JSON.parse(line))
}

const products = readJsonLines('products.json')
const suppliers = readJsonLines('suppliers.json')
const customers = readJsonLines('customers_projects.json')
const purchases = readJsonLines('purchases.json')
const sales = readJsonLines('sales.json')
const payments = readJsonLines('payments.json')

console.log(`Loaded: ${products.length} products, ${suppliers.length} suppliers, ${customers.length} customers, ${purchases.length} purchases, ${sales.length} sales, ${payments.length} payments`)

const bubbles = []
const links = []

// 1. Products -> entity
for (const p of products) {
  bubbles.push({
    ref: `product:${p.code}`,
    type: 'entity',
    title: `产品 ${p.shortName || p.name} ${p.spec}`,
    content: `产品：${p.brand} ${p.name}，规格${p.spec}（${p.shortName}），${p.measureType}，件重${p.bundleWeight}吨/${p.bundleCount}支，吊费${p.liftingFee}元，类别：${p.category}`,
    metadata: { code: p.code, brand: p.brand, spec: p.spec, measureType: p.measureType, bundleWeight: p.bundleWeight, category: p.category },
    tags: ['产品', p.brand, p.category].filter(Boolean),
    source: 'user', confidence: 1.0, pinned: true,
  })
}

// 2. Suppliers -> entity
for (const s of suppliers) {
  bubbles.push({
    ref: `supplier:${s.name}`,
    type: 'entity',
    title: `供应商 ${s.name}`,
    content: `供应商：${s.name}，经营品牌：${s.contact}，仓库：${s.phone}，联系人：${s.remark}`,
    metadata: { name: s.name, brands: s.contact, warehouse: s.phone, contactPerson: s.remark },
    tags: ['供应商', ...(s.contact ? s.contact.split(/[、,，]/) : [])].filter(Boolean),
    source: 'user', confidence: 1.0, pinned: true,
  })
}

// 3. Customers/Projects -> entity
for (const c of customers) {
  bubbles.push({
    ref: `customer:${c.name}`,
    type: 'entity',
    title: `项目 ${c.name}`,
    content: `客户项目：${c.name}，地址：${c.phone}，施工方：${c.address}，业主：${c.remark}`,
    metadata: { name: c.name, address: c.phone, contractor: c.address, owner: c.remark },
    tags: ['客户', '项目'],
    source: 'user', confidence: 1.0, pinned: true,
  })
}

// 4. Purchases -> event + links
for (const p of purchases) {
  const ref = `purchase:${p.orderNo}:${p.productCode}`
  bubbles.push({
    ref,
    type: 'event',
    title: `采购 ${p.orderNo} ${p.productName} ${p.spec}`,
    content: `采购单${p.orderNo}，${p.date}，从${p.supplierName}采购${p.brand} ${p.productName} ${p.spec}，${p.quantity}件/${p.tonnage}吨，单价${p.unitPrice}元/吨，金额${p.amount}元${p.paymentStatus ? '，' + p.paymentStatus : ''}${p.relatedProject ? '，项目：' + p.relatedProject : ''}`,
    metadata: { orderNo: p.orderNo, date: p.date, month: p.month, tonnage: p.tonnage, unitPrice: p.unitPrice, amount: p.amount },
    tags: ['采购', p.month, p.supplierName].filter(Boolean),
    source: 'user', confidence: 1.0,
  })
  links.push({ sourceRef: ref, targetRef: `product:${p.productCode}`, relation: '采购产品', weight: 0.9 })
  links.push({ sourceRef: ref, targetRef: `supplier:${p.supplierName}`, relation: '供应来源', weight: 0.9 })
  if (p.relatedProject) links.push({ sourceRef: ref, targetRef: `customer:${p.relatedProject}`, relation: '关联项目', weight: 0.8 })
}

// 5. Sales -> event + links
for (const s of sales) {
  const ref = `sale:${s.orderNo}:${s.productCode}`
  bubbles.push({
    ref,
    type: 'event',
    title: `销售 ${s.orderNo} ${s.productName} ${s.spec}`,
    content: `销售单${s.orderNo}，${s.date}，向${s.customerName}销售${s.brand} ${s.productName} ${s.spec}，${s.tonnage}吨，售价${s.unitPrice}元/吨，金额${s.amount}元，成本${s.costPrice}元/吨，利润${s.profit}元${s.logisticsProvider ? '，物流：' + s.logisticsProvider : ''}`,
    metadata: { orderNo: s.orderNo, date: s.date, month: s.month, tonnage: s.tonnage, unitPrice: s.unitPrice, amount: s.amount, costPrice: s.costPrice, profit: s.profit },
    tags: ['销售', s.month, s.customerName].filter(Boolean),
    source: 'user', confidence: 1.0,
  })
  links.push({ sourceRef: ref, targetRef: `product:${s.productCode}`, relation: '销售产品', weight: 0.9 })
  links.push({ sourceRef: ref, targetRef: `customer:${s.customerName}`, relation: '销售客户', weight: 0.9 })
  if (s.supplierName) links.push({ sourceRef: ref, targetRef: `supplier:${s.supplierName}`, relation: '货源供应商', weight: 0.7 })
}

// 6. Payments -> event + links
for (const p of payments) {
  const ref = `payment:${p.date}:${p.targetName}:${p.amount}`
  const label = p.type === '付款' ? '付款' : '回款'
  bubbles.push({
    ref,
    type: 'event',
    title: `${label} ${p.targetName} ${p.amount}元`,
    content: `${label}，${p.date}，向${p.targetName}${label}${p.amount}元，${p.method}${p.relatedProject ? '，项目：' + p.relatedProject : ''}`,
    metadata: { date: p.date, type: p.type, amount: p.amount, method: p.method },
    tags: [label, p.date.substring(0, 7), p.targetName].filter(Boolean),
    source: 'user', confidence: 1.0,
  })
  const targetType = p.type === '付款' ? 'supplier' : 'customer'
  links.push({ sourceRef: ref, targetRef: `${targetType}:${p.targetName}`, relation: label + '对象', weight: 0.8 })
  if (p.relatedProject) links.push({ sourceRef: ref, targetRef: `customer:${p.relatedProject}`, relation: '关联项目', weight: 0.7 })
}

// Filter links with missing refs
const refSet = new Set(bubbles.map(b => b.ref))
const validLinks = links.filter(l => refSet.has(l.sourceRef) && refSet.has(l.targetRef))
console.log(`Converted: ${bubbles.length} bubbles, ${validLinks.length} valid links (${links.length - validLinks.length} skipped)`)

// Send to server
async function main() {
  console.log(`\nImporting to ${SERVER}...`)
  const res = await fetch(`${SERVER}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bubbles, links: validLinks }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  const result = await res.json()
  console.log(`Done: ${result.created} bubbles created, ${result.linked} links created`)
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1) })
