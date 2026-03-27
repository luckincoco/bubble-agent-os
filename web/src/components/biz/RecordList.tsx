import { useState, useEffect } from 'react'
import { useBizStore } from '../../stores/bizStore'
import type {
  BizPurchase, BizSale, BizLogisticsRecord, BizPayment, BizInvoice,
} from '../../types'
import s from './RecordList.module.css'

type RecordType = 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice'

interface Props {
  type: RecordType
}

export function RecordList({ type }: Props) {
  const store = useBizStore()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    const loaders: Record<RecordType, () => Promise<void>> = {
      purchase: () => store.loadPurchases(),
      sale: () => store.loadSales(),
      logistics: () => store.loadLogistics(),
      payment: () => store.loadPayments(),
      invoice: () => store.loadInvoices(),
    }
    loaders[type]()
  }, [type])

  const records = getRecords(type, store)
  const counterparties = store.counterparties
  const products = store.products
  const projects = store.projects

  const getName = (id: string | undefined, list: Array<{ id: string; name: string }>) =>
    list.find(i => i.id === id)?.name || id || '-'

  const getProductLabel = (pid: string) => {
    const p = products.find(i => i.id === pid)
    return p ? `${p.brand} ${p.name} ${p.spec}`.trim() : pid
  }

  const handleDelete = async (id: string, removeFn: (id: string) => Promise<void>) => {
    if (!confirm('确认删除这条记录？')) return
    setDeleting(id)
    try {
      await removeFn(id)
    } catch {
      alert('删除失败')
    }
    setDeleting(null)
  }

  if (store.loading && records.length === 0) {
    return <div className={s.empty}>加载中...</div>
  }
  if (records.length === 0) {
    return <div className={s.empty}>暂无记录</div>
  }

  return (
    <div className={s.list}>
      {records.map(rec => {
        const row = formatRow(type, rec, getName, getProductLabel)
        const details = formatDetails(type, rec, getName, getProductLabel)
        const expanded = expandedId === rec.id
        return (
          <div key={rec.id} className={s.card} data-expanded={expanded}>
            <div className={s.row} onClick={() => setExpandedId(expanded ? null : rec.id)}>
              <span className={s.date}>{row.date}</span>
              <span className={s.main}>{row.main}</span>
              <span className={s.amount}>{row.amount}</span>
              <span className={s.arrow}>{expanded ? '\u25B2' : '\u25BC'}</span>
            </div>
            {expanded && (
              <div className={s.detail}>
                {details.map((d, i) => (
                  <div key={i} className={s.detailRow}>
                    <span className={s.detailLabel}>{d.label}</span>
                    <span className={s.detailValue}>{d.value}</span>
                  </div>
                ))}
                <button
                  className={s.deleteBtn}
                  disabled={deleting === rec.id}
                  onClick={() => handleDelete(rec.id, getRemoveFn(type, store))}
                >
                  {deleting === rec.id ? '删除中...' : '删除'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────

type AnyRecord = { id: string; date: string; [k: string]: unknown }

function getRecords(type: RecordType, store: ReturnType<typeof useBizStore.getState>): AnyRecord[] {
  const map: Record<RecordType, unknown[]> = {
    purchase: store.purchases,
    sale: store.sales,
    logistics: store.logistics,
    payment: store.payments,
    invoice: store.invoices,
  }
  return (map[type] as AnyRecord[]).slice().sort((a, b) => {
    if (a.date > b.date) return -1
    if (a.date < b.date) return 1
    return 0
  })
}

function getRemoveFn(type: RecordType, store: ReturnType<typeof useBizStore.getState>) {
  const map: Record<RecordType, (id: string) => Promise<void>> = {
    purchase: store.removePurchase,
    sale: store.removeSale,
    logistics: store.removeLogistic,
    payment: store.removePayment,
    invoice: store.removeInvoice,
  }
  return map[type]
}

type NameFn = (id: string | undefined, list: Array<{ id: string; name: string }>) => string
type ProdFn = (id: string) => string

interface RowSummary { date: string; main: string; amount: string }
interface DetailItem { label: string; value: string }

function fmtMoney(n: number): string {
  return '\u00A5' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatRow(type: RecordType, rec: AnyRecord, getName: NameFn, getProd: ProdFn): RowSummary {
  switch (type) {
    case 'purchase': {
      const r = rec as unknown as BizPurchase
      return { date: r.date, main: getProd(r.productId), amount: fmtMoney(r.totalAmount) }
    }
    case 'sale': {
      const r = rec as unknown as BizSale
      return { date: r.date, main: getProd(r.productId), amount: fmtMoney(r.totalAmount) }
    }
    case 'logistics': {
      const r = rec as unknown as BizLogisticsRecord
      return { date: r.date, main: r.destination || '-', amount: fmtMoney(r.totalFee) }
    }
    case 'payment': {
      const r = rec as unknown as BizPayment
      const dir = r.direction === 'in' ? '[收]' : '[付]'
      return { date: r.date, main: dir, amount: fmtMoney(r.amount) }
    }
    case 'invoice': {
      const r = rec as unknown as BizInvoice
      const dir = r.direction === 'in' ? '[进项]' : '[销项]'
      return { date: r.date, main: dir, amount: fmtMoney(r.amount) }
    }
  }
}

function formatDetails(type: RecordType, rec: AnyRecord, getName: NameFn, getProd: ProdFn): DetailItem[] {
  const store = useBizStore.getState()
  const cp = store.counterparties
  const proj = store.projects

  switch (type) {
    case 'purchase': {
      const r = rec as unknown as BizPurchase
      return [
        { label: '供应商', value: getName(r.supplierId, cp) },
        { label: '产品', value: getProd(r.productId) },
        { label: '数量', value: `${r.tonnage}` },
        { label: '单价', value: `${r.unitPrice}` },
        { label: '金额', value: fmtMoney(r.totalAmount) },
        ...(r.projectId ? [{ label: '项目', value: getName(r.projectId, proj) }] : []),
        ...(r.notes ? [{ label: '备注', value: r.notes }] : []),
      ]
    }
    case 'sale': {
      const r = rec as unknown as BizSale
      return [
        { label: '客户', value: getName(r.customerId, cp) },
        { label: '产品', value: getProd(r.productId) },
        { label: '数量', value: `${r.tonnage}` },
        { label: '单价', value: `${r.unitPrice}` },
        { label: '金额', value: fmtMoney(r.totalAmount) },
        ...(r.projectId ? [{ label: '项目', value: getName(r.projectId, proj) }] : []),
        ...(r.notes ? [{ label: '备注', value: r.notes }] : []),
      ]
    }
    case 'logistics': {
      const r = rec as unknown as BizLogisticsRecord
      return [
        ...(r.carrierId ? [{ label: '托运公司', value: getName(r.carrierId, cp) }] : []),
        ...(r.destination ? [{ label: '目的地', value: r.destination }] : []),
        ...(r.tonnage ? [{ label: '吨位', value: `${r.tonnage}` }] : []),
        { label: '运费', value: fmtMoney(r.freight) },
        { label: '吊费', value: fmtMoney(r.liftingFee) },
        { label: '合计', value: fmtMoney(r.totalFee) },
        ...(r.driver ? [{ label: '司机', value: r.driver }] : []),
        ...(r.licensePlate ? [{ label: '车牌', value: r.licensePlate }] : []),
        ...(r.projectId ? [{ label: '项目', value: getName(r.projectId, proj) }] : []),
      ]
    }
    case 'payment': {
      const r = rec as unknown as BizPayment
      return [
        { label: '类型', value: r.direction === 'in' ? '收款' : '付款' },
        { label: '对象', value: getName(r.counterpartyId, cp) },
        { label: '金额', value: fmtMoney(r.amount) },
        ...(r.method ? [{ label: '方式', value: r.method }] : []),
        ...(r.projectId ? [{ label: '项目', value: getName(r.projectId, proj) }] : []),
        ...(r.notes ? [{ label: '备注', value: r.notes }] : []),
      ]
    }
    case 'invoice': {
      const r = rec as unknown as BizInvoice
      return [
        { label: '类型', value: r.direction === 'in' ? '进项发票' : '销项发票' },
        { label: '对象', value: getName(r.counterpartyId, cp) },
        ...(r.invoiceNo ? [{ label: '发票号', value: r.invoiceNo }] : []),
        { label: '金额', value: fmtMoney(r.amount) },
        { label: '税率', value: `${r.taxRate}%` },
        ...(r.taxAmount != null ? [{ label: '税额', value: fmtMoney(r.taxAmount) }] : []),
        ...(r.totalAmount != null ? [{ label: '含税', value: fmtMoney(r.totalAmount) }] : []),
        ...(r.notes ? [{ label: '备注', value: r.notes }] : []),
      ]
    }
  }
}
