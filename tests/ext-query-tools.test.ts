import { describe, it, expect, beforeEach, vi } from 'vitest'

const {
  mockGetPurchases, mockGetSales, mockGetPayments, mockGetLogistics,
  mockGetStatement, mockLogAction, mockSwitchBinding, mockListBindings, mockClearCache,
} = vi.hoisted(() => ({
  mockGetPurchases: vi.fn(),
  mockGetSales: vi.fn(),
  mockGetPayments: vi.fn(),
  mockGetLogistics: vi.fn(),
  mockGetStatement: vi.fn(),
  mockLogAction: vi.fn(),
  mockSwitchBinding: vi.fn(),
  mockListBindings: vi.fn(),
  mockClearCache: vi.fn(),
}))

vi.mock('../src/connector/biz/structured-store.js', () => ({
  getPurchases: mockGetPurchases,
  getSales: mockGetSales,
  getPayments: mockGetPayments,
  getLogistics: mockGetLogistics,
}))
vi.mock('../src/connector/biz/reports.js', () => ({
  getCounterpartyStatement: mockGetStatement,
}))
vi.mock('../src/connector/biz/external-store.js', () => ({
  logExternalAction: mockLogAction,
  switchActiveBinding: mockSwitchBinding,
  listUserBindings: mockListBindings,
}))
vi.mock('../src/connector/identity.js', () => ({
  clearIdentityCache: mockClearCache,
}))

import { createExtQueryTools } from '../src/connector/tools/ext-query-tools.js'

// ── External context for success paths ────────────────────────

const extCtx = {
  userId: 'ext-1',
  activeSpaceId: 'space-1',
  isExternal: true,
  counterpartyId: 'cp-1',
  counterpartyName: '钢铁公司',
  counterpartyType: 'supplier' as const,
  permissionLevel: 'query_confirm' as const,
  platformUserId: 'wx_u1',
  platform: 'wecom' as const,
}

const adminCtx = { userId: 'admin-1', activeSpaceId: 'space-1' }

const sampleRows = [
  { date: '2026-01-15', productId: '螺纹钢', tonnage: 50, unitPrice: 3800, totalAmount: 190000, docStatus: 'confirmed' },
]

