import { useState, useMemo } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { SearchSelect } from './SearchSelect'
import { type BizLineInput } from '../../services/api'
import type { BizProduct } from '../../types'
import s from './PurchaseEventForm.module.css'

type WeighMode = '理计' | '过磅'
type MeasureUnit = 'ton' | 'piece' | 'bar' | 'block' | 'meter' | 'set' | 'sheet'
const UNIT_LABELS: Record<MeasureUnit, string> = { ton: '吨', piece: '只', bar: '根', block: '块', meter: '米', set: '套', sheet: '张' }
const PRICE_LABELS: Record<MeasureUnit, string> = { ton: '元/吨', piece: '元/只', bar: '元/根', block: '元/块', meter: '元/米', set: '元/套', sheet: '元/张' }

function today(): string { return new Date().toISOString().slice(0, 10) }

function Input({ label, value, onChange, type = 'text', placeholder, step, listId }: {
  label: string; value: string; onChange: (v: string) => void
  type?: string; placeholder?: string; step?: string; listId?: string
}) {
  return (
    <div className={s.field}>
      <label className={s.label}>{label}</label>
      <input className={s.input} type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} step={step} list={listId} autoComplete="off" />
    </div>
  )
}

interface LineState {
  key: number; brand: string; material: string; spec: string; unit: MeasureUnit
  weighMode: WeighMode; bundleCount: string; weightPerPc: string; quantity: string
  unitPrice: string; taxInclusive: boolean; notes: string
}

function emptyLine(key: number): LineState {
  return { key, brand: '', material: '', spec: '', unit: 'ton', weighMode: '理计',
    bundleCount: '', weightPerPc: '', quantity: '', unitPrice: '', taxInclusive: true, notes: '' }
}

function calcLineQty(line: LineState): number {
  if (line.weighMode === '理计') return (parseInt(line.bundleCount) || 0) * (parseFloat(line.weightPerPc) || 0)
  return parseFloat(line.quantity) || 0
}

function calcLineSubtotal(line: LineState): number {
  return calcLineQty(line) * (parseFloat(line.unitPrice) || 0)
}

