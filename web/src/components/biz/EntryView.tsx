import { useState } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { SearchSelect } from './SearchSelect'
import s from './EntryView.module.css'

// ── Shared helpers ──────────────────────────────────────────────

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function Input({ label, value, onChange, type = 'text', placeholder, step, listId }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; step?: string; listId?: string
}) {
  return (
    <div className={s.field}>
      <label className={s.label}>{label}</label>
      <input className={s.input} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} step={step} list={listId} autoComplete="off" />
    </div>
  )
}

// ── Logistics Form ──────────────────────────────────────────────

export function LogisticsForm() {
  const { counterparties, projects, createLogistic, addCounterparty, addProject } = useBizStore()
  const carriers = counterparties.filter(c => c.type === 'logistics')
  const projectOpts = projects.map(p => ({ id: p.id, label: p.name }))

  const [date, setDate] = useState(today())
  const [carrierId, setCarrierId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [destination, setDestination] = useState('')
  const [tonnage, setTonnage] = useState('')
  const [freight, setFreight] = useState('')
  const [liftingFee, setLiftingFee] = useState('')
  const [driver, setDriver] = useState('')
  const [licensePlate, setLicensePlate] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const totalFee = (parseFloat(freight) || 0) + (parseFloat(liftingFee) || 0)

  const handleSubmit = async () => {
    if (!date) { setMsg('请填写日期'); return }
    setSaving(true)
    setMsg('')
    try {
      await createLogistic({
        date, carrierId: carrierId || undefined,
        projectId: projectId || undefined,
        destination: destination || undefined,
        tonnage: parseFloat(tonnage) || undefined,
        freight: parseFloat(freight) || 0,
        liftingFee: parseFloat(liftingFee) || 0,
        totalFee: Math.round(totalFee * 100) / 100,
        driver: driver || undefined,
        licensePlate: licensePlate || undefined,
      })
      setMsg('物流录入成功!')
      setTonnage(''); setFreight(''); setLiftingFee(''); setDriver(''); setLicensePlate(''); setDestination('')
    } catch (e: any) {
      setMsg('错误: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className={s.form}>
      <Input label="日期" value={date} onChange={setDate} type="date" />
      <SearchSelect label="托运公司" value={carrierId} onChange={setCarrierId}
        options={carriers.map(c => ({ id: c.id, label: c.name }))} placeholder="搜索托运公司..."
        onQuickCreate={async (name) => (await addCounterparty({ name, type: 'logistics' })).id} />
      <Input label="目的地" value={destination} onChange={setDestination} placeholder="项目/工地名" />
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..."
        onQuickCreate={async (name) => (await addProject({ name })).id} />
      <Input label="吨位" value={tonnage} onChange={setTonnage} type="number" step="0.1" placeholder="0.0" />
      <div className={s.row}>
        <Input label="运费" value={freight} onChange={setFreight} type="number" placeholder="0" />
        <Input label="吊费" value={liftingFee} onChange={setLiftingFee} type="number" placeholder="0" />
      </div>
      <div className={s.computed}>费用合计: &yen;{totalFee.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
      <div className={s.row}>
        <Input label="司机" value={driver} onChange={setDriver} placeholder="可选" />
        <Input label="车牌号" value={licensePlate} onChange={setLicensePlate} placeholder="可选" />
      </div>
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : '保存物流'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}

// ── Payment Form ────────────────────────────────────────────────

export function PaymentForm() {
  const { counterparties, projects, createPayment, addCounterparty, addProject } = useBizStore()
  const projectOpts = projects.map(p => ({ id: p.id, label: p.name }))

  const [date, setDate] = useState(today())
  const [direction, setDirection] = useState<'in' | 'out'>('out')
  const [counterpartyId, setCounterpartyId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const handleSubmit = async () => {
    if (!counterpartyId || !amount) { setMsg('请填写对象和金额'); return }
    setSaving(true)
    setMsg('')
    try {
      await createPayment({
        date, direction, counterpartyId,
        projectId: projectId || undefined,
        amount: parseFloat(amount),
        method: method || undefined,
        notes: notes || undefined,
      })
      setMsg(`${direction === 'in' ? '收款' : '付款'}录入成功!`)
      setAmount(''); setMethod(''); setNotes('')
    } catch (e: any) {
      setMsg('错误: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className={s.form}>
      <Input label="日期" value={date} onChange={setDate} type="date" />
      <div className={s.field}>
        <label className={s.label}>类型</label>
        <div className={s.toggleRow}>
          <button className={s.toggle} data-active={direction === 'out'} onClick={() => setDirection('out')}>付款</button>
          <button className={s.toggle} data-active={direction === 'in'} onClick={() => setDirection('in')}>收款</button>
        </div>
      </div>
      <SearchSelect label="对象" value={counterpartyId} onChange={setCounterpartyId}
        options={counterparties.map(c => ({ id: c.id, label: `${c.name} (${c.type === 'supplier' ? '供应商' : c.type === 'customer' ? '客户' : c.type})` }))} placeholder="搜索供应商/客户..."
        onQuickCreate={async (name) => (await addCounterparty({ name, type: 'both' })).id} />
      <Input label="金额" value={amount} onChange={setAmount} type="number" step="0.01" placeholder="0.00" />
      <Input label="方式" value={method} onChange={setMethod} placeholder="转账/现金/承兑..." />
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..."
        onQuickCreate={async (name) => (await addProject({ name })).id} />
      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : direction === 'in' ? '保存收款' : '保存付款'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}
