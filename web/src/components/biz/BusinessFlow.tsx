import { useState, type ReactNode } from 'react'
import { BizBubble } from './BizBubble'
import { LogisticsForm, PaymentForm } from './EntryView'
import { PurchaseEventForm } from './PurchaseEventForm'
import { SaleEventForm } from './SaleEventForm'
import { InvoiceForm } from './InvoiceForm'
import { RecordList } from './RecordList'
import { QueryView } from './QueryView'
import { ReportView } from './ReportView'
import s from './BusinessFlow.module.css'

type BubbleId = 'purchase' | 'sale' | 'logistics' | 'payment' | 'invoice' | 'query' | 'report'

interface BubbleDef {
  id: BubbleId
  icon: string   // SVG path d
  label: string
  color: string
  hasRecords?: boolean
}

// Consistent stroke-style icons matching the NavTabs design language
const BUBBLES: BubbleDef[] = [
  {
    id: 'purchase', label: '采购事件', color: 'var(--purple)', hasRecords: true,
    icon: 'M20 12V8H6a2 2 0 01-2-2c0-1.1.9-2 2-2h12v4M20 12a2 2 0 010 4H6a2 2 0 01-2-2V6M4 18a2 2 0 002 2h12a2 2 0 002-2v-2',
  },
  {
    id: 'sale', label: '销售事件', color: 'var(--teal)', hasRecords: true,
    icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  },
  {
    id: 'logistics', label: '物流', color: 'var(--blue)', hasRecords: true,
    icon: 'M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM18.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5z',
  },
  {
    id: 'payment', label: '收付款', color: '#F59E0B', hasRecords: true,
    icon: 'M21 4H3a2 2 0 00-2 2v12a2 2 0 002 2h18a2 2 0 002-2V6a2 2 0 00-2-2zM1 10h22',
  },
  {
    id: 'invoice', label: '发票', color: '#F97316', hasRecords: true,
    icon: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
  },
  {
    id: 'query', label: '基础数据', color: '#EC4899',
    icon: 'M18 20V10M12 20V4M6 20v-6',
  },
  {
    id: 'report', label: '报表', color: '#8B5CF6',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 14l2 2 4-4',
  },
]

const FORM_MAP: Partial<Record<BubbleId, () => ReactNode>> = {
  purchase: () => <PurchaseEventForm />,
  sale: () => <SaleEventForm />,
  logistics: () => <LogisticsForm />,
  payment: () => <PaymentForm />,
  invoice: () => <InvoiceForm />,
}

const CONTENT_MAP: Partial<Record<BubbleId, () => ReactNode>> = {
  query: () => <QueryView />,
  report: () => <ReportView />,
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
            <svg className={s.detailIcon} viewBox="0 0 24 24" fill="none" stroke={bubble.color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${bubble.color})` }}>
              <path d={bubble.icon} />
            </svg>
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
          <svg className={s.detailIcon} viewBox="0 0 24 24" fill="none" stroke={bubble.color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${bubble.color})` }}>
            <path d={bubble.icon} />
          </svg>
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
              icon={b.icon}
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
