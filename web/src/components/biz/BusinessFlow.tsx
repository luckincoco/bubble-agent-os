import { useState, type ReactNode } from 'react'
import { BizBubble } from './BizBubble'
import { PurchaseForm, SaleForm, LogisticsForm, PaymentForm } from './EntryView'
import { InvoiceForm } from './InvoiceForm'
import { RecordList } from './RecordList'
import { QueryView } from './QueryView'
import { DashboardView } from './DashboardView'
import s from './BusinessFlow.module.css'

type BubbleId = 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice' | 'query' | 'dashboard'

interface BubbleDef {
  id: BubbleId
  emoji: string
  label: string
  color: string
  hasRecords?: boolean // whether this bubble has entry+records dual view
}

const BUBBLES: BubbleDef[] = [
  { id: 'purchase', emoji: '\u{1F4E6}', label: '采购', color: 'var(--purple)', hasRecords: true },
  { id: 'sale', emoji: '\u{1F4B0}', label: '销售', color: 'var(--teal)', hasRecords: true },
  { id: 'logistics', emoji: '\u{1F69A}', label: '物流', color: 'var(--blue)', hasRecords: true },
  { id: 'payment', emoji: '\u{1F4B3}', label: '收付款', color: '#F59E0B', hasRecords: true },
  { id: 'invoice', emoji: '\u{1F9FE}', label: '发票', color: '#F97316', hasRecords: true },
  { id: 'query', emoji: '\u{1F4CA}', label: '对账查询', color: '#EC4899' },
  { id: 'dashboard', emoji: '\u{1F4C8}', label: '经营概览', color: '#22C55E' },
]

const FORM_MAP: Partial<Record<BubbleId, () => ReactNode>> = {
  purchase: () => <PurchaseForm />,
  sale: () => <SaleForm />,
  logistics: () => <LogisticsForm />,
  payment: () => <PaymentForm />,
  invoice: () => <InvoiceForm />,
}

const CONTENT_MAP: Partial<Record<BubbleId, () => ReactNode>> = {
  query: () => <QueryView />,
  dashboard: () => <DashboardView />,
}

type SubTab = 'entry' | 'records'

export function BusinessFlow() {
  const [active, setActive] = useState<BubbleId | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('entry')

  const handleBack = () => {
    setActive(null)
    setSubTab('entry')
  }

  if (active) {
    const bubble = BUBBLES.find(b => b.id === active)!

    // Non-record bubbles (query, dashboard) render directly
    if (!bubble.hasRecords) {
      const Content = CONTENT_MAP[active]
      return (
        <div className={s.container}>
          <div className={s.detailHeader}>
            <button className={s.backBtn} onClick={handleBack}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <span className={s.detailEmoji}>{bubble.emoji}</span>
            <span className={s.detailTitle}>{bubble.label}</span>
          </div>
          <div className={s.detailContent}>
            {Content ? <Content /> : null}
          </div>
        </div>
      )
    }

    // Record bubbles: entry + records dual tab
    const Form = FORM_MAP[active]
    const recordType = active as 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice'
    return (
      <div className={s.container}>
        <div className={s.detailHeader}>
          <button className={s.backBtn} onClick={handleBack}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span className={s.detailEmoji}>{bubble.emoji}</span>
          <span className={s.detailTitle}>{bubble.label}</span>
          <div className={s.subTabs}>
            <button className={s.subTab} data-active={subTab === 'entry'} onClick={() => setSubTab('entry')}>
              录入
            </button>
            <button className={s.subTab} data-active={subTab === 'records'} onClick={() => setSubTab('records')}>
              记录
            </button>
          </div>
        </div>
        <div className={s.detailContent}>
          {subTab === 'entry' && Form ? <Form /> : null}
          {subTab === 'records' && <RecordList type={recordType} />}
        </div>
      </div>
    )
  }

  return (
    <div className={s.container}>
      <div className={s.grid}>
        {BUBBLES.map((b, i) => (
          <div key={b.id} className={s.cell} style={{ animationDelay: `${i * 60}ms` }}>
            <BizBubble
              emoji={b.emoji}
              label={b.label}
              color={b.color}
              onClick={() => setActive(b.id)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
