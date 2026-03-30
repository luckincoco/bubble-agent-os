import { useState, useEffect, useMemo } from 'react'
import { useBizStore } from '../../stores/bizStore'
import type {
  BizPurchase, BizSale, BizLogisticsRecord, BizPayment, BizInvoice,
  DocStatus,
} from '../../types'
import s from './RecordList.module.css'

type RecordType = 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice'

interface Props {
  type: RecordType
}

const STATUS_LABELS: Record<DocStatus, string> = {
  draft: '草稿',
  confirmed: '已确认',
  completed: '已完成',
  cancelled: '已取消',
}

const FILTER_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'confirmed', label: '已确认' },
  { value: 'completed', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

// "Create From" actions available per docType when status is confirmed
const CREATE_FROM_ACTIONS: Record<RecordType, Array<{ action: string; label: string }>> = {
  sale: [
    { action: 'logistics-from-sale', label: '创建物流单' },
    { action: 'invoice-from-sale', label: '创建销项发票' },
  ],
  purchase: [
    { action: 'invoice-from-purchase', label: '创建进项发票' },
  ],
  logistics: [],
  payment: [],
  invoice: [],
}

const CP_FIELD: Record<RecordType, string> = {
  purchase: 'supplierId',
  sale: 'customerId',
  logistics: 'carrierId',
  payment: 'counterpartyId',
  invoice: 'counterpartyId',
}

const CP_LABEL: Record<RecordType, string> = {
  purchase: '供应商',
  sale: '客户',
  logistics: '承运商',
  payment: '对象',
  invoice: '对象',
}

export function RecordList({ type }: Props) {
  const store = useBizStore()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [counterpartyFilter, setCounterpartyFilter] = useState('')
  const [cpSearch, setCpSearch] = useState('')
  const [cpDropdownOpen, setCpDropdownOpen] = useState(false)

  useEffect(() => {
    setCounterpartyFilter('')
    setCpSearch('')
    const loaders: Record<RecordType, () => Promise<void>> = {
      purchase: () => store.loadPurchases(),
      sale: () => store.loadSales(),
      logistics: () => store.loadLogistics(),
      payment: () => store.loadPayments(),
      invoice: () => store.loadInvoices(),
    }
    loaders[type]()
  }, [type])

  const allRecords = getRecords(type, store)
  const counterparties = store.counterparties
  const products = store.products
  const projects = store.projects

  const getName = (id: string | undefined, list: Array<{ id: string; name: string }>) =>
    list.find(i => i.id === id)?.name || id || '-'

  const cpField = CP_FIELD[type]
  const cpOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const r of allRecords) {
      const id = (r as any)[cpField]
      if (id) ids.add(id)
    }
    return Array.from(ids)
      .map(id => ({ id, name: getName(id, counterparties) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [allRecords, counterparties, cpField])

  const filteredCpOptions = cpSearch
    ? cpOptions.filter(cp => cp.name.includes(cpSearch))
    : cpOptions

  let records = statusFilter === 'all'
    ? allRecords
    : allRecords.filter(r => (r as any).docStatus === statusFilter)
  if (counterpartyFilter) {
    records = records.filter(r => (r as any)[cpField] === counterpartyFilter)
  }

  const selectCp = (id: string, name: string) => {
    setCounterpartyFilter(id)
    setCpSearch(name)
    setCpDropdownOpen(false)
  }

  const clearCp = () => {
    setCounterpartyFilter('')
    setCpSearch('')
  }

  const getProductLabel = (pid: string) => {
    const p = products.find(i => i.id === pid)
    return p ? `${p.brand} ${p.name} ${p.spec}`.trim() : pid
  }

  const handleAction = async (action: string, id: string) => {
    setBusy(id)
    try {
      switch (action) {
        case 'confirm':
          await store.transitionDoc(type, id, 'confirmed')
          break
        case 'complete':
          await store.transitionDoc(type, id, 'completed')
          break
        case 'cancel': {
          const reason = prompt('请输入取消原因')
          if (!reason) { setBusy(null); return }
          await store.transitionDoc(type, id, 'cancelled', reason)
          break
        }
        case 'delete': {
          if (!confirm('确认删除这条草稿记录？')) { setBusy(null); return }
          await getRemoveFn(type, store)(id)
          break
        }
        case 'amend':
          await store.amendDoc(type, id)
          break
        default:
          // create-from actions
          if (action.includes('-from-')) {
            await store.createFrom(action, id)
            alert('下游单据已创建为草稿')
          }
      }
    } catch (err: any) {
      alert(err.message || '操作失败')
    }
    setBusy(null)
  }

  if (store.loading && records.length === 0) {
    return <div className={s.empty}>加载中...</div>
  }

  return (
    <>
      <div className={s.filterBar}>
        {FILTER_OPTIONS.map(opt => (
          <button
            key={opt.value}
            className={s.filterTab}
            data-active={statusFilter === opt.value}
            onClick={() => setStatusFilter(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      {cpOptions.length > 1 && (
        <div className={s.cpFilter}>
          <div className={s.cpCombobox}>
            <input
              className={s.cpInput}
              placeholder={`搜索${CP_LABEL[type]}...`}
              value={cpSearch}
              onChange={e => {
                const v = e.target.value
                setCpSearch(v)
                if (!v) setCounterpartyFilter('')
                setCpDropdownOpen(true)
              }}
              onFocus={() => setCpDropdownOpen(true)}
              onBlur={() => setTimeout(() => setCpDropdownOpen(false), 150)}
            />
            {cpDropdownOpen && filteredCpOptions.length > 0 && (
              <div className={s.cpDropdown}>
                {filteredCpOptions.map(cp => (
                  <div
                    key={cp.id}
                    className={s.cpOption}
                    data-active={counterpartyFilter === cp.id}
                    onMouseDown={() => selectCp(cp.id, cp.name)}
                  >
                    {cp.name}
                  </div>
                ))}
              </div>
            )}
          </div>
          {counterpartyFilter && (
            <button className={s.cpClear} onClick={clearCp}>
              清除
            </button>
          )}
        </div>
      )}
      {records.length === 0 ? (
        <div className={s.empty}>暂无记录</div>
      ) : (
        <div className={s.list}>
          {records.map(rec => {
            const row = formatRow(type, rec, getName, getProductLabel)
            const details = formatDetails(type, rec, getName, getProductLabel)
            const expanded = expandedId === rec.id
            const docStatus = (rec as any).docStatus as DocStatus | undefined
            const isBusy = busy === rec.id

            return (
              <div key={rec.id} className={s.card} data-expanded={expanded}>
                <div className={s.row} onClick={() => setExpandedId(expanded ? null : rec.id)}>
                  <span className={s.date}>{row.date}</span>
                  {docStatus && (
                    <span className={s.badge} data-status={docStatus}>
                      {STATUS_LABELS[docStatus] ?? docStatus}
                    </span>
                  )}
                  <span className={s.main}>{row.main}</span>
                  <span className={s.amount}>{row.amount}</span>
                  <span className={s.arrow}>{expanded ? '\u25B2' : '\u25BC'}</span>
                </div>
                {expanded && (
                  <div className={s.detail}>
                    {details.map((d, i) => (
                      <div key={i} className={s.detailRow}>
                        <span className={s.detailLabel}>{d.label}</span>
                        {d.cpId ? (
                          <span
                            className={`${s.detailValue} ${s.clickableCp}`}
                            onClick={(e) => { e.stopPropagation(); selectCp(d.cpId!, d.value) }}
                          >
                            {d.value}
                          </span>
                        ) : (
                          <span className={s.detailValue}>{d.value}</span>
                        )}
                      </div>
                    ))}
                    {/* Action bar based on status */}
                    <div className={s.actions}>
                      {docStatus === 'draft' && (
                        <>
                          {(type === 'purchase' || type === 'sale') && (
                            <button className={s.actionBtn} disabled={isBusy} onClick={() => setEditingId(editingId === rec.id ? null : rec.id)}>
                              {editingId === rec.id ? '取消编辑' : '编辑'}
                            </button>
                          )}
                          <button className={s.actionBtn} data-variant="confirm" disabled={isBusy} onClick={() => handleAction('confirm', rec.id)}>确认</button>
                          <button className={s.actionBtn} data-variant="danger" disabled={isBusy} onClick={() => handleAction('delete', rec.id)}>删除</button>
                        </>
                      )}
                      {docStatus === 'confirmed' && (
                        <>
                          <button className={s.actionBtn} data-variant="complete" disabled={isBusy} onClick={() => handleAction('complete', rec.id)}>完成</button>
                          <button className={s.actionBtn} disabled={isBusy} onClick={() => handleAction('amend', rec.id)}>修正</button>
                          <button className={s.actionBtn} data-variant="danger" disabled={isBusy} onClick={() => handleAction('cancel', rec.id)}>取消</button>
                          {CREATE_FROM_ACTIONS[type]?.map(a => (
                            <button key={a.action} className={s.actionBtn} disabled={isBusy} onClick={() => handleAction(a.action, rec.id)}>{a.label}</button>
                          ))}
                        </>
                      )}
                      {docStatus === 'completed' && (
                        <button className={s.actionBtn} data-variant="danger" disabled={isBusy} onClick={() => handleAction('cancel', rec.id)}>取消</button>
                      )}
                    </div>
                    {/* Inline edit form for drafts */}
                    {editingId === rec.id && docStatus === 'draft' && (
                      <InlineEditForm type={type} record={rec} onSaved={() => setEditingId(null)} />
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
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
interface DetailItem { label: string; value: string; cpId?: string }

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
        { label: '供应商', value: getName(r.supplierId, cp), cpId: r.supplierId },
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
        { label: '客户', value: getName(r.customerId, cp), cpId: r.customerId },
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
        ...(r.carrierId ? [{ label: '托运公司', value: getName(r.carrierId, cp), cpId: r.carrierId }] : []),
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
        { label: '对象', value: getName(r.counterpartyId, cp), cpId: r.counterpartyId },
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
        { label: '对象', value: getName(r.counterpartyId, cp), cpId: r.counterpartyId },
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

// ── Inline Edit Form (for draft purchases and sales) ─────────────

function InlineEditForm({ type, record, onSaved }: { type: RecordType; record: AnyRecord; onSaved: () => void }) {
  const store = useBizStore()
  const [saving, setSaving] = useState(false)

  if (type === 'purchase') {
    const r = record as unknown as BizPurchase
    return <PurchaseEditFields record={r} onSave={async (data) => {
      setSaving(true)
      try { await store.updatePurchase(r.id, data); onSaved() } catch (e: any) { alert(e.message) }
      setSaving(false)
    }} saving={saving} onCancel={onSaved} />
  }

  if (type === 'sale') {
    const r = record as unknown as BizSale
    return <SaleEditFields record={r} onSave={async (data) => {
      setSaving(true)
      try { await store.updateSale(r.id, data); onSaved() } catch (e: any) { alert(e.message) }
      setSaving(false)
    }} saving={saving} onCancel={onSaved} />
  }

  return null
}

function PurchaseEditFields({ record, onSave, saving, onCancel }: {
  record: BizPurchase
  onSave: (data: Partial<BizPurchase>) => void
  saving: boolean
  onCancel: () => void
}) {
  const [tonnage, setTonnage] = useState(String(record.tonnage))
  const [unitPrice, setUnitPrice] = useState(String(record.unitPrice))
  const [notes, setNotes] = useState(record.notes || '')

  const qty = parseFloat(tonnage) || 0
  const price = parseFloat(unitPrice) || 0
  const total = Math.round(qty * price * 100) / 100

  return (
    <div className={s.editForm}>
      <div className={s.editRow}>
        <span className={s.editLabel}>数量</span>
        <input className={s.editInput} type="number" step="0.001" value={tonnage} onChange={e => setTonnage(e.target.value)} />
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>单价</span>
        <input className={s.editInput} type="number" step="1" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} />
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>合计</span>
        <span className={s.editInput} style={{ background: 'transparent', border: 'none' }}>&yen;{total.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</span>
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>备注</span>
        <input className={s.editInput} value={notes} onChange={e => setNotes(e.target.value)} placeholder="可选" />
      </div>
      <div className={s.editActions}>
        <button className={s.editSave} disabled={saving} onClick={() => onSave({ tonnage: qty, unitPrice: price, totalAmount: total, notes: notes || undefined })}>
          {saving ? '保存中...' : '保存'}
        </button>
        <button className={s.editCancel} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}

function SaleEditFields({ record, onSave, saving, onCancel }: {
  record: BizSale
  onSave: (data: Partial<BizSale>) => void
  saving: boolean
  onCancel: () => void
}) {
  const [tonnage, setTonnage] = useState(String(record.tonnage))
  const [unitPrice, setUnitPrice] = useState(String(record.unitPrice))
  const [notes, setNotes] = useState(record.notes || '')

  const qty = parseFloat(tonnage) || 0
  const price = parseFloat(unitPrice) || 0
  const total = Math.round(qty * price * 100) / 100

  return (
    <div className={s.editForm}>
      <div className={s.editRow}>
        <span className={s.editLabel}>数量</span>
        <input className={s.editInput} type="number" step="0.001" value={tonnage} onChange={e => setTonnage(e.target.value)} />
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>单价</span>
        <input className={s.editInput} type="number" step="1" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} />
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>合计</span>
        <span className={s.editInput} style={{ background: 'transparent', border: 'none' }}>&yen;{total.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</span>
      </div>
      <div className={s.editRow}>
        <span className={s.editLabel}>备注</span>
        <input className={s.editInput} value={notes} onChange={e => setNotes(e.target.value)} placeholder="可选" />
      </div>
      <div className={s.editActions}>
        <button className={s.editSave} disabled={saving} onClick={() => onSave({ tonnage: qty, unitPrice: price, totalAmount: total, notes: notes || undefined })}>
          {saving ? '保存中...' : '保存'}
        </button>
        <button className={s.editCancel} onClick={onCancel}>取消</button>
      </div>
    </div>
  )
}
