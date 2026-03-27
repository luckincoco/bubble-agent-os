import { useEffect } from 'react'
import { useBizStore } from '../../stores/bizStore'
import s from './DashboardView.module.css'

function CardIcon({ d, color }: { d: string; color: string }) {
  return (
    <svg className={s.cardIcon} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  )
}

export function DashboardView() {
  const { dashboard, loading, loadDashboard } = useBizStore()

  useEffect(() => { loadDashboard() }, [loadDashboard])

  if (loading && !dashboard) return <div className={s.loading}>加载中...</div>

  const d = dashboard

  return (
    <div className={s.container}>
      <h2 className={s.title}>经营概览</h2>

      <div className={s.cards}>
        <div className={s.card}>
          <CardIcon d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" color="var(--teal)" />
          <div className={s.cardBody}>
            <span className={s.cardLabel}>库存总量</span>
            <span className={s.cardValue}>{fmt(d?.totalStockTons ?? 0)} 吨</span>
          </div>
        </div>
        <div className={s.card}>
          <CardIcon d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" color="var(--teal)" />
          <div className={s.cardBody}>
            <span className={s.cardLabel}>应收账款</span>
            <span className={s.cardValue}>&yen;{fmtMoney(d?.totalReceivable ?? 0)}</span>
          </div>
        </div>
        <div className={s.card}>
          <CardIcon d="M2 17l10 5 10-5M2 12l10 5 10-5M12 2l10 5-10 5L2 7z" color="var(--purple)" />
          <div className={s.cardBody}>
            <span className={s.cardLabel}>应付账款</span>
            <span className={s.cardValue}>&yen;{fmtMoney(d?.totalPayable ?? 0)}</span>
          </div>
        </div>
      </div>

      <h3 className={s.sectionTitle}>今日动态</h3>
      <div className={s.todayRow}>
        <div className={s.todayItem}>
          <span className={s.todayNum}>{d?.todayPurchases ?? 0}</span>
          <span className={s.todayLabel}>采购</span>
        </div>
        <div className={s.todayItem}>
          <span className={s.todayNum}>{d?.todaySales ?? 0}</span>
          <span className={s.todayLabel}>销售</span>
        </div>
        <div className={s.todayItem}>
          <span className={s.todayNum}>{d?.todayLogistics ?? 0}</span>
          <span className={s.todayLabel}>物流</span>
        </div>
      </div>

      {d?.recentTransactions && d.recentTransactions.length > 0 && (
        <>
          <h3 className={s.sectionTitle}>最近交易</h3>
          <div className={s.recentList}>
            {d.recentTransactions.map((t, i) => (
              <div key={i} className={s.recentItem}>
                <span className={s.recentType} data-type={t.type}>{t.type}</span>
                <span className={s.recentDate}>{t.date}</span>
                <span className={s.recentParty}>{t.counterparty}</span>
                <span className={s.recentAmount}>&yen;{fmtMoney(t.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function fmt(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
