import { useState } from 'react'
import { useBizStore } from '../../stores/bizStore'
import type { BizProduct, BizCounterparty } from '../../types'
import s from './MasterDataPanel.module.css'

type MasterTab = 'products' | 'counterparties'

const TABS: Array<{ key: MasterTab; label: string }> = [
  { key: 'products', label: '产品' },
  { key: 'counterparties', label: '供应商/客户' },
]

export function MasterDataPanel() {
  const [tab, setTab] = useState<MasterTab>('products')

  return (
    <div className={s.panel}>
      <div className={s.subTabs}>
        {TABS.map(t => (
          <button key={t.key} className={s.subTab} data-active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'products' && <ProductManager />}
      {tab === 'counterparties' && <CounterpartyManager />}
    </div>
  )
}

// ── Product Manager ─────────────────────────────────────────────

function ProductManager() {
  const { products, addProduct, editProduct, removeProduct } = useBizStore()
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ brand: '', name: '', spec: '', code: '' })
  const [msg, setMsg] = useState('')

  const filtered = filter
    ? products.filter(p => `${p.brand} ${p.name} ${p.spec} ${p.code}`.toLowerCase().includes(filter.toLowerCase()))
    : products

  const startEdit = (p: BizProduct) => {
    setEditing(p.id)
    setForm({ brand: p.brand, name: p.name, spec: p.spec, code: p.code })
    setAdding(false)
  }

  const startAdd = () => {
    setAdding(true)
    setEditing(null)
    setForm({ brand: '', name: '', spec: '', code: '' })
  }

  const handleSave = async () => {
    if (!form.name) { setMsg('品名不能为空'); return }
    setMsg('')
    try {
      if (editing) {
        await editProduct(editing, form)
        setEditing(null)
      } else {
        await addProduct({ ...form, category: '钢材', measureType: '理计' })
        setAdding(false)
      }
      setForm({ brand: '', name: '', spec: '', code: '' })
      setMsg('保存成功')
    } catch (e: any) { setMsg('错误: ' + e.message) }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除产品「${name}」？`)) return
    try {
      await removeProduct(id)
    } catch (e: any) { setMsg('错误: ' + e.message) }
  }

  return (
    <div className={s.manager}>
      <div className={s.toolbar}>
        <input className={s.search} value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索产品..." />
        <button className={s.addBtn} onClick={startAdd}>+ 新增</button>
      </div>
      {(adding || editing) && (
        <div className={s.formRow}>
          <input className={s.fi} placeholder="品牌" value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} />
          <input className={s.fi} placeholder="品名*" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <input className={s.fi} placeholder="规格" value={form.spec} onChange={e => setForm({ ...form, spec: e.target.value })} />
          <input className={s.fi} placeholder="编码" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
          <button className={s.saveBtn} onClick={handleSave}>保存</button>
          <button className={s.cancelBtn} onClick={() => { setAdding(false); setEditing(null) }}>取消</button>
        </div>
      )}
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
      <div className={s.count}>{filtered.length} 条记录</div>
      <div className={s.list}>
        {filtered.map(p => (
          <div key={p.id} className={s.item}>
            <div className={s.itemMain}>
              <span className={s.itemBrand}>{p.brand}</span>
              <span className={s.itemName}>{p.name} {p.spec}</span>
              <span className={s.itemCode}>{p.code}</span>
            </div>
            <div className={s.itemActions}>
              <button className={s.editBtn} onClick={() => startEdit(p)}>编辑</button>
              <button className={s.delBtn} onClick={() => handleDelete(p.id, `${p.brand} ${p.name}`)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Counterparty Manager ────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = { supplier: '供应商', customer: '客户', logistics: '物流', both: '供应商+客户' }
const TYPE_OPTIONS = [
  { value: 'supplier', label: '供应商' },
  { value: 'customer', label: '客户' },
  { value: 'logistics', label: '物流' },
  { value: 'both', label: '供应商+客户' },
]

function CounterpartyManager() {
  const { counterparties, addCounterparty, editCounterparty, removeCounterparty } = useBizStore()
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', type: 'supplier' as BizCounterparty['type'], contact: '', phone: '' })
  const [msg, setMsg] = useState('')

  const filtered = filter
    ? counterparties.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()))
    : counterparties

  const startEdit = (c: BizCounterparty) => {
    setEditing(c.id)
    setForm({ name: c.name, type: c.type, contact: c.contact || '', phone: c.phone || '' })
    setAdding(false)
  }

  const startAdd = () => {
    setAdding(true)
    setEditing(null)
    setForm({ name: '', type: 'supplier', contact: '', phone: '' })
  }

  const handleSave = async () => {
    if (!form.name) { setMsg('名称不能为空'); return }
    setMsg('')
    try {
      if (editing) {
        await editCounterparty(editing, form)
        setEditing(null)
      } else {
        await addCounterparty(form)
        setAdding(false)
      }
      setForm({ name: '', type: 'supplier', contact: '', phone: '' })
      setMsg('保存成功')
    } catch (e: any) { setMsg('错误: ' + e.message) }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`确定删除「${name}」？关联的交易记录不会被删除。`)) return
    try {
      await removeCounterparty(id)
    } catch (e: any) { setMsg('错误: ' + e.message) }
  }

  return (
    <div className={s.manager}>
      <div className={s.toolbar}>
        <input className={s.search} value={filter} onChange={e => setFilter(e.target.value)} placeholder="搜索供应商/客户..." />
        <button className={s.addBtn} onClick={startAdd}>+ 新增</button>
      </div>
      {(adding || editing) && (
        <div className={s.formRow}>
          <input className={s.fi} placeholder="名称*" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <select className={s.fi} value={form.type} onChange={e => setForm({ ...form, type: e.target.value as BizCounterparty['type'] })}>
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input className={s.fi} placeholder="联系人" value={form.contact} onChange={e => setForm({ ...form, contact: e.target.value })} />
          <input className={s.fi} placeholder="电话" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
          <button className={s.saveBtn} onClick={handleSave}>保存</button>
          <button className={s.cancelBtn} onClick={() => { setAdding(false); setEditing(null) }}>取消</button>
        </div>
      )}
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
      <div className={s.count}>{filtered.length} 条记录</div>
      <div className={s.list}>
        {filtered.map(c => (
          <div key={c.id} className={s.item}>
            <div className={s.itemMain}>
              <span className={s.itemName}>{c.name}</span>
              <span className={s.itemTag} data-type={c.type}>{TYPE_LABELS[c.type] || c.type}</span>
              {c.contact && <span className={s.itemCode}>{c.contact} {c.phone}</span>}
            </div>
            <div className={s.itemActions}>
              <button className={s.editBtn} onClick={() => startEdit(c)}>编辑</button>
              <button className={s.delBtn} onClick={() => handleDelete(c.id, c.name)}>删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

