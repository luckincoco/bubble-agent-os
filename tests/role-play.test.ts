/**
 * Multi-Role Play Test — 多角色数据隔离验证
 *
 * 模拟供应商、客户、物流三种外部角色访问 ext_* 工具，
 * 验证信息边界（data isolation）和敏感字段不泄露。
 *
 * 测试策略：
 * 1. 初始化临时数据库，插入已知的交易对手方和业务数据
 * 2. 为每个角色构造 ExternalUserContext
 * 3. 直接调用 ext_* 工具的 execute 方法
 * 4. 断言：每个角色只能看到与自己相关的数据
 * 5. 断言：敏感字段（cost, profit, exposure）绝不出现在输出中
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, closeDatabase } from '../src/storage/database.js'
import { createProduct, createCounterparty, createPurchase, createSale, createLogistics, createPayment } from '../src/connector/biz/structured-store.js'
import type { BizContext } from '../src/connector/biz/structured-store.js'
import { createExtQueryTools } from '../src/connector/tools/ext-query-tools.js'
import type { ExternalUserContext } from '../src/shared/types.js'

// ── Test Data ────────────────────────────────────────────────────────

let tmpDir: string
const SPACE_ID = 'test-space-001'
const bizCtx: BizContext = { spaceId: SPACE_ID }

// Counterparty IDs (will be assigned after creation)
let supplierId: string
let customerId: string
let logisticsId: string

// Tools indexed by name
const tools = new Map<string, { execute: (args: Record<string, unknown>, ctx?: any) => Promise<string> }>()

// ── Helpers ──────────────────────────────────────────────────────────

function makeExtCtx(counterpartyId: string, counterpartyName: string, counterpartyType: 'supplier' | 'customer' | 'logistics'): ExternalUserContext {
  return {
    userId: 'test-admin',
    spaceIds: [SPACE_ID],
    activeSpaceId: SPACE_ID,
    isExternal: true,
    counterpartyId,
    counterpartyName,
    counterpartyType,
    permissionLevel: 'query',
    platformUserId: `test-${counterpartyType}`,
    platform: 'wecom',
  }
}

/** Check that output does NOT contain any sensitive fields */
function assertNoSensitiveLeaks(output: string, label: string) {
  const sensitivePatterns = [
    /成本/,
    /利润/,
    /毛利/,
    /profit/i,
    /cost.*price/i,
    /exposure/i,
    /敞口/,
    /costPrice/,
    /costAmount/,
  ]
  for (const pattern of sensitivePatterns) {
    expect(output, `${label}: 输出中不应包含敏感字段 ${pattern}`).not.toMatch(pattern)
  }
}

