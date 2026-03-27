import { useState } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { SearchSelect } from './SearchSelect'
import s from './EntryView.module.css'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function Input({ label, value, onChange, type = 'text', placeholder, step }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; step?: string
}) {
  return (
    <div className={s.field}>
      <label className={s.label}>{label}</label>
      <input className={s.input} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} step={step} autoComplete="off" />
    </div>
  )
}

export function InvoiceForm() {
  const { counterparties, createInvoice } = useBizStore()

  const [date, setDate] = useState(today())
  const [direction, setDirection] = useState<'in' | 'out'>('out')
  const [counterpartyId, setCounterpartyId] = useState('')
  const [invoiceNo, setInvoiceNo] = useState('')
  const [amount, setAmount] = useState('')
  const [taxRate, setTaxRate] = useState('13')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const amt = parseFloat(amount) || 0
  const rate = parseFloat(taxRate) || 0
  const taxAmount = Math.round(amt * rate) / 100
  const totalAmount = amt + taxAmount

  const handleSubmit = async () => {
    if (!counterpartyId || !amount) {
      setMsg('请填写对象和金额')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      await createInvoice({
        date,
        direction,
        counterpartyId,
        invoiceNo: invoiceNo || undefined,
        amount: amt,
        taxRate: rate,
        notes: notes || undefined,
      })
      setMsg(`${direction === 'in' ? '进项' : '销项'}发票录入成功!`)
      setInvoiceNo('')
      setAmount('')
      setNotes('')
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
          <button className={s.toggle} data-active={direction === 'out'} onClick={() => setDirection('out')}>销项发票</button>
          <button className={s.toggle} data-active={direction === 'in'} onClick={() => setDirection('in')}>进项发票</button>
        </div>
      </div>
      <SearchSelect
        label="对象"
        value={counterpartyId}
        onChange={setCounterpartyId}
        options={counterparties.map(c => ({ id: c.id, label: c.name }))}
        placeholder="搜索供应商/客户..."
      />
      <Input label="发票号" value={invoiceNo} onChange={setInvoiceNo} placeholder="可选" />
      <div className={s.row}>
        <Input label="不含税金额" value={amount} onChange={setAmount} type="number" step="0.01" placeholder="0.00" />
        <Input label="税率(%)" value={taxRate} onChange={setTaxRate} type="number" step="1" placeholder="13" />
      </div>
      <div className={s.computed}>
        税额: &yen;{taxAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })} | 含税: &yen;{totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
      </div>
      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : direction === 'in' ? '保存进项发票' : '保存销项发票'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}
