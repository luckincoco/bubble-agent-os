import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock paths must resolve to the same modules used by src/connector/tools/biz-query-tools.ts
vi.mock('../src/connector/biz/structured-store.js', () => ({
  getDashboard: vi.fn(),
  getInventory: vi.fn(),
  getReceivables: vi.fn(),
  getPayables: vi.fn(),
  getCounterparties: vi.fn(),
  fuzzyFindCounterparty: vi.fn(),
  getProjectReconciliation: vi.fn(),
  getUninvoicedAmount: vi.fn(),
  getExposure: vi.fn(),
  getSilenceAlerts: vi.fn(),
  computeLindyDays: vi.fn(),
  getConcentrationMetrics: vi.fn(),
}))

vi.mock('../src/connector/biz/reports.js', () => ({
  getProfitReport: vi.fn(),
  getCounterpartyStatement: vi.fn(),
  getMonthlyOverview: vi.fn(),
  getProfitByOrder: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  searchBubbles: vi.fn(),
}))

import { createBizQueryTools } from '../src/connector/tools/biz-query-tools.js'
import * as store from '../src/connector/biz/structured-store.js'
import * as reports from '../src/connector/biz/reports.js'

describe('biz-query-tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createBizQueryTools', () => {
    it('creates 15 tools with correct names', () => {
      const tools = createBizQueryTools()
      expect(tools).toHaveLength(15)
      const names = tools.map(t => t.name)
      expect(names).toContain('biz_dashboard')
      expect(names).toContain('biz_inventory')
      expect(names).toContain('biz_receivables')
      expect(names).toContain('biz_payables')
      expect(names).toContain('biz_profit_report')
      expect(names).toContain('biz_profit_by_order')
      expect(names).toContain('biz_counterparty_statement')
      expect(names).toContain('biz_monthly_overview')
      expect(names).toContain('biz_project_reconciliation')
      expect(names).toContain('biz_uninvoiced')
      expect(names).toContain('biz_excel_lookup')
      expect(names).toContain('biz_silence_alerts')
      expect(names).toContain('biz_exposure')
      expect(names).toContain('biz_relationships')
      expect(names).toContain('biz_concentration')
    })

    it('each tool has name, description, parameters, execute', () => {
      const tools = createBizQueryTools()
      for (const tool of tools) {
        expect(tool.name).toBeTruthy()
        expect(tool.description).toBeTruthy()
        expect(typeof tool.parameters).toBe('object')
        expect(typeof tool.execute).toBe('function')
      }
    })
  })

  // ── biz_dashboard ──────────────────────────────────────────

  describe('biz_dashboard', () => {
    it('returns overview with today data and recent transactions', async () => {
      vi.mocked(store.getDashboard).mockReturnValue({
        todayPurchases: 3, todaySales: 2, todayLogistics: 1,
        totalStockTons: 500, totalReceivable: 200000, totalPayable: 150000,
        recentTransactions: [
          { type: '采购', date: '2024-06-15', counterparty: '供应商A', product: '螺纹钢', amount: 100000 },
        ],
      })

      const [dashboardTool] = createBizQueryTools()
      const result = await dashboardTool.execute({}, { activeSpaceId: 'space-1' } as any) as string

      expect(result).toContain('今日采购 3 笔')
      expect(result).toContain('库存')
      expect(result).toContain('供应商A')
    })

    it('handles empty recent transactions', async () => {
      vi.mocked(store.getDashboard).mockReturnValue({
        todayPurchases: 0, todaySales: 0, todayLogistics: 0,
        totalStockTons: 0, totalReceivable: 0, totalPayable: 0,
        recentTransactions: [],
      })

      const [dashboardTool] = createBizQueryTools()
      const result = await dashboardTool.execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('今日采购 0 笔')
      expect(result).not.toContain('最近交易')
    })
  })

  // ── biz_inventory ───────────────────────────────────────────

  describe('biz_inventory', () => {
    it('returns inventory with totals row', async () => {
      vi.mocked(store.getInventory).mockReturnValue([
        { brand: '品牌A', name: '螺纹钢', spec: 'HRB400', purchaseTons: 200, salesTons: 150, stockTons: 50 },
      ])

      const tools = createBizQueryTools()
      const inventoryTool = tools[1]
      const result = await inventoryTool.execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('品牌A')
      expect(result).toContain('螺纹钢')
      expect(result).toContain('合计')
    })

    it('filters by product keyword', async () => {
      vi.mocked(store.getInventory).mockReturnValue([
        { brand: '品牌A', name: '螺纹钢', spec: 'HRB400', purchaseTons: 200, salesTons: 150, stockTons: 50 },
        { brand: '品牌B', name: '盘螺', spec: 'Ø8', purchaseTons: 100, salesTons: 60, stockTons: 40 },
      ])

      const tools = createBizQueryTools()
      const result = await tools[1].execute({ product: '盘螺' }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('盘螺')
      expect(result).not.toContain('螺纹钢')
    })

    it('returns empty message when no items', async () => {
      vi.mocked(store.getInventory).mockReturnValue([])
      const tools = createBizQueryTools()
      const result = await tools[1].execute({ product: '不存在' }, { activeSpaceId: 's-1' } as any) as string
      expect(result).toContain('没有找到')
    })
  })

  // ── biz_receivables / biz_payables ──────────────────────────

  describe('biz_receivables', () => {
    it('returns table with totals', async () => {
      vi.mocked(store.getReceivables).mockReturnValue([
        { name: '客户A', totalSales: 500000, received: 300000, outstanding: 200000 },
      ])

      const tools = createBizQueryTools()
      const result = await tools[2].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('客户A')
      expect(result).toContain('200,000') // outstanding
    })
  })

  describe('biz_payables', () => {
    it('returns table with totals', async () => {
      vi.mocked(store.getPayables).mockReturnValue([
        { name: '供应商A', totalPurchases: 800000, paid: 500000, outstanding: 300000 },
      ])

      const tools = createBizQueryTools()
      const result = await tools[3].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('供应商A')
      expect(result).toContain('300,000')
    })
  })

  // ── biz_profit_report ───────────────────────────────────────

  describe('biz_profit_report', () => {
    it('returns report with totals row', async () => {
      vi.mocked(store.fuzzyFindCounterparty).mockReturnValue(null)
      vi.mocked(store.getCounterparties).mockReturnValue([])
      vi.mocked(reports.getProfitReport).mockReturnValue([
        { month: '2024-06', salesRevenue: 200000, purchaseCost: 120000, logisticsCost: 5000, grossProfit: 75000, margin: 37.5, salesTons: 50, purchaseTons: 80 },
      ])

      const tools = createBizQueryTools()
      const result = await tools[4].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('2024-06')
      expect(result).toContain('200,000')
      expect(result).toContain('37.5')
      expect(result).toContain('合计')
    })

    it('returns empty message when no data', async () => {
      vi.mocked(reports.getProfitReport).mockReturnValue([])
      const tools = createBizQueryTools()
      const result = await tools[4].execute({ date_from: '2025-01-01', date_to: '2025-12-31' }, { activeSpaceId: 's-1' } as any) as string
      expect(result).toContain('暂无利润数据')
    })
  })

  // ── biz_counterparty_statement ──────────────────────────────

  describe('biz_counterparty_statement', () => {
    it('returns statement when counterparty found', async () => {
      vi.mocked(store.fuzzyFindCounterparty).mockReturnValue({ id: 'cp-1', name: '供应商A' })
      vi.mocked(reports.getCounterpartyStatement).mockReturnValue({
        counterpartyId: 'cp-1', counterpartyName: '供应商A',
        rows: [{ date: '2024-06-01', type: 'purchase', description: '采购', debit: 0, credit: 300000, balance: -300000 }],
        totalDebit: 0, totalCredit: 300000, closingBalance: -300000,
      } as any)

      const tools = createBizQueryTools()
      const result = await tools[6].execute({ counterparty: '供应商A' }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('供应商A')
      expect(result).toContain('300,000')
      expect(result).toContain('期末余额')
    })

    it('returns error when counterparty not found', async () => {
      vi.mocked(store.fuzzyFindCounterparty).mockReturnValue(null)
      vi.mocked(store.getCounterparties).mockReturnValue([])

      const tools = createBizQueryTools()
      const result = await tools[6].execute({ counterparty: '未知' }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('找不到')
    })

    it('returns error when counterparty param is empty', async () => {
      const tools = createBizQueryTools()
      const result = await tools[6].execute({}, { activeSpaceId: 's-1' } as any) as string
      expect(result).toContain('Error')
    })
  })

  // ── biz_monthly_overview ────────────────────────────────────

  describe('biz_monthly_overview', () => {
    it('returns filtered active months', async () => {
      vi.mocked(reports.getMonthlyOverview).mockReturnValue([
        { month: '2024-01', purchaseAmount: 0, purchaseTons: 0, salesAmount: 0, salesTons: 0, logisticsAmount: 0, paymentsIn: 0, paymentsOut: 0, invoicesIn: 0, invoicesOut: 0 },
        { month: '2024-06', purchaseAmount: 300000, purchaseTons: 100, salesAmount: 200000, salesTons: 50, logisticsAmount: 5000, paymentsIn: 0, paymentsOut: 100000, invoicesIn: 0, invoicesOut: 0 },
      ] as any)

      const tools = createBizQueryTools()
      const result = await tools[7].execute({ year: 2024 }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('2024-06')
      expect(result).toContain('300,000')
      expect(result).not.toContain('2024-01') // zero month filtered out
    })

    it('returns empty message when all months zero', async () => {
      vi.mocked(reports.getMonthlyOverview).mockReturnValue([
        { month: '2024-01', purchaseAmount: 0, purchaseTons: 0, salesAmount: 0, salesTons: 0, logisticsAmount: 0, paymentsIn: 0, paymentsOut: 0, invoicesIn: 0, invoicesOut: 0 },
      ] as any)

      const tools = createBizQueryTools()
      const result = await tools[7].execute({ year: 2024 }, { activeSpaceId: 's-1' } as any) as string
      expect(result).toContain('暂无业务数据')
    })
  })

  // ── biz_silence_alerts ──────────────────────────────────────

  describe('biz_silence_alerts', () => {
    it('returns alerts table', async () => {
      vi.mocked(store.getSilenceAlerts).mockReturnValue([
        { name: '旧客户', type: 'customer', lastDate: '2024-01-01', silentDays: 165, avgIntervalDays: 30, transactionCount: 5 },
      ])

      const tools = createBizQueryTools()
      const result = await tools[11].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('旧客户')
      expect(result).toContain('沉默预警')
    })
  })

  // ── biz_exposure ────────────────────────────────────────────

  describe('biz_exposure', () => {
    it('returns exposure data with net exposure summary', async () => {
      vi.mocked(store.getExposure).mockReturnValue({
        netExposure: 100000,
        totalReceivable: 300000,
        totalPayable: 200000,
        items: [
          { name: '客户B', type: 'customer', receivable: 300000, payable: 0, netExposure: 300000, lindyDays: 365 },
        ],
      })

      const tools = createBizQueryTools()
      const result = await tools[12].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('客户B')
      expect(result).toContain('净敞口')
    })
  })

  // ── biz_relationships ───────────────────────────────────────

  describe('biz_relationships', () => {
    it('returns counterparty relationships sorted by lindy', async () => {
      vi.mocked(store.getCounterparties).mockReturnValue([
        { name: '老合作', type: 'customer', firstInteraction: '2020-01-01' },
        { name: '新合作', type: 'supplier', firstInteraction: '2024-06-01' },
      ])
      vi.mocked(store.computeLindyDays).mockImplementation(
        (date: string | null | undefined) => date === '2020-01-01' ? 1400 : 300,
      )

      const tools = createBizQueryTools()
      const result = await tools[13].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('老合作')
      expect(result).toContain('新合作')
      expect(result).toContain('交易对手关系')
    })
  })

  // ── biz_concentration ───────────────────────────────────────

  describe('biz_concentration', () => {
    it('returns concentration analysis', async () => {
      vi.mocked(store.getConcentrationMetrics).mockReturnValue({
        supplierConcentration: {
          topN: 3, topNShare: 85, totalAmount: 1000000, warning: true,
          topItems: [{ name: '供应商A', amount: 500000, share: 50 }],
        },
        customerConcentration: {
          topN: 3, topNShare: 70, totalAmount: 800000, warning: false,
          topItems: [{ name: '客户B', amount: 400000, share: 40 }],
        },
        threshold: 60,
      } as any)

      const tools = createBizQueryTools()
      const result = await tools[14].execute({}, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('供应商A')
      expect(result).toContain('85%')
      expect(result).toContain('集中度分析')
    })
  })

  // ── biz_excel_lookup ────────────────────────────────────────

  describe('biz_excel_lookup', () => {
    it('returns excel data hits', async () => {
      const searchBubbles = vi.mocked((await import('../src/bubble/model.js')).searchBubbles)
      searchBubbles.mockReturnValue([
        { id: 'b-1', title: '采购单', content: '明细', tags: ['excel-summary'], source: 'excel-import' },
      ])

      const tools = createBizQueryTools()
      const result = await tools[10].execute({ query: '采购' }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('采购单')
      expect(result).toContain('Excel原始数据')
    })

    it('returns related records when no excel matches', async () => {
      const searchBubbles = vi.mocked((await import('../src/bubble/model.js')).searchBubbles)
      searchBubbles.mockReturnValue([
        { id: 'b-2', title: '相关记录', content: '内容摘要', tags: [], source: 'user' },
      ])

      const tools = createBizQueryTools()
      const result = await tools[10].execute({ query: '查询' }, { activeSpaceId: 's-1' } as any) as string

      expect(result).toContain('未找到Excel原始数据')
    })
  })
})