// ── Setup & Teardown ─────────────────────────────────────────────────

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-roleplay-'))
  initDatabase(tmpDir, 'roleplay-test')

  // Create counterparties
  const supplier = createCounterparty(bizCtx, {
    name: '华瑞隆钢材有限公司',
    type: 'supplier',
    contact: '张经理',
    phone: '13800001111',
  })
  supplierId = supplier.id

  const customer = createCounterparty(bizCtx, {
    name: '中建三局项目部',
    type: 'customer',
    contact: '李主任',
    phone: '13900002222',
  })
  customerId = customer.id

  const logistics = createCounterparty(bizCtx, {
    name: '顺达物流',
    type: 'logistics',
    contact: '王师傅',
    phone: '13700003333',
  })
  logisticsId = logistics.id

  // Create products (required by FK constraints)
  const product1 = createProduct(bizCtx, {
    code: 'HRB400E-25',
    name: 'HRB400E螺纹钢',
    brand: '华新',
    spec: 'Φ25',
  })
  const product2 = createProduct(bizCtx, {
    code: 'HRB400E-20',
    name: 'HRB400E螺纹钢',
    brand: '华新',
    spec: 'Φ20',
  })

  // Create purchases (supplier visible)
  createPurchase({
    date: '2025-04-01',
    supplierId,
    productId: product1.id,
    tonnage: 50,
    unitPrice: 3800,
    totalAmount: 190000,
    spaceId: SPACE_ID,
  })
  createPurchase({
    date: '2025-04-15',
    supplierId,
    productId: product2.id,
    tonnage: 30,
    unitPrice: 3750,
    totalAmount: 112500,
    spaceId: SPACE_ID,
  })

  // Create sales (customer visible) — includes cost/profit (sensitive!)
  createSale({
    date: '2025-04-05',
    customerId,
    productId: product1.id,
    tonnage: 40,
    unitPrice: 4100,
    totalAmount: 164000,
    costPrice: 3800,
    costAmount: 152000,
    profit: 12000,
    spaceId: SPACE_ID,
  })
  createSale({
    date: '2025-04-20',
    customerId,
    productId: product2.id,
    tonnage: 25,
    unitPrice: 4050,
    totalAmount: 101250,
    costPrice: 3750,
    costAmount: 93750,
    profit: 7500,
    spaceId: SPACE_ID,
  })

  // Create logistics (logistics visible)
  createLogistics({
    date: '2025-04-05',
    carrierId: logisticsId,
    destination: '中建三局工地',
    tonnage: 40,
    freight: 2000,
    driver: '王师傅',
    driverPhone: '13700003333',
    licensePlate: '鄂A12345',
    spaceId: SPACE_ID,
  })
  createLogistics({
    date: '2025-04-20',
    carrierId: logisticsId,
    destination: '华中项目部',
    tonnage: 25,
    freight: 1500,
    driver: '赵师傅',
    licensePlate: '鄂B67890',
    spaceId: SPACE_ID,
  })

  // Create payments
  createPayment({
    date: '2025-04-10',
    direction: 'out',
    counterpartyId: supplierId,
    amount: 100000,
    method: '银行转账',
    spaceId: SPACE_ID,
  })
  createPayment({
    date: '2025-04-25',
    direction: 'in',
    counterpartyId: customerId,
    amount: 150000,
    method: '银行转账',
    spaceId: SPACE_ID,
  })

  // Register ext tools
  const extTools = createExtQueryTools()
  for (const tool of extTools) {
    tools.set(tool.name, tool as any)
  }
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ═══════════════════════════════════════════════════════════════════════
// Test Suites
// ═══════════════════════════════════════════════════════════════════════

describe('供应商角色 (Supplier Role)', () => {
  let ctx: ExternalUserContext

  beforeAll(() => {
    ctx = makeExtCtx(supplierId, '华瑞隆钢材有限公司', 'supplier')
  })

  it('ext_my_orders 返回采购记录（供应商看到的是别人向他采购）', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('华瑞隆')
    expect(result).toContain('采购记录')
    expect(result).toContain('50') // tonnage
    expect(result).toContain('3,800') // unit price (formatted)
    // 不能看到客户的销售数据
    expect(result).not.toContain('中建三局')
    expect(result).not.toContain('4,100') // sale unit price
  })

  it('ext_my_orders 日期过滤生效', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({ date_from: '2025-04-10', date_to: '2025-04-30' }, ctx)
    // Only the April 15 purchase should appear
    expect(result).toContain('30') // 30 tons
    expect(result).not.toContain('190,000') // April 1 purchase total
  })

  it('ext_my_payments 只返回与供应商相关的付款', async () => {
    const tool = tools.get('ext_my_payments')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('100,000')
    // 不能看到客户的收款
    expect(result).not.toContain('150,000')
  })

  it('ext_my_logistics 对供应商返回空（供应商非物流方）', async () => {
    const tool = tools.get('ext_my_logistics')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('暂无')
  })

  it('输出中不包含敏感信息（成本/利润）', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, ctx)
    assertNoSensitiveLeaks(result, '供应商-订单')
  })
})

describe('客户角色 (Customer Role)', () => {
  let ctx: ExternalUserContext

  beforeAll(() => {
    ctx = makeExtCtx(customerId, '中建三局项目部', 'customer')
  })

  it('ext_my_orders 返回销售记录（客户看到的是别人卖给他的）', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('中建三局')
    expect(result).toContain('销售记录')
    expect(result).toContain('40') // tonnage
    expect(result).toContain('4,100') // sale unit price
    // 不能看到供应商的采购数据
    expect(result).not.toContain('华瑞隆')
    expect(result).not.toContain('3,800') // purchase unit price
  })

  it('ext_my_payments 只返回与客户相关的收款', async () => {
    const tool = tools.get('ext_my_payments')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('150,000')
    // 不能看到对供应商的付款
    expect(result).not.toContain('100,000')
  })

  it('ext_my_logistics 对客户返回空（客户非物流方）', async () => {
    const tool = tools.get('ext_my_logistics')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('暂无')
  })

  it('输出中不包含敏感信息（成本/利润）', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, ctx)
    assertNoSensitiveLeaks(result, '客户-订单')

    const payTool = tools.get('ext_my_payments')!
    const payResult = await payTool.execute({}, ctx)
    assertNoSensitiveLeaks(payResult, '客户-付款')
  })
})

