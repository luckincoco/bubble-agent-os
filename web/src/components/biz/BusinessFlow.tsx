import { useState, type ReactNode } from 'react'
import { BizBubble } from './BizBubble'
import { PurchaseForm, SaleForm, LogisticsForm, PaymentForm } from './EntryView'
import { InvoiceForm } from './InvoiceForm'
import { QueryView } from './QueryView'
import { DashboardView } from './DashboardView'
import s from './BusinessFlow.module.css'

type BubbleId = 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice' | 'query' | 'dashboard'

interface BubbleDef {
  id: BubbleId
  emoji: string
  label: string
  color: string
}

const BUBBLES: BubbleDef[] = [
  { id: 'purchase', emoji: '\u{1F4E6}', label: '采购', color: 'var(--purple)' },
  { id: 'sale', emoji: '\u{1F4B0}', label: '销售', color: 'var(--teal)' },
  { id: 'logistics', emoji: '\u{1F69A}', label: '物流', color: 'var(--blue)' },
  { id: 'payment', emoji: '\u{1F4B3}', label: '收付款', color: '#F59E0B' },
  { id: 'invoice', emoji: '\u{1F9FE}', label: '发票', color: '#F97316' },
  { id: 'query', emoji: '\u{1F4CA}', label: '对账查询', color: '#EC4899' },
  { id: 'dashboard', emoji: '\u{1F4C8}', label: '经营概览', color: '#22C55E' },
]

const CONTENT_MAP: Record<BubbleId, () => ReactNode> = {
  purchase: () => <PurchaseForm />,
  sale: () => <SaleForm />,
  logistics: () => <LogisticsForm />,
  payment: () => <PaymentForm />,
  invoice: () => <InvoiceForm />,
  query: () => <QueryView />,
  dashboard: () => <DashboardView />,
}

export function BusinessFlow() {
  const [active, setActive] = useState<BubbleId | null>(null)

  if (active) {
    const Content = CONTENT_MAP[active]
    const bubble = BUBBLES.find(b => b.id === active)!
    return (
      <div className={s.container}>
        <div className={s.detailHeader}>
          <button className={s.backBtn} onClick={() => setActive(null)}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span className={s.detailEmoji}>{bubble.emoji}</span>
          <span className={s.detailTitle}>{bubble.label}</span>
        </div>
        <div className={s.detailContent}>
          <Content />
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