describe('createExtQueryTools', () => {
  let tools: Record<string, any>

  beforeEach(() => {
    vi.clearAllMocks()
    const defs = createExtQueryTools()
    tools = {}
    for (const t of defs) tools[t.name] = t
  })

  // ── ext_my_orders ──────────────────────────────────────────

  describe('ext_my_orders', () => {
    it('rejects non-external context', async () => {
      const result = await tools.ext_my_orders.execute({}, adminCtx)
      expect(result).toContain('身份验证失败')
    })

    it('returns purchase data for supplier counterparty', async () => {
      mockGetPurchases.mockReturnValue(sampleRows)
      const result = await tools.ext_my_orders.execute({}, extCtx)
      expect(result).toContain('采购记录')
      expect(result).toContain('钢铁公司')
      expect(result).toContain('螺纹钢')
      expect(mockGetPurchases).toHaveBeenCalled()
    })

    it('returns sales data for customer counterparty', async () => {
      const customerCtx = { ...extCtx, counterpartyType: 'customer' as const }
      mockGetSales.mockReturnValue(sampleRows)
      const result = await tools.ext_my_orders.execute({}, customerCtx)
      expect(result).toContain('销售记录')
      expect(mockGetSales).toHaveBeenCalled()
    })

    it('shows empty message when no orders', async () => {
      mockGetPurchases.mockReturnValue([])
      const result = await tools.ext_my_orders.execute({}, extCtx)
      expect(result).toContain('暂无')
    })

    it('passes date_from and date_to parameters', async () => {
      mockGetPurchases.mockReturnValue(sampleRows)
      await tools.ext_my_orders.execute({ date_from: '2026-01-01', date_to: '2026-01-31' }, extCtx)
      expect(mockGetPurchases).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }),
      )
    })
  })

  // ── ext_my_payments ────────────────────────────────────────

  describe('ext_my_payments', () => {
    it('rejects non-external context', async () => {
      const result = await tools.ext_my_payments.execute({}, adminCtx)
      expect(result).toContain('身份验证失败')
    })

    it('returns payment records', async () => {
      mockGetPayments.mockReturnValue([
        { date: '2026-01-15', direction: 'in', amount: 50000, method: '转账', docStatus: 'confirmed' },
      ])
      const result = await tools.ext_my_payments.execute({}, extCtx)
      expect(result).toContain('付款记录')
      expect(result).toContain('钢铁公司')
      expect(result).toContain('转账')
    })

    it('shows empty message when no payments', async () => {
      mockGetPayments.mockReturnValue([])
      const result = await tools.ext_my_payments.execute({}, extCtx)
      expect(result).toContain('暂无')
    })
  })

  // ── ext_my_logistics ───────────────────────────────────────

  describe('ext_my_logistics', () => {
    it('returns logistics records', async () => {
      mockGetLogistics.mockReturnValue([
        { date: '2026-01-20', destination: '上海仓库', tonnage: 50, waybillNo: 'WB001', docStatus: 'completed' },
      ])
      const result = await tools.ext_my_logistics.execute({}, extCtx)
      expect(result).toContain('物流记录')
      expect(result).toContain('上海仓库')
      expect(result).toContain('WB001')
    })

    it('shows empty message when no logistics', async () => {
      mockGetLogistics.mockReturnValue([])
      const result = await tools.ext_my_logistics.execute({}, extCtx)
      expect(result).toContain('暂无')
    })
  })

  // ── ext_price_inquiry ──────────────────────────────────────

  describe('ext_price_inquiry', () => {
    it('creates price inquiry', async () => {
      const result = await tools.ext_price_inquiry.execute(
        { product: '螺纹钢', spec: 'Φ25', quantity: '50吨', notes: '急用' }, extCtx,
      )
      expect(result).toContain('询价')
      expect(result).toContain('螺纹钢')
      expect(mockLogAction).toHaveBeenCalled()
    })
  })

  // ── ext_confirm_receipt ────────────────────────────────────

  describe('ext_confirm_receipt', () => {
    it('rejects when permission level is too low', async () => {
      const readerCtx = { ...extCtx, permissionLevel: 'query' as const }
      const result = await tools.ext_confirm_receipt.execute({ date: '2026-01-15' }, readerCtx)
      expect(result).toContain('没有确认权限')
    })

    it('confirms receipt with sufficient permission', async () => {
      const result = await tools.ext_confirm_receipt.execute(
        { date: '2026-01-15', product: '螺纹钢', notes: '已到货' }, extCtx,
      )
      expect(result).toContain('收货确认')
      expect(result).toContain('螺纹钢')
    })
  })

  // ── ext_payment_status ─────────────────────────────────────

  describe('ext_payment_status', () => {
    it('returns statement data', async () => {
      mockGetStatement.mockReturnValue({
        rows: [{ date: '2026-01-15', type: '采购', description: '螺纹钢', debit: 190000, credit: 0, balance: 190000 }],
        closingBalance: 190000,
      })
      const result = await tools.ext_payment_status.execute({}, extCtx)
      expect(result).toContain('对账单')
      expect(result).toContain('190,000')
      expect(result).toContain('期末余额')
    })

    it('shows empty message when no statement', async () => {
      mockGetStatement.mockReturnValue(null)
      const result = await tools.ext_payment_status.execute({}, extCtx)
      expect(result).toContain('暂无')
    })
  })

  // ── ext_switch_role ────────────────────────────────────────

  describe('ext_switch_role', () => {
    it('switches to target company successfully', async () => {
      mockListBindings.mockReturnValue([
        { counterpartyId: 'cp-1', counterpartyName: '钢铁公司', isActive: true },
        { counterpartyId: 'cp-2', counterpartyName: '物流公司', isActive: false },
      ])
      mockSwitchBinding.mockReturnValue(true)

      const result = await tools.ext_switch_role.execute({ company_name: '物流公司' }, extCtx)
      expect(result).toContain('已切换到')
      expect(result).toContain('物流公司')
      expect(mockSwitchBinding).toHaveBeenCalledWith('wecom', 'wx_u1', 'cp-2')
      expect(mockClearCache).toHaveBeenCalled()
    })

    it('shows message when only one binding exists', async () => {
      mockListBindings.mockReturnValue([
        { counterpartyId: 'cp-1', counterpartyName: '钢铁公司', isActive: true },
      ])
      const result = await tools.ext_switch_role.execute({ company_name: '其他公司' }, extCtx)
      expect(result).toContain('仅绑定了')
    })

    it('shows current identity when already on target', async () => {
      // Need 2+ bindings to pass the length check before target comparison
      mockListBindings.mockReturnValue([
        { counterpartyId: 'cp-1', counterpartyName: '钢铁公司', isActive: true },
        { counterpartyId: 'cp-2', counterpartyName: '物流公司', isActive: false },
      ])
      const result = await tools.ext_switch_role.execute({ company_name: '钢铁公司' }, extCtx)
      expect(result).toContain('已经在')
    })

    it('requires company_name parameter', async () => {
      const result = await tools.ext_switch_role.execute({ company_name: '' }, extCtx)
      expect(result).toContain('请提供目标公司名称')
    })
  })
})
