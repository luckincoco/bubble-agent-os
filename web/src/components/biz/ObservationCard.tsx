import type { CognitivePanelProps } from '../../modules/registry'
import s from './ObservationCard.module.css'

/** Data shape emitted by Brain for biz observation panels */
interface ObservationPanelData {
  actions: Array<{
    toolName: string
    args: Record<string, unknown>
    description: string
  }>
  summary: string
}

export function ObservationCard({ data, context }: CognitivePanelProps) {
  const obs = data as ObservationPanelData

  return (
    <div className={s.card}>
      <div className={s.header}>
        <span className={s.icon}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 14h14" />
            <path d="M3 11l3-4 3 2 4-5" />
            <path d="M13 4h2v2" />
          </svg>
        </span>
        <span className={s.title}>Agent 观察 · {obs.summary}</span>
      </div>
      <div className={s.body}>
        {obs.actions.map((action, i) => (
          <div key={i} className={s.action}>
            <span className={s.actionName}>{action.description}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
