import { useState, useEffect } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { MasterDataPanel } from './MasterDataPanel'
import s from './QueryView.module.css'

type QueryTab = 'inventory' | 'receivable' | 'payable' | 'reconciliation' | 'master'

const TABS: Array<{ key: QueryTab; label: string }> = [
  { key: 'inventory', label: '库存' },
  { key: 'receivable', label: '应收' },
  { key: 'payable', label: '应付' },
  { key: 'reconciliation', label: '项目对账' },
  { key: 'master', label: '基础数据' },
]

export function QueryView() {
  const [queryTab, setQueryTab] = useState<QueryTab>('inventory')

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
        {queryTab === 'inventory' && <InventoryList />}
        {queryTab === 'receivable' && <ReceivableList />}
        {queryTab === 'payable' && <PayableList />}
        {queryTab === 'reconciliation' && <ReconciliationList />}
        {queryTab === 'master' && <MasterDataPanel />}
      </div>
    </div>
  )
}

function InventoryList() {
  const { inventory, loading, loadInventory } = useBizStore()
  useEffect(() => { loadInventory() }, [loadInventory])

  if (loading && !inventory.length) return <div className={s.empty}>加载中...</div>
  if (!inventory.length) return <div className={s.empty}>暂无库存数据</div>

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
        {inventory.map(item => (
          <div key={item.productId} className={s.tr} data-warn={item.stockTons < 0}>
            <span className={s.td} style={{ flex: 2 }}>
              <span className={s.brand}>{item.brand}</span>
              <span className={s.spec}>{item.name} {item.spec}</span>
            </span>
            <span className={s.td}>{item.purchaseTons.toFixed(1)}</span>
            <span className={s.td}>{item.salesTons.toFixed(1)}</span>
            <span className={s.td} data-highlight={item.stockTons > 0}>{item.stockTons.toFixed(1)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

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
        {receivables.map(item => (
          <div key={item.customerId} className={s.tr}>
            <span className={s.td} style={{ flex: 2 }}>{item.name}</span>
            <span className={s.td}>{fmtShort(item.totalSales)}</span>
            <span className={s.td}>{fmtShort(item.received)}</span>
            <span className={s.td} data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

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
        {payables.map(item => (
          <div key={item.supplierId} className={s.tr}>
            <span className={s.td} style={{ flex: 2 }}>{item.name}</span>
            <span className={s.td}>{fmtShort(item.totalPurchases)}</span>
            <span className={s.td}>{fmtShort(item.paid)}</span>
            <span className={s.td} data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
          </div>
        ))}
      </div>
    </>
  )
}

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtShort(n: number): string {
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万'
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 0 })
}

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
        {reconciliation.map(item => (
          <div key={item.projectId} className={s.tr}>
            <span className={s.td} style={{ flex: 2 }}>
              <span className={s.brand}>{item.status === 'active' ? '' : item.status === 'completed' ? '[完]' : '[停]'}</span>
              <span className={s.spec}>{item.projectName}</span>
            </span>
            <span className={s.td}>{fmtShort(item.totalSales)}</span>
            <span className={s.td}>{fmtShort(item.totalLogistics)}</span>
            <span className={s.td}>{fmtShort(item.totalPaymentsIn)}</span>
            <span className={s.td} data-highlight={item.outstanding > 0}>{fmtShort(item.outstanding)}</span>
          </div>
        ))}
      </div>
    </>
  )
}
