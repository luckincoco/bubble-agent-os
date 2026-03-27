import { useState, useEffect, useMemo } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { SearchSelect } from './SearchSelect'
import type { BizProduct, BizCounterparty, BizProject } from '../../types'
import s from './EntryView.module.css'

type EntryType = 'purchase' | 'sale' | 'logistics' | 'payment'

const ENTRY_TABS: Array<{ key: EntryType; label: string }> = [
  { key: 'purchase', label: '采购' },
  { key: 'sale', label: '销售' },
  { key: 'logistics', label: '物流' },
  { key: 'payment', label: '收付款' },
]

export function EntryView() {
  const [entryType, setEntryType] = useState<EntryType>('purchase')

  return (
    <div className={s.container}>
      <div className={s.tabs}>
        {ENTRY_TABS.map(t => (
          <button key={t.key} className={s.tab} data-active={entryType === t.key} onClick={() => setEntryType(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className={s.formArea}>
        {entryType === 'purchase' && <PurchaseForm />}
        {entryType === 'sale' && <SaleForm />}
        {entryType === 'logistics' && <LogisticsForm />}
        {entryType === 'payment' && <PaymentForm />}
      </div>
    </div>
  )
}

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

type MeasureUnit = 'ton' | 'piece' | 'bar' | 'block' | 'meter' | 'set' | 'sheet'
const UNIT_LABELS: Record<MeasureUnit, string> = { ton: '吨', piece: '只', bar: '根', block: '块', meter: '米', set: '套', sheet: '张' }
const PRICE_LABELS: Record<MeasureUnit, string> = { ton: '元/吨', piece: '元/只', bar: '元/根', block: '元/块', meter: '元/米', set: '元/套', sheet: '元/张' }
const QTY_LABELS: Record<MeasureUnit, string> = { ton: '吨位', piece: '只数', bar: '根数', block: '块数', meter: '米数', set: '套数', sheet: '张数' }

/** Extract unique values from products for datalist suggestions */
function useProductSuggestions(products: BizProduct[]) {
  return useMemo(() => {
    const brands = [...new Set(products.map(p => p.brand).filter(Boolean))]
    const names = [...new Set(products.map(p => p.name).filter(Boolean))]
    const specs = [...new Set(products.map(p => p.spec).filter(Boolean))]
    return { brands, names, specs }
  }, [products])
}

/** Find matching product by brand+name+spec, or create a new one */
async function findOrCreateProduct(
  products: BizProduct[],
  addProduct: (data: Partial<BizProduct>) => Promise<void>,
  brand: string, name: string, spec: string, unit: MeasureUnit,
): Promise<string> {
  const match = products.find(p =>
    p.brand === brand && p.name === name && p.spec === spec
  )
  if (match) return match.id

  // Create new product
  const code = `${brand}-${name}-${spec}`.replace(/\s+/g, '')
  await addProduct({
    code, brand, name, spec,
    category: '钢材',
    measureType: UNIT_LABELS[unit],
  })
  // Re-read from store to get the new product with ID
  const store = useBizStore.getState()
  const created = store.products.find(p => p.brand === brand && p.name === name && p.spec === spec)
  if (!created) throw new Error('产品创建失败')
  return created.id
}

// ── Purchase Form ───────────────────────────────────────────────

export function PurchaseForm() {
  const { products, counterparties, projects, createPurchase, addProduct } = useBizStore()
  const suppliers = counterparties.filter(c => c.type === 'supplier' || c.type === 'both')
  const projectOpts = projects.map(p => ({ id: p.id, label: p.name }))
  const { brands, names, specs } = useProductSuggestions(products)

  const [date, setDate] = useState(today())
  const [supplierId, setSupplierId] = useState('')
  const [brand, setBrand] = useState('')
  const [productName, setProductName] = useState('')
  const [spec, setSpec] = useState('')
  const [unit, setUnit] = useState<MeasureUnit>('ton')
  const [bundleCount, setBundleCount] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [projectId, setProjectId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const qty = parseFloat(quantity) || 0
  const price = parseFloat(unitPrice) || 0
  const totalAmount = qty * price

  const handleSubmit = async () => {
    if (!supplierId || !productName || !quantity || !unitPrice) {
      setMsg('请填写供应商、材质、数量和单价')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      const productId = await findOrCreateProduct(products, addProduct, brand, productName, spec, unit)
      await createPurchase({
        date, supplierId, productId,
        bundleCount: bundleCount ? parseInt(bundleCount) : undefined,
        tonnage: qty,
        unitPrice: price,
        totalAmount: Math.round(totalAmount * 100) / 100,
        projectId: projectId || undefined,
        notes: notes || undefined,
      })
      const isNew = !products.find(p => p.brand === brand && p.name === productName && p.spec === spec)
      setMsg(isNew ? '采购录入成功! (新产品已自动入库)' : '采购录入成功!')
      setBundleCount(''); setQuantity(''); setUnitPrice(''); setNotes('')
    } catch (e: any) {
      setMsg('错误: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className={s.form}>
      <Input label="日期" value={date} onChange={setDate} type="date" />
      <SearchSelect label="供应商" value={supplierId} onChange={setSupplierId}
        options={suppliers.map(c => ({ id: c.id, label: c.name }))} placeholder="搜索供应商..." />
      <div className={s.row}>
        <Input label="品牌" value={brand} onChange={setBrand} placeholder="如: 沙钢" listId="dl-brand" />
        <Input label="材质" value={productName} onChange={setProductName} placeholder="如: 螺纹钢" listId="dl-name" />
      </div>
      <Input label="规格" value={spec} onChange={setSpec} placeholder="如: 12mm" listId="dl-spec" />
      <datalist id="dl-brand">{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id="dl-name">{names.map(n => <option key={n} value={n} />)}</datalist>
      <datalist id="dl-spec">{specs.map(s => <option key={s} value={s} />)}</datalist>
      <div className={s.field}>
        <label className={s.label}>计量单位</label>
        <div className={s.toggleRow}>
          {(Object.keys(UNIT_LABELS) as MeasureUnit[]).map(u => (
            <button key={u} className={s.toggle} data-active={unit === u} onClick={() => setUnit(u)}>{UNIT_LABELS[u]}</button>
          ))}
        </div>
      </div>
      <div className={s.row}>
        <Input label="件数" value={bundleCount} onChange={setBundleCount} type="number" placeholder="可选" />
        <Input label={QTY_LABELS[unit]} value={quantity} onChange={setQuantity} type="number" step="0.001" placeholder="0" />
        <Input label={`单价(${PRICE_LABELS[unit]})`} value={unitPrice} onChange={setUnitPrice} type="number" step="1" placeholder="0" />
      </div>
      <div className={s.computed}>合计: &yen;{totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..." />
      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : '保存采购'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}

// ── Sale Form ───────────────────────────────────────────────────

export function SaleForm() {
  const { products, counterparties, projects, createSale, addProduct } = useBizStore()
  const customers = counterparties.filter(c => c.type === 'customer' || c.type === 'both')
  const projectOpts = projects.map(p => ({ id: p.id, label: p.name }))
  const { brands, names, specs } = useProductSuggestions(products)

  const [date, setDate] = useState(today())
  const [customerId, setCustomerId] = useState('')
  const [brand, setBrand] = useState('')
  const [productName, setProductName] = useState('')
  const [spec, setSpec] = useState('')
  const [unit, setUnit] = useState<MeasureUnit>('ton')
  const [bundleCount, setBundleCount] = useState('')
  const [quantity, setQuantity] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [projectId, setProjectId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const qty = parseFloat(quantity) || 0
  const price = parseFloat(unitPrice) || 0
  const totalAmount = qty * price

  const handleSubmit = async () => {
    if (!customerId || !productName || !quantity || !unitPrice) {
      setMsg('请填写客户、材质、数量和单价')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      const productId = await findOrCreateProduct(products, addProduct, brand, productName, spec, unit)
      await createSale({
        date, customerId, productId,
        bundleCount: bundleCount ? parseInt(bundleCount) : undefined,
        tonnage: qty,
        unitPrice: price,
        totalAmount: Math.round(totalAmount * 100) / 100,
        projectId: projectId || undefined,
        notes: notes || undefined,
      })
      setMsg('销售录入成功!')
      setBundleCount(''); setQuantity(''); setUnitPrice(''); setNotes('')
    } catch (e: any) {
      setMsg('错误: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className={s.form}>
      <Input label="日期" value={date} onChange={setDate} type="date" />
      <SearchSelect label="客户" value={customerId} onChange={setCustomerId}
        options={customers.map(c => ({ id: c.id, label: c.name }))} placeholder="搜索客户..." />
      <div className={s.row}>
        <Input label="品牌" value={brand} onChange={setBrand} placeholder="如: 沙钢" listId="dl-brand-s" />
        <Input label="材质" value={productName} onChange={setProductName} placeholder="如: 螺纹钢" listId="dl-name-s" />
      </div>
      <Input label="规格" value={spec} onChange={setSpec} placeholder="如: 12mm" listId="dl-spec-s" />
      <datalist id="dl-brand-s">{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id="dl-name-s">{names.map(n => <option key={n} value={n} />)}</datalist>
      <datalist id="dl-spec-s">{specs.map(s => <option key={s} value={s} />)}</datalist>
      <div className={s.field}>
        <label className={s.label}>计量单位</label>
        <div className={s.toggleRow}>
          {(Object.keys(UNIT_LABELS) as MeasureUnit[]).map(u => (
            <button key={u} className={s.toggle} data-active={unit === u} onClick={() => setUnit(u)}>{UNIT_LABELS[u]}</button>
          ))}
        </div>
      </div>
      <div className={s.row}>
        <Input label="件数" value={bundleCount} onChange={setBundleCount} type="number" placeholder="可选" />
        <Input label={QTY_LABELS[unit]} value={quantity} onChange={setQuantity} type="number" step="0.001" placeholder="0" />
        <Input label={`单价(${PRICE_LABELS[unit]})`} value={unitPrice} onChange={setUnitPrice} type="number" step="1" placeholder="0" />
      </div>
      <div className={s.computed}>合计: &yen;{totalAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}</div>
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..." />
      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : '保存销售'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}

// ── Logistics Form ──────────────────────────────────────────────

export function LogisticsForm() {
  const { counterparties, projects, createLogistic } = useBizStore()
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
        options={carriers.map(c => ({ id: c.id, label: c.name }))} placeholder="搜索托运公司..." />
      <Input label="目的地" value={destination} onChange={setDestination} placeholder="项目/工地名" />
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..." />
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
  const { counterparties, projects, createPayment } = useBizStore()
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
        options={counterparties.map(c => ({ id: c.id, label: `${c.name} (${c.type === 'supplier' ? '供应商' : c.type === 'customer' ? '客户' : c.type})` }))} placeholder="搜索供应商/客户..." />
      <Input label="金额" value={amount} onChange={setAmount} type="number" step="0.01" placeholder="0.00" />
      <Input label="方式" value={method} onChange={setMethod} placeholder="转账/现金/承兑..." />
      <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..." />
      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />
      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : direction === 'in' ? '保存收款' : '保存付款'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}