describe('物流角色 (Logistics Role)', () => {
  let ctx: ExternalUserContext

  beforeAll(() => {
    ctx = makeExtCtx(logisticsId, '顺达物流', 'logistics')
  })

  it('ext_my_logistics 返回物流记录', async () => {
    const tool = tools.get('ext_my_logistics')!
    const result = await tool.execute({}, ctx)
    expect(result).toContain('顺达物流')
    expect(result).toContain('物流记录')
    expect(result).toContain('中建三局工地')
    expect(result).toContain('40') // tonnage
  })

  it('ext_my_orders 对物流返回空（物流非买卖方）', async () => {
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, ctx)
    // logistics type falls into 'else' (getSales branch) - with carrierId as customerId, should return empty
    expect(result).toContain('暂无')
  })

  it('ext_my_payments 对物流返回相关付款', async () => {
    const tool = tools.get('ext_my_payments')!
    const result = await tool.execute({}, ctx)
    // No payment was created for logistics provider in our test data
    expect(result).toContain('暂无')
  })

  it('输出中不包含敏感信息', async () => {
    const tool = tools.get('ext_my_logistics')!
    const result = await tool.execute({}, ctx)
    assertNoSensitiveLeaks(result, '物流-记录')
  })
})

describe('权限控制', () => {
  it('ext_confirm_receipt 需要 query_confirm 权限', async () => {
    // query-only user cannot confirm
    const ctx = makeExtCtx(customerId, '中建三局项目部', 'customer')
    const tool = tools.get('ext_confirm_receipt')!
    const result = await tool.execute({ date: '2025-04-05', product: '螺纹钢' }, ctx)
    expect(result).toContain('没有确认权限')
  })

  it('ext_confirm_receipt 允许 query_confirm 权限', async () => {
    const ctx: ExternalUserContext = {
      ...makeExtCtx(customerId, '中建三局项目部', 'customer'),
      permissionLevel: 'query_confirm',
    }
    const tool = tools.get('ext_confirm_receipt')!
    const result = await tool.execute({ date: '2025-04-05', product: '螺纹钢' }, ctx)
    expect(result).toContain('已记录您的收货确认')
  })

  it('无效身份验证返回失败', async () => {
    const tool = tools.get('ext_my_orders')!
    // Pass a non-external context
    const result = await tool.execute({}, { userId: 'admin', spaceIds: [SPACE_ID], activeSpaceId: SPACE_ID })
    expect(result).toBe('身份验证失败')
  })
})

describe('交叉隔离验证 (Cross-isolation)', () => {
  it('供应商无法看到客户数据', async () => {
    const supplierCtx = makeExtCtx(supplierId, '华瑞隆钢材有限公司', 'supplier')
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, supplierCtx)
    expect(result).not.toContain('中建三局')
    expect(result).not.toContain('4,100')
    expect(result).not.toContain('101,250')
  })

  it('客户无法看到供应商数据', async () => {
    const customerCtx = makeExtCtx(customerId, '中建三局项目部', 'customer')
    const tool = tools.get('ext_my_orders')!
    const result = await tool.execute({}, customerCtx)
    expect(result).not.toContain('华瑞隆')
    expect(result).not.toContain('3,800')
    expect(result).not.toContain('190,000')
  })

  it('物流无法看到交易金额', async () => {
    const logisticsCtx = makeExtCtx(logisticsId, '顺达物流', 'logistics')
    const orderTool = tools.get('ext_my_orders')!
    const result = await orderTool.execute({}, logisticsCtx)
    expect(result).not.toContain('190,000')
    expect(result).not.toContain('164,000')
  })
})