function LineItemCard({ line, index, products, onChange, onRemove }: {
  line: LineState; index: number; products: BizProduct[]
  onChange: (updated: LineState) => void; onRemove: () => void
}) {
  const brands = useMemo(() => [...new Set(products.map(p => p.brand).filter(Boolean))], [products])
  const names = useMemo(() => [...new Set(products.map(p => p.name).filter(Boolean))], [products])
  const specs = useMemo(() => [...new Set(products.map(p => p.spec).filter(Boolean))], [products])
  const dlSuffix = `-se-${line.key}`
  const qty = calcLineQty(line)
  const subtotal = calcLineSubtotal(line)
  const update = (partial: Partial<LineState>) => onChange({ ...line, ...partial })

  return (
    <div className={s.lineCard}>
      <div className={s.lineHeader}>
        <span className={s.lineNo}>#{index + 1}</span>
        <button type="button" className={s.removeBtn} onClick={onRemove} title="删除行">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div className={s.row}>
        <Input label="品牌" value={line.brand} onChange={v => update({ brand: v })} placeholder="沙钢" listId={`dl-b${dlSuffix}`} />
        <Input label="材质" value={line.material} onChange={v => update({ material: v })} placeholder="螺纹钢" listId={`dl-n${dlSuffix}`} />
      </div>
      <Input label="规格" value={line.spec} onChange={v => update({ spec: v })} placeholder="12mm" listId={`dl-s${dlSuffix}`} />
      <datalist id={`dl-b${dlSuffix}`}>{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id={`dl-n${dlSuffix}`}>{names.map(n => <option key={n} value={n} />)}</datalist>
      <datalist id={`dl-s${dlSuffix}`}>{specs.map(v => <option key={v} value={v} />)}</datalist>

      <div className={s.row}>
        <div className={s.field}>
          <label className={s.label}>计量</label>
          <div className={s.toggleRow}>
            {(['ton', 'piece', 'bar', 'meter'] as MeasureUnit[]).map(u => (
              <button key={u} type="button" className={s.toggle} data-active={line.unit === u}
                onClick={() => update({ unit: u })}>{UNIT_LABELS[u]}</button>
            ))}
          </div>
        </div>
      </div>

      <div className={s.field}>
        <label className={s.label}>过磅方式</label>
        <div className={s.toggleRow}>
          <button type="button" className={s.toggle} data-active={line.weighMode === '理计'}
            onClick={() => update({ weighMode: '理计' })}>理计</button>
          <button type="button" className={s.toggle} data-active={line.weighMode === '过磅'}
            onClick={() => update({ weighMode: '过磅' })}>过磅</button>
        </div>
      </div>

      {line.weighMode === '理计' ? (
        <div className={s.row3}>
          <Input label="件数" value={line.bundleCount} onChange={v => update({ bundleCount: v })} type="number" placeholder="0" />
          <Input label="件重(吨/件)" value={line.weightPerPc} onChange={v => update({ weightPerPc: v })} type="number" step="0.001" placeholder="0.000" />
          <div className={s.field}>
            <label className={s.label}>理计重量</label>
            <div className={s.computed}>{qty.toFixed(3)} {UNIT_LABELS[line.unit]}</div>
          </div>
        </div>
      ) : (
        <Input label={`过磅重量(${UNIT_LABELS[line.unit]})`} value={line.quantity} onChange={v => update({ quantity: v })} type="number" step="0.001" placeholder="0.000" />
      )}

      <div className={s.row}>
        <Input label={`单价(${PRICE_LABELS[line.unit]})`} value={line.unitPrice} onChange={v => update({ unitPrice: v })} type="number" step="1" placeholder="0" />
        <div className={s.field}>
          <label className={s.label}>含税</label>
          <div className={s.toggleRow}>
            <button type="button" className={s.toggle} data-active={line.taxInclusive}
              onClick={() => update({ taxInclusive: true })}>含税</button>
            <button type="button" className={s.toggle} data-active={!line.taxInclusive}
              onClick={() => update({ taxInclusive: false })}>不含税</button>
          </div>
        </div>
      </div>

      <div className={s.lineSubtotal}>
        小计: &yen;{subtotal.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
      </div>
    </div>
  )
}

export function SaleEventForm({ onSuccess }: { onSuccess?: () => void } = {}) {
  const { products, counterparties, projects, addProduct, addCounterparty, addProject, createTrade } = useBizStore()
  const customers = counterparties.filter(c => c.type === 'customer' || c.type === 'both')
  const projectOpts = projects.map(p => ({ id: p.id, label: p.name }))

  // Header state
  const [date, setDate] = useState(today())
  const [customerId, setCustomerId] = useState('')
  const [location, setLocation] = useState('')
  const [docNo, setDocNo] = useState('')
  const [projectId, setProjectId] = useState('')
  const [notes, setNotes] = useState('')

  // Contact state (auto-filled from counterparty)
  const [contact, setContact] = useState('')
  const [phone, setPhone] = useState('')

  // Settlement state (v1.0.2)
  const [settlementMethod, setSettlementMethod] = useState<'cash' | 'transfer' | 'credit'>('cash')
  const [creditTermDays, setCreditTermDays] = useState('30')
  const [customCredit, setCustomCredit] = useState(false)

  // Payment state (only for cash/transfer)
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paidAmount, setPaidAmount] = useState('')

  // Logistics state (v1.0.2 — sales only)
  const [carrier, setCarrier] = useState('')
  const [freight, setFreight] = useState('')
  const [liftingFee, setLiftingFee] = useState('')
  const [destination, setDestination] = useState('')

  // Lines state
  const [lineKey, setLineKey] = useState(1)
  const [lines, setLines] = useState<LineState[]>([emptyLine(0)])

  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const grandTotal = lines.reduce((sum, l) => sum + calcLineSubtotal(l), 0)
  const totalQty = lines.reduce((sum, l) => sum + calcLineQty(l), 0)

  const updateLine = (idx: number, updated: LineState) => {
    setLines(prev => prev.map((l, i) => i === idx ? updated : l))
  }

  const removeLine = (idx: number) => {
    if (lines.length === 1) return
    setLines(prev => prev.filter((_, i) => i !== idx))
  }

  const addLine = () => {
    setLines(prev => [...prev, emptyLine(lineKey)])
    setLineKey(k => k + 1)
  }

  const resolveProduct = async (brand: string, material: string, spec: string, unit: MeasureUnit): Promise<string> => {
    const match = products.find(p => p.brand === brand && p.name === material && p.spec === spec)
    if (match) return match.id
    const code = `${brand}-${material}-${spec}`.replace(/\s+/g, '')
    await addProduct({ code, brand, name: material, spec, category: '钢材', measureType: UNIT_LABELS[unit] })
    const created = useBizStore.getState().products.find(p => p.brand === brand && p.name === material && p.spec === spec)
    if (!created) throw new Error('产品创建失败')
    return created.id
  }

  const handleSubmit = async () => {
    if (!customerId) { setMsg('请选择客户'); return }
    const validLines = lines.filter(l => l.material && calcLineQty(l) > 0 && (parseFloat(l.unitPrice) > 0))
    if (validLines.length === 0) { setMsg('请至少填写一条有效的行项目'); return }

    setSaving(true)
    setMsg('')
    try {
      const lineInputs: BizLineInput[] = await Promise.all(
        validLines.map(async (l) => {
          const productId = await resolveProduct(l.brand, l.material, l.spec, l.unit)
          const qty = calcLineQty(l)
          return {
            productId,
            brand: l.brand,
            material: l.material,
            spec: l.spec,
            measureUnit: UNIT_LABELS[l.unit],
            weighMode: l.weighMode,
            bundleCount: l.weighMode === '理计' ? (parseInt(l.bundleCount) || 0) : undefined,
            weightPerPc: l.weighMode === '理计' ? (parseFloat(l.weightPerPc) || 0) : undefined,
            quantity: qty,
            unitPrice: parseFloat(l.unitPrice) || 0,
            taxInclusive: l.taxInclusive,
            subtotal: Math.round(qty * (parseFloat(l.unitPrice) || 0) * 100) / 100,
          }
        })
      )

      const hasLogistics = carrier || (freight && parseFloat(freight) > 0) || (liftingFee && parseFloat(liftingFee) > 0) || destination

      await createTrade({
        tradeType: 'sale',
        date,
        counterpartyId: customerId,
        contact: contact || undefined,
        phone: phone || undefined,
        settlementMethod,
        creditTermDays: settlementMethod === 'credit' ? (parseInt(creditTermDays) || 30) : undefined,
        location: location || undefined,
        docNo: docNo || undefined,
        projectId: projectId || undefined,
        notes: notes || undefined,
        lines: lineInputs,
        payment: (settlementMethod !== 'credit' && paidAmount && parseFloat(paidAmount) > 0)
          ? { amount: parseFloat(paidAmount), method: paymentMethod || undefined }
          : undefined,
        logistics: hasLogistics
          ? {
              carrier: carrier || undefined,
              freight: freight ? parseFloat(freight) : undefined,
              liftingFee: liftingFee ? parseFloat(liftingFee) : undefined,
              destination: destination || undefined,
            }
          : undefined,
      })

      setMsg('销售交易录入成功!')
      setLines([emptyLine(lineKey)])
      setLineKey(k => k + 1)
      setDocNo('')
      setPaidAmount('')
      setPaymentMethod('')
      setNotes('')
      setContact('')
      setPhone('')
      setSettlementMethod('cash')
      setCreditTermDays('30')
      setCustomCredit(false)
      setCarrier('')
      setFreight('')
      setLiftingFee('')
      setDestination('')
      onSuccess?.()
    } catch (e: any) {
      setMsg('错误: ' + e.message)
    }
    setSaving(false)
  }

  return (
    <div className={s.form}>
      {/* Header */}
      <div className={s.row}>
        <Input label="日期" value={date} onChange={setDate} type="date" />
        <Input label="送货单号" value={docNo} onChange={setDocNo} placeholder="如: NO.6003456" />
      </div>
      <SearchSelect label="客户" value={customerId} onChange={(id) => {
          setCustomerId(id)
          const cp = counterparties.find(c => c.id === id)
          if (cp) { setContact(cp.contact ?? ''); setPhone(cp.phone ?? '') }
        }}
        options={customers.map(c => ({ id: c.id, label: c.name }))} placeholder="搜索客户..."
        onQuickCreate={async (name) => (await addCounterparty({ name, type: 'customer' })).id} />
      <div className={s.row}>
        <Input label="联系人" value={contact} onChange={setContact} placeholder="联系人姓名" />
        <Input label="电话" value={phone} onChange={setPhone} placeholder="联系电话" />
      </div>
      <div className={s.row}>
        <Input label="交货地点" value={location} onChange={setLocation} placeholder="仓库/工地" />
        <SearchSelect label="项目" value={projectId} onChange={setProjectId} options={projectOpts} placeholder="搜索项目..."
          onQuickCreate={async (name) => (await addProject({ name })).id} />
      </div>

      {/* Line Items */}
      <div className={s.section}><span>物料明细 ({lines.length} 行)</span></div>
      {lines.map((line, idx) => (
        <LineItemCard
          key={line.key}
          line={line}
          index={idx}
          products={products}
          onChange={(updated) => updateLine(idx, updated)}
          onRemove={() => removeLine(idx)}
        />
      ))}
      <button type="button" className={s.addLineBtn} onClick={addLine}>+ 添加一行</button>

      <div className={s.grandTotal}>
        合计: {totalQty.toFixed(3)} 吨 / &yen;{grandTotal.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
      </div>

      {/* Settlement section (v1.0.2) */}
      <div className={s.section}><span>结算方式</span></div>
      <div className={s.field}>
        <div className={s.toggleRow}>
          {(['cash', 'transfer', 'credit'] as const).map(m => (
            <button key={m} type="button" className={s.toggle} data-active={settlementMethod === m}
              onClick={() => setSettlementMethod(m)}>
              {{ cash: '现金', transfer: '转账', credit: '欠款' }[m]}
            </button>
          ))}
        </div>
      </div>

      {settlementMethod !== 'credit' ? (
        <div className={s.row}>
          <Input label="已收金额" value={paidAmount} onChange={setPaidAmount} type="number" step="0.01" placeholder="0.00" />
          <Input label="收款方式" value={paymentMethod} onChange={setPaymentMethod} placeholder="转账/现金/承兑" />
        </div>
      ) : (
        <div className={s.row}>
          <div className={s.field}>
            <label className={s.label}>账期</label>
            <div className={s.toggleRow}>
              <button type="button" className={s.toggle} data-active={!customCredit && creditTermDays === '30'}
                onClick={() => { setCreditTermDays('30'); setCustomCredit(false) }}>30天</button>
              <button type="button" className={s.toggle} data-active={customCredit}
                onClick={() => setCustomCredit(true)}>自定义</button>
            </div>
            {customCredit && (
              <input className={s.input} type="number" value={creditTermDays} onChange={e => setCreditTermDays(e.target.value)}
                placeholder="天数" style={{ marginTop: 6 }} />
            )}
          </div>
          <div className={s.field}>
            <label className={s.label}>到期日</label>
            <div className={s.computed}>
              {(() => {
                const days = parseInt(creditTermDays) || 0
                const d = new Date(date + 'T00:00:00')
                d.setDate(d.getDate() + days)
                return d.toISOString().slice(0, 10)
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Logistics section (v1.0.2 — sales only) */}
      <div className={s.section}><span>物流信息（可选）</span></div>
      <div className={s.row}>
        <Input label="承运商" value={carrier} onChange={setCarrier} placeholder="物流公司名称" />
        <Input label="目的地" value={destination} onChange={setDestination} placeholder="送货地址" />
      </div>
      <div className={s.row}>
        <Input label="运费" value={freight} onChange={setFreight} type="number" step="0.01" placeholder="0.00" />
        <Input label="吊装费" value={liftingFee} onChange={setLiftingFee} type="number" step="0.01" placeholder="0.00" />
      </div>

      {/* Cascade Preview (v1.0.2) */}
      <div className={s.cascadePreview}>
        <div className={s.cascadeItem} data-active="true">销售单 (草稿)</div>
        {settlementMethod !== 'credit' && paidAmount && parseFloat(paidAmount) > 0 ? (
          <div className={s.cascadeItem} data-active="true">
            收款记录 &yen;{parseFloat(paidAmount).toLocaleString('zh-CN', { minimumFractionDigits: 2 })} (草稿)
          </div>
        ) : settlementMethod === 'credit' ? (
          <div className={s.cascadeItem} data-inactive="true">无收款记录（欠款结算，账期{creditTermDays}天）</div>
        ) : (
          <div className={s.cascadeItem} data-inactive="true">无收款记录</div>
        )}
        {(carrier || (freight && parseFloat(freight) > 0) || (liftingFee && parseFloat(liftingFee) > 0) || destination) ? (
          <div className={s.cascadeItem} data-active="true">
            物流记录{carrier ? ` — ${carrier}` : ''} (草稿)
          </div>
        ) : (
          <div className={s.cascadeItem} data-inactive="true">无物流记录</div>
        )}
      </div>

      <Input label="备注" value={notes} onChange={setNotes} placeholder="可选" />

      <button className={s.submit} onClick={handleSubmit} disabled={saving}>
        {saving ? '保存中...' : '保存销售交易'}
      </button>
      {msg && <div className={s.msg} data-error={msg.startsWith('错误')}>{msg}</div>}
    </div>
  )
}
