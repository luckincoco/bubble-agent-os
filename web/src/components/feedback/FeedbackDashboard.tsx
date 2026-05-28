import { useEffect, useState } from 'react'
import s from './FeedbackDashboard.module.css'

interface SourceStats {
  feedback: Record<string, number>
  traces: {
    totalTraces: number
    avgMatchItems: number
    avgExecutionMs: number
    pushRate: number
  }
}

const SOURCE_LABELS: Record<string, string> = {
  steel_price: '钢价推送',
  daily_briefing: '每日简报',
}

export function FeedbackDashboard() {
  const [stats, setStats] = useState<Record<string, SourceStats>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      fetch('/api/feedback/combined-stats?sourceType=steel_price'),
      fetch('/api/feedback/combined-stats?sourceType=daily_briefing'),
    ])
      .then(responses => Promise.all(responses.map(r => r.json())))
      .then(([steel, briefing]) => {
        setStats({
          steel_price: steel,
          daily_briefing: briefing,
        })
        setLoading(false)
      })
      .catch(err => {
        setError(err.message || '加载失败')
        setLoading(false)
      })
  }, [])

  if (loading) return <div className={s.container}>加载中...</div>
  if (error) return <div className={s.container}>错误: {error}</div>

  const entries = Object.entries(stats)

  return (
    <div className={s.container}>
      <h2 className={s.title}>反馈概况</h2>
      {entries.length === 0 && <p className={s.empty}>暂无反馈数据</p>}
      {entries.map(([source, data]) => (
        <div key={source} className={s.sourceBlock}>
          <h3 className={s.sourceTitle}>{SOURCE_LABELS[source] || source}</h3>

          <div className={s.metrics}>
            <div className={s.metric}>
              <span className={s.metricValue}>{data.traces.totalTraces}</span>
              <span className={s.metricLabel}>推送次数</span>
            </div>
            <div className={s.metric}>
              <span className={s.metricValue}>{data.feedback.read || 0}</span>
              <span className={s.metricLabel}>已读</span>
            </div>
            <div className={s.metric}>
              <span className={s.metricValue}>{data.feedback.acted || 0}</span>
              <span className={s.metricLabel}>已行动</span>
            </div>
            <div className={s.metric}>
              <span className={s.metricValue}>{data.feedback.dismissed || 0}</span>
              <span className={s.metricLabel}>忽略</span>
            </div>
          </div>

          {data.feedback.readRate !== undefined && (
            <div className={s.rateRow}>
              <span>阅读率 {data.feedback.readRate}%</span>
              <span>行动率 {data.feedback.actionRate || 0}%</span>
              <span>忽略率 {data.feedback.dismissRate || 0}%</span>
            </div>
          )}

          <div className={s.traceRow}>
            <span>平均匹配 {data.traces.avgMatchItems} 项</span>
            <span>平均耗时 {data.traces.avgExecutionMs}ms</span>
          </div>
        </div>
      ))}

      {entries.length > 0 && (
        <div className={s.footer}>
          <a href="/api/feedback" target="_blank" rel="noreferrer">查看原始反馈记录</a>
          <a href="/api/feedback/stats?sourceType=steel_price" target="_blank" rel="noreferrer">原始统计</a>
        </div>
      )}
    </div>
  )
}
