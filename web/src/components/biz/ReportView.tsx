import { useState, useEffect } from 'react'
import { useBizStore } from '../../stores/bizStore'
import { SearchSelect } from './SearchSelect'
import {
  fetchProfitReport, fetchCounterpartyStatement, fetchMonthlyOverview, fetchProfitByOrder,
  type ProfitByOrderRow,
} from '../../services/api'
import type {
  ProfitReportRow, CounterpartyStatementResult, MonthlyOverviewRow,
} from '../../types'
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement,
  Title, Tooltip, Legend, Filler,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import s from './ReportView.module.css'

ChartJS.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, Title, Tooltip, Legend, Filler)

type ReportTab = 'profit' | 'byorder' | 'statement' | 'monthly'

const TABS: Array<{ key: ReportTab; label: string }> = [
  { key: 'profit', label: '利润' },
  { key: 'byorder', label: '按单号' },
  { key: 'statement', label: '对账单' },
  { key: 'monthly', label: '月度总览' },
]

export function ReportView() {
  const [tab, setTab] = useState<ReportTab>('profit')

  return (
    <div className={s.container}>
      <div className={s.tabs}>
        {TABS.map(t => (
          <button key={t.key} className={s.tab} data-active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'profit' && <ProfitReport />}
      {tab === 'byorder' && <ByOrderReport />}
      {tab === 'statement' && <StatementReport />}
      {tab === 'monthly' && <MonthlyReport />}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtTons(n: number): string {
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 1 })
}

function thisYear(): number { return new Date().getFullYear() }

function firstOfYear(): string { return `${thisYear()}-01-01` }
function today(): string { return new Date().toISOString().slice(0, 10) }

// ── Profit Report ───────────────────────────────────────────────────

function ProfitReport() {
  const { counterparties, loadMasterData } = useBizStore()
  const [dateFrom, setDateFrom] = useState(firstOfYear())
  const [dateTo, setDateTo] = useState(today())
  const [customerId, setCustomerId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [rows, setRows] = useState<ProfitReportRow[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadMasterData() }, [loadMasterData])

  const customers = counterparties.filter(c => c.type === 'customer' || c.type === 'both')
  const suppliers = counterparties.filter(c => c.type === 'supplier' || c.type === 'both')

  const load = async () => {
    setLoading(true)
    try {
      setRows(await fetchProfitReport({
        dateFrom, dateTo,
        customerId: customerId || undefined,
        supplierId: supplierId || undefined,
      }))
    } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const totals = rows.reduce((acc, r) => ({
    revenue: acc.revenue + r.salesRevenue,
    cost: acc.cost + r.purchaseCost,
    logistics: acc.logistics + r.logisticsCost,
    profit: acc.profit + r.grossProfit,
    salesTons: acc.salesTons + r.salesTons,
    purchaseTons: acc.purchaseTons + r.purchaseTons,
  }), { revenue: 0, cost: 0, logistics: 0, profit: 0, salesTons: 0, purchaseTons: 0 })

  const totalMargin = totals.revenue > 0 ? Math.round(totals.profit / totals.revenue * 10000) / 100 : 0

  const chartData = {
    labels: rows.map(r => r.month),
    datasets: [
      { label: '销售额', data: rows.map(r => r.salesRevenue), backgroundColor: 'rgba(45, 212, 191, 0.6)' },
      { label: '采购成本', data: rows.map(r => r.purchaseCost), backgroundColor: 'rgba(124, 58, 237, 0.6)' },
      { label: '毛利润', data: rows.map(r => r.grossProfit), backgroundColor: rows.map(r => r.grossProfit >= 0 ? 'rgba(34, 197, 94, 0.6)' : 'rgba(239, 68, 68, 0.6)') },
    ],
  }

  const chartOptions = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { labels: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } } } },
    scales: {
      x: { ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
      y: { ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
    },
  }

  return (
    <>
      <div className={s.filterRow}>
        <div className={s.filterField}>
          <span className={s.filterLabel}>开始日期</span>
          <input className={s.filterInput} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className={s.filterField}>
          <span className={s.filterLabel}>结束日期</span>
          <input className={s.filterInput} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
      </div>
      <div className={s.filterRow}>
        <div className={s.filterField} style={{ flex: 1 }}>
          <span className={s.filterLabel}>客户</span>
          <SearchSelect label="" value={customerId} onChange={setCustomerId}
            options={[{ id: '', label: '全部' }, ...customers.map(c => ({ id: c.id, label: c.name }))]} placeholder="全部客户" />
        </div>
        <div className={s.filterField} style={{ flex: 1 }}>
          <span className={s.filterLabel}>供应商</span>
          <SearchSelect label="" value={supplierId} onChange={setSupplierId}
            options={[{ id: '', label: '全部' }, ...suppliers.map(c => ({ id: c.id, label: c.name }))]} placeholder="全部供应商" />
        </div>
        <button className={s.filterBtn} onClick={load}>查询</button>
      </div>

      <div className={s.summaryRow}>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>销售收入</span>
          <span className={s.summaryValue}>&yen;{fmtMoney(totals.revenue)}</span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>毛利润</span>
          <span className={`${s.summaryValue} ${totals.profit >= 0 ? s.positive : s.negative}`}>
            &yen;{fmtMoney(totals.profit)}
          </span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>毛利率</span>
          <span className={`${s.summaryValue} ${totalMargin >= 0 ? s.positive : s.negative}`}>
            {totalMargin}%
          </span>
        </div>
      </div>

      {!loading && rows.length > 0 && (
        <div className={s.chartWrap}><Bar data={chartData} options={chartOptions} /></div>
      )}

      {loading ? (
        <div className={s.loading}>加载中...</div>
      ) : rows.length === 0 ? (
        <div className={s.empty}>暂无数据</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>月份</th>
                <th className={s.numCell}>销售额</th>
                <th className={s.numCell}>采购成本</th>
                <th className={s.numCell}>物流成本</th>
                <th className={s.numCell}>毛利润</th>
                <th className={s.numCell}>毛利率</th>
                <th className={s.numCell}>销售吨</th>
                <th className={s.numCell}>采购吨</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const prevMargin = i > 0 ? rows[i - 1].margin : r.margin
                const delta = r.margin - prevMargin
                return (
                <tr key={r.month}>
                  <td data-label="月份">{r.month}</td>
                  <td className={s.numCell} data-label="销售额">{fmtMoney(r.salesRevenue)}</td>
                  <td className={s.numCell} data-label="采购成本">{fmtMoney(r.purchaseCost)}</td>
                  <td className={s.numCell} data-label="物流成本">{fmtMoney(r.logisticsCost)}</td>
                  <td className={`${s.numCell} ${r.grossProfit >= 0 ? s.positive : s.negative}`} data-label="毛利润">{fmtMoney(r.grossProfit)}</td>
                  <td className={`${s.numCell} ${r.margin >= 0 ? s.positive : s.negative}`} data-label="毛利率">
                    {r.margin}%
                    {i > 0 && <span className={delta > 0 ? s.trendUp : delta < 0 ? s.trendDown : s.trendFlat}>{delta > 0 ? ' ▲' : delta < 0 ? ' ▼' : ' –'}</span>}
                  </td>
                  <td className={s.numCell} data-label="销售吨">{fmtTons(r.salesTons)}</td>
                  <td className={s.numCell} data-label="采购吨">{fmtTons(r.purchaseTons)}</td>
                </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="">合计</td>
                <td className={s.numCell} data-label="销售额">{fmtMoney(totals.revenue)}</td>
                <td className={s.numCell} data-label="采购成本">{fmtMoney(totals.cost)}</td>
                <td className={s.numCell} data-label="物流成本">{fmtMoney(totals.logistics)}</td>
                <td className={`${s.numCell} ${totals.profit >= 0 ? s.positive : s.negative}`} data-label="毛利润">{fmtMoney(totals.profit)}</td>
                <td className={`${s.numCell} ${totalMargin >= 0 ? s.positive : s.negative}`} data-label="毛利率">{totalMargin}%</td>
                <td className={s.numCell} data-label="销售吨">{fmtTons(totals.salesTons)}</td>
                <td className={s.numCell} data-label="采购吨">{fmtTons(totals.purchaseTons)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

// ── Statement Report (往来对账单) ───────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  sale: '销售', purchase: '采购', payment_in: '收款', payment_out: '付款',
  invoice_in: '进项发票', invoice_out: '销项发票',
}

function StatementReport() {
  const { counterparties, loadMasterData } = useBizStore()
  const [counterpartyId, setCounterpartyId] = useState('')
  const [dateFrom, setDateFrom] = useState(firstOfYear())
  const [dateTo, setDateTo] = useState(today())
  const [result, setResult] = useState<CounterpartyStatementResult | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadMasterData() }, [loadMasterData])

  const load = async () => {
    if (!counterpartyId) return
    setLoading(true)
    try { setResult(await fetchCounterpartyStatement(counterpartyId, dateFrom, dateTo)) } catch { setResult(null) }
    setLoading(false)
  }

  return (
    <>
      <div className={s.filterRow}>
        <div className={s.filterField} style={{ flex: 2 }}>
          <span className={s.filterLabel}>往来对象</span>
          <SearchSelect
            label=""
            value={counterpartyId}
            onChange={setCounterpartyId}
            options={counterparties.map(c => ({ id: c.id, label: c.name }))}
            placeholder="选择客户/供应商..."
          />
        </div>
        <div className={s.filterField}>
          <span className={s.filterLabel}>开始</span>
          <input className={s.filterInput} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className={s.filterField}>
          <span className={s.filterLabel}>结束</span>
          <input className={s.filterInput} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <button className={s.filterBtn} onClick={load} disabled={!counterpartyId}>查询</button>
      </div>

      {loading && <div className={s.loading}>加载中...</div>}

      {result && !loading && (
        <>
          <div className={s.statementHeader}>
            <div className={s.statementTitle}>{result.counterpartyName} 往来对账单</div>
            <div className={s.statementSub}>
              {dateFrom} 至 {dateTo}
            </div>
          </div>

          <div className={s.summaryRow}>
            <div className={s.summaryCard}>
              <span className={s.summaryLabel}>借方合计</span>
              <span className={s.summaryValue}>&yen;{fmtMoney(result.totalDebit)}</span>
            </div>
            <div className={s.summaryCard}>
              <span className={s.summaryLabel}>贷方合计</span>
              <span className={s.summaryValue}>&yen;{fmtMoney(result.totalCredit)}</span>
            </div>
            <div className={s.summaryCard}>
              <span className={s.summaryLabel}>期末余额</span>
              <span className={`${s.summaryValue} ${result.closingBalance >= 0 ? s.positive : s.negative}`}>
                &yen;{fmtMoney(result.closingBalance)}
              </span>
            </div>
          </div>

          {result.rows.length === 0 ? (
            <div className={s.empty}>该期间无往来记录</div>
          ) : (
            <div className={s.tableWrap}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>日期</th>
                    <th>类型</th>
                    <th>摘要</th>
                    <th className={s.numCell}>借方</th>
                    <th className={s.numCell}>贷方</th>
                    <th className={s.numCell}>余额</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i}>
                      <td data-label="日期">{r.date}</td>
                      <td data-label="类型"><span className={s.typeBadge} data-type={r.type}>{TYPE_LABELS[r.type] ?? r.type}</span></td>
                      <td data-label="摘要">{r.description}</td>
                      <td className={s.numCell} data-label="借方">{r.debit > 0 ? fmtMoney(r.debit) : ''}</td>
                      <td className={s.numCell} data-label="贷方">{r.credit > 0 ? fmtMoney(r.credit) : ''}</td>
                      <td className={`${s.numCell} ${r.balance >= 0 ? s.positive : s.negative}`} data-label="余额">{fmtMoney(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} data-label="">合计</td>
                    <td className={s.numCell} data-label="借方">{fmtMoney(result.totalDebit)}</td>
                    <td className={s.numCell} data-label="贷方">{fmtMoney(result.totalCredit)}</td>
                    <td className={`${s.numCell} ${result.closingBalance >= 0 ? s.positive : s.negative}`} data-label="余额">{fmtMoney(result.closingBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}

      {!result && !loading && <div className={s.empty}>请选择往来对象后查询</div>}
    </>
  )
}

// ── Monthly Overview (月度总览) ─────────────────────────────────────

function MonthlyReport() {
  const [year, setYear] = useState(thisYear())
  const [rows, setRows] = useState<MonthlyOverviewRow[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setRows(await fetchMonthlyOverview(year)) } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const sum = (fn: (r: MonthlyOverviewRow) => number) => rows.reduce((acc, r) => acc + fn(r), 0)

  return (
    <>
      <div className={s.filterRow}>
        <div className={s.filterField}>
          <span className={s.filterLabel}>年度</span>
          <input className={s.filterInput} type="number" value={year} onChange={e => setYear(parseInt(e.target.value) || thisYear())} min={2020} max={2030} />
        </div>
        <button className={s.filterBtn} onClick={load}>查询</button>
      </div>

      <div className={s.summaryRow}>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>年采购额</span>
          <span className={s.summaryValue}>&yen;{fmtMoney(sum(r => r.purchaseAmount))}</span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>年销售额</span>
          <span className={s.summaryValue}>&yen;{fmtMoney(sum(r => r.salesAmount))}</span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>年物流费</span>
          <span className={s.summaryValue}>&yen;{fmtMoney(sum(r => r.logisticsAmount))}</span>
        </div>
      </div>

      {loading ? (
        <div className={s.loading}>加载中...</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>月份</th>
                <th className={s.numCell}>采购</th>
                <th className={s.numCell}>销售</th>
                <th className={s.numCell}>物流费</th>
                <th className={s.numCell}>收款</th>
                <th className={s.numCell}>付款</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const hasData = r.purchaseAmount || r.salesAmount || r.logisticsAmount || r.paymentsIn || r.paymentsOut
                return (
                  <tr key={r.month} style={!hasData ? { opacity: 0.3 } : undefined}>
                    <td data-label="月份">{r.month}</td>
                    <td className={s.numCell} data-label="采购">
                      {r.purchaseAmount ? fmtMoney(r.purchaseAmount) : '-'}
                      {r.purchaseTons > 0 && <span className={s.subText}>{fmtTons(r.purchaseTons)} 吨</span>}
                    </td>
                    <td className={s.numCell} data-label="销售">
                      {r.salesAmount ? fmtMoney(r.salesAmount) : '-'}
                      {r.salesTons > 0 && <span className={s.subText}>{fmtTons(r.salesTons)} 吨</span>}
                    </td>
                    <td className={s.numCell} data-label="物流费">{r.logisticsAmount ? fmtMoney(r.logisticsAmount) : '-'}</td>
                    <td className={`${s.numCell} ${s.positive}`} data-label="收款">{r.paymentsIn ? fmtMoney(r.paymentsIn) : '-'}</td>
                    <td className={`${s.numCell} ${s.negative}`} data-label="付款">{r.paymentsOut ? fmtMoney(r.paymentsOut) : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td data-label="">合计</td>
                <td className={s.numCell} data-label="采购">
                  {fmtMoney(sum(r => r.purchaseAmount))}
                  <span className={s.subText}>{fmtTons(sum(r => r.purchaseTons))} 吨</span>
                </td>
                <td className={s.numCell} data-label="销售">
                  {fmtMoney(sum(r => r.salesAmount))}
                  <span className={s.subText}>{fmtTons(sum(r => r.salesTons))} 吨</span>
                </td>
                <td className={s.numCell} data-label="物流费">{fmtMoney(sum(r => r.logisticsAmount))}</td>
                <td className={`${s.numCell} ${s.positive}`} data-label="收款">{fmtMoney(sum(r => r.paymentsIn))}</td>
                <td className={`${s.numCell} ${s.negative}`} data-label="付款">{fmtMoney(sum(r => r.paymentsOut))}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </>
  )
}

// ── By Order Report (按单号利润) v0.7 ───────────────────────────────

function ByOrderReport() {
  const [dateFrom, setDateFrom] = useState(firstOfYear())
  const [dateTo, setDateTo] = useState(today())
  const [rows, setRows] = useState<ProfitByOrderRow[]>([])
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try { setRows(await fetchProfitByOrder({ dateFrom, dateTo })) } catch { /* ignore */ }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const totalProfit = rows.reduce((sum, r) => sum + r.grossProfit, 0)
  const totalSales = rows.reduce((sum, r) => sum + r.salesAmount, 0)
  const totalMargin = totalSales > 0 ? Math.round(totalProfit / totalSales * 10000) / 100 : 0

  return (
    <>
      <div className={s.filterRow}>
        <div className={s.filterField}>
          <span className={s.filterLabel}>开始日期</span>
          <input className={s.filterInput} type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className={s.filterField}>
          <span className={s.filterLabel}>结束日期</span>
          <input className={s.filterInput} type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <button className={s.filterBtn} onClick={load}>查询</button>
      </div>

      <div className={s.summaryRow}>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>单据数</span>
          <span className={s.summaryValue}>{rows.length}</span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>总毛利</span>
          <span className={`${s.summaryValue} ${totalProfit >= 0 ? s.positive : s.negative}`}>
            &yen;{fmtMoney(totalProfit)}
          </span>
        </div>
        <div className={s.summaryCard}>
          <span className={s.summaryLabel}>综合毛利率</span>
          <span className={`${s.summaryValue} ${totalMargin >= 0 ? s.positive : s.negative}`}>
            {totalMargin}%
          </span>
        </div>
      </div>

      {loading ? (
        <div className={s.loading}>加载中...</div>
      ) : rows.length === 0 ? (
        <div className={s.empty}>暂无带单号的数据</div>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>单号</th>
                <th>日期</th>
                <th>供应商</th>
                <th>客户</th>
                <th className={s.numCell}>采购额</th>
                <th className={s.numCell}>销售额</th>
                <th className={s.numCell}>物流</th>
                <th className={s.numCell}>毛利</th>
                <th className={s.numCell}>毛利率</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.docNo} className={r.margin < totalMargin ? s.warnRow : undefined}>
                  <td data-label="单号"><strong>{r.docNo}</strong></td>
                  <td data-label="日期">{r.date}</td>
                  <td data-label="供应商">{r.supplierName}</td>
                  <td data-label="客户">{r.customerName}</td>
                  <td className={s.numCell} data-label="采购额">{fmtMoney(r.purchaseAmount)}</td>
                  <td className={s.numCell} data-label="销售额">{fmtMoney(r.salesAmount)}</td>
                  <td className={s.numCell} data-label="物流">{fmtMoney(r.logisticsCost)}</td>
                  <td className={`${s.numCell} ${r.grossProfit >= 0 ? s.positive : s.negative}`} data-label="毛利">{fmtMoney(r.grossProfit)}</td>
                  <td className={`${s.numCell} ${r.margin >= 0 ? s.positive : s.negative}`} data-label="毛利率">{r.margin}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
