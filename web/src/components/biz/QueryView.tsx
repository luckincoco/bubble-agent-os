import { useState, useEffect } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { MasterDataPanel } from './MasterDataPanel'
import s from './QueryView.module.css'

type QueryTab = 'overview' | 'inventory' | 'receivable' | 'payable' | 'reconciliation' | 'master'

const TABS: Array<{ key: QueryTab; label: string }> = [
  { key: 'overview', label: '概况' },
  { key: 'inventory', label: '库存' },
  { key: 'receivable', label: '应收' },
  { key: 'payable', label: '应付' },
  { key: 'reconciliation', label: '项目对账' },
  { key: 'master', label: '基础数据' },
]

export function QueryView() {
  const [queryTab, setQueryTab] = useState<QueryTab>('overview')

  return (
    <div className={s.container}>
      <div className={s.tabs}>
        {TABS.map(t => (
          <button key={t.key} className={s.tab} data-active={queryTab === t.key} onClick={() => setQueryTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className={s.content}>
        {queryTab === 'overview' && <DashboardOverview />}
        {queryTab === 'inventory' && <InventoryList />}
        {queryTab === 'receivable' && <ReceivableList />}
        {queryTab === 'payable' && <PayableList />}
        {queryTab === 'reconciliation' && <ReconciliationList />}
        {queryTab === 'master' && <MasterDataPanel />}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtShort(n: number): string {
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

function rateClass(rate: number): string {
  if (rate >= 80) return s.rateGood
  if (rate >= 50) return s.rateWarn
  return s.rateBad
}

function progressColor(ratio: number): string {
  if (ratio > 0.95) return '#f87171'
  if (ratio > 0.8) return '#FBBF24'
  return '#14B8A6'
}

// ── Dashboard Overview (概况) ─────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  purchase: '采购', sale: '销售', logistics: '物流',
  payment_in: '收款', payment_out: '付款',
}

const TYPE_COLORS: Record<string, string> = {
  purchase: '#a855f7', sale: '#2dd4bf', logistics: '#60a5fa',
  payment_in: '#4ade80', payment_out: '#f87171',
}

function DashboardOverview() {
  const {
    dashboard, loadDashboard,
    inventory, loadInventory,
    receivables, loadReceivables,
    payables, loadPayables,
    loading,
  } = useBizStore()

  useEffect(() => {
    loadDashboard()
    loadInventory()
    loadReceivables()
    loadPayables()
  }, [loadDashboard, loadInventory, loadReceivables, loadPayables])

  if (loading && !dashboard) return <div className={s.empty}>加载中...</div>

  // Compute alerts
  const negativeStock = inventory.filter(i => i.stockTons < 0)
  const largeReceivables = receivables.filter(r => r.outstanding > 100000)
  const largePayables = payables.filter(p => p.outstanding > 100000)
  const hasAlerts = negativeStock.length > 0 || largeReceivables.length > 0 || largePayables.length > 0

  return (
    <>
      {/* KPI Cards */}
      <div className={s.kpiRow}>
        <div className={s.kpiCard} style={{ borderTopColor: '#14B8A6' }}>
          <span className={s.kpiLabel}>库存</span>
          <span className={s.kpiValue}>{dashboard ? dashboard.totalStockTons.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '-'} 吨</span>
        </div>
        <div className={s.kpiCard} style={{ borderTopColor: '#4ade80' }}>
          <span className={s.kpiLabel}>应收</span>
          <span className={s.kpiValue}>&yen;{dashboard ? fmtShort(dashboard.totalReceivable) : '-'}</span>
        </div>
        <div className={s.kpiCard} style={{ borderTopColor: '#f87171' }}>
          <span className={s.kpiLabel}>应付</span>
          <span className={s.kpiValue}>&yen;{dashboard ? fmtShort(dashboard.totalPayable) : '-'}</span>
        </div>
      </div>

      {/* Alerts */}
      <div className={s.sectionTitle}>异常提醒</div>
      {!hasAlerts ? (
        <div className={s.noAlert}>暂无异常</div>
      ) : (
        <div className={s.alertList}>
          {negativeStock.map(item => (
            <div key={item.productId} className={s.alertItem} style={{ borderLeftColor: '#f87171' }}>
              <span className={s.alertBadge} style={{ background: 'rgba(248,113,113,0.15)', color: '#f87171' }}>负库存</span>
              <span className={s.alertName}>{item.brand} {item.name} {item.spec}</span>
              <span className={s.alertValue}>{item.stockTons.toFixed(1)} 吨</span>
            </div>
          ))}
          {largeReceivables.map(item => (
            <div key={item.customerId} className={s.alertItem} style={{ borderLeftColor: '#FBBF24' }}>
              <span className={s.alertBadge} style={{ background: 'rgba(251,191,36,0.15)', color: '#FBBF24' }}>大额应收</span>
              <span className={s.alertName}>{item.name}</span>
              <span className={s.alertValue}>&yen;{fmtShort(item.outstanding)}</span>
            </div>
          ))}
          {largePayables.map(item => (
            <div key={item.supplierId} className={s.alertItem} style={{ borderLeftColor: '#FBBF24' }}>
              <span className={s.alertBadge} style={{ background: 'rgba(251,191,36,0.15)', color: '#FBBF24' }}>大额应付</span>
              <span className={s.alertName}>{item.name}</span>
              <span className={s.alertValue}>&yen;{fmtShort(item.outstanding)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Transactions */}
      {dashboard && dashboard.recentTransactions.length > 0 && (
        <>
          <div className={s.sectionTitle}>最近动态</div>
          <div className={s.recentList}>
            {dashboard.recentTransactions.map((tx, i) => (
              <div key={i} className={s.recentItem}>
                <span className={s.recentDate}>{tx.date}</span>
                <span className={s.recentBadge} style={{ background: `${TYPE_COLORS[tx.type] ?? '#64748B'}22`, color: TYPE_COLORS[tx.type] ?? '#64748B' }}>
                  {TYPE_LABELS[tx.type] ?? tx.type}
                </span>
                <span className={s.recentName}>{tx.counterparty}</span>
                <span className={s.recentAmount}>&yen;{fmtShort(tx.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ── Inventory (库存) ──────────────────────────────────────────────────

function InventoryList() {
  const { inventory, loading, loadInventory } = useBizStore()
  useEffect(() => { loadInventory() }, [loadInventory])

  if (loading && !inventory.length) return <div className={s.empty}>加载中...</div>
  if (!inventory.length) return <div className={s.empty}>暂无库存数据</div>

  // Sort by urgency: negative stock first (most negative first), then largest stock first
  const sorted = [...inventory].sort((a, b) => {
    if (a.stockTons < 0 && b.stockTons >= 0) return -1
    if (b.stockTons < 0 && a.stockTons >= 0) return 1
    if (a.stockTons < 0 && b.stockTons < 0) return a.stockTons - b.stockTons
    return b.stockTons - a.stockTons
  })

  const total = inventory.reduce((s, i) => s + i.stockTons, 0)

  return (
    <>
      <div className={s.summary}>库存总计: <strong>{total.toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 吨</strong></div>
      <div className={s.table}>
        <div className={s.thead}>
          <span className={s.th} style={{ flex: 2 }}>产品</span>
          <span className={s.th}>采购</span>
          <span className={s.th}>销售</span>
          <span className={s.th}>库存</span>
        </div>
        {sorted.map(item => {
          const ratio = item.purchaseTons > 0 ? item.salesTons / item.purchaseTons : 0
          return (
            <div key={item.productId} className={s.tr} data-warn={item.stockTons < 0}>
              <span className={s.td} style={{ flex: 2 }} data-label="产品">
                <span className={s.brand}>{item.brand}</span>
                <span className={s.spec}>{item.name} {item.spec}</span>
              </span>
              <span className={s.td} data-label="采购">{item.purchaseTons.toFixed(1)}</span>
              <span className={s.td} data-label="销售">{item.salesTons.toFixed(1)}</span>
              <span className={s.td} data-label="库存" data-highlight={item.stockTons > 0}>
                {item.stockTons.toFixed(1)}
                {item.purchaseTons > 0 && (
                  <div className={s.progressTrack}>
                    <div className={s.progressFill} style={{ width: `${Math.min(100, ratio * 100)}%`, background: progressColor(ratio) }} />
                  </div>
                )}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Receivables (应收) ────────────────────────────────────────────────

function ReceivableList() {
  const { receivables, loading, loadReceivables } = useBizStore()
  useEffect(() => { loadReceivables() }, [loadReceivables])

  if (loading && !receivables.length) return <div className={s.empty}>加载中...</div>
  if (!receivables.length) return <div className={s.empty}>暂无应收数据</div>

  const total = receivables.reduce((s, r) => s + r.outstanding, 0)

  return (
    <>
      <div className={s.summary}>应收总计: <strong>&yen;{fmtMoney(total)}</strong></div>
      <div className={s.table}>
        <div className={s.thead}>
          <span className={s.th} style={{ flex: 2 }}>客户</span>
          <span className={s.th}>销售额</span>
          <span className={s.th}>已收</span>
          <span className={s.th}>未收</span>
        </div>
        {receivables.map(item => {
          const rate = item.totalSales > 0 ? (item.received / item.totalSales) * 100 : 0
          const ratio = item.totalSales > 0 ? item.received / item.totalSales : 0
          return (
            <div key={item.customerId} className={s.tr}>
              <span className={s.td} style={{ flex: 2 }} data-label="客户">{item.name}</span>
              <span className={s.td} data-label="销售额">{fmtShort(item.totalSales)}</span>
              <span className={s.td} data-label="已收">
                {fmtShort(item.received)}
                <span className={`${s.rateBadge} ${rateClass(rate)}`}>{rate.toFixed(0)}%</span>
                <div className={s.progressTrack}>
                  <div className={s.progressFill} style={{ width: `${Math.min(100, ratio * 100)}%`, background: rate >= 80 ? '#4ade80' : rate >= 50 ? '#FBBF24' : '#f87171' }} />
                </div>
              </span>
              <span className={s.td} data-label="未收" data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Payables (应付) ───────────────────────────────────────────────────

function PayableList() {
  const { payables, loading, loadPayables } = useBizStore()
  useEffect(() => { loadPayables() }, [loadPayables])

  if (loading && !payables.length) return <div className={s.empty}>加载中...</div>
  if (!payables.length) return <div className={s.empty}>暂无应付数据</div>

  const total = payables.reduce((s, p) => s + p.outstanding, 0)

  return (
    <>
      <div className={s.summary}>应付总计: <strong>&yen;{fmtMoney(total)}</strong></div>
      <div className={s.table}>
        <div className={s.thead}>
          <span className={s.th} style={{ flex: 2 }}>供应商</span>
          <span className={s.th}>采购额</span>
          <span className={s.th}>已付</span>
          <span className={s.th}>未付</span>
        </div>
        {payables.map(item => {
          const rate = item.totalPurchases > 0 ? (item.paid / item.totalPurchases) * 100 : 0
          const ratio = item.totalPurchases > 0 ? item.paid / item.totalPurchases : 0
          return (
            <div key={item.supplierId} className={s.tr}>
              <span className={s.td} style={{ flex: 2 }} data-label="供应商">{item.name}</span>
              <span className={s.td} data-label="采购额">{fmtShort(item.totalPurchases)}</span>
              <span className={s.td} data-label="已付">
                {fmtShort(item.paid)}
                <span className={`${s.rateBadge} ${rateClass(rate)}`}>{rate.toFixed(0)}%</span>
                <div className={s.progressTrack}>
                  <div className={s.progressFill} style={{ width: `${Math.min(100, ratio * 100)}%`, background: rate >= 80 ? '#4ade80' : rate >= 50 ? '#FBBF24' : '#f87171' }} />
                </div>
              </span>
              <span className={s.td} data-label="未付" data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ── Reconciliation (项目对账) ─────────────────────────────────────────

function ReconciliationList() {
  const { reconciliation, loading, loadReconciliation } = useBizStore()
  useEffect(() => { loadReconciliation() }, [loadReconciliation])

  if (loading && !reconciliation.length) return <div className={s.empty}>加载中...</div>
  if (!reconciliation.length) return <div className={s.empty}>暂无项目数据</div>

  const totalOutstanding = reconciliation.reduce((sum, r) => sum + r.outstanding, 0)

  return (
    <>
      <div className={s.summary}>项目应收总计: <strong>&yen;{fmtMoney(totalOutstanding)}</strong></div>
      <div className={s.table}>
        <div className={s.thead}>
          <span className={s.th} style={{ flex: 2 }}>项目</span>
          <span className={s.th}>销售额</span>
          <span className={s.th}>物流费</span>
          <span className={s.th}>已收</span>
          <span className={s.th}>未收</span>
        </div>
        {reconciliation.map(item => {
          const rate = item.totalSales > 0 ? (item.totalPaymentsIn / item.totalSales) * 100 : 0
          const ratio = item.totalSales > 0 ? item.totalPaymentsIn / item.totalSales : 0
          return (
            <div key={item.projectId} className={s.tr}>
              <span className={s.td} style={{ flex: 2 }} data-label="项目">
                <span className={s.brand}>{item.status === 'active' ? '' : item.status === 'completed' ? '[完]' : '[停]'}</span>
                <span className={s.spec}>{item.projectName}</span>
              </span>
              <span className={s.td} data-label="销售额">{fmtShort(item.totalSales)}</span>
              <span className={s.td} data-label="物流费">{fmtShort(item.totalLogistics)}</span>
              <span className={s.td} data-label="已收">
                {fmtShort(item.totalPaymentsIn)}
                {item.totalSales > 0 && <span className={`${s.rateBadge} ${rateClass(rate)}`}>{rate.toFixed(0)}%</span>}
                {item.totalSales > 0 && (
                  <div className={s.progressTrack}>
                    <div className={s.progressFill} style={{ width: `${Math.min(100, ratio * 100)}%`, background: rate >= 80 ? '#4ade80' : rate >= 50 ? '#FBBF24' : '#f87171' }} />
                  </div>
                )}
              </span>
              <span className={s.td} data-label="未收" data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}
