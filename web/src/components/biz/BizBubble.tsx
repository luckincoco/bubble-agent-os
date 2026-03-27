import type { ReactNode } from 'react'
import s from './BizBubble.module.css'

interface Props {
  icon: string
  label: string
  color: string
  active?: boolean
  onClick: () => void
  badge?: ReactNode
}

export function BizBubble({ icon, label, color, active, onClick, badge }: Props) {
  return (
    <button
      className={s.bubble}
      data-active={active}
      style={{ '--bubble-color': color } as React.CSSProperties}
      onClick={onClick}
    >
      <span className={s.glow} />
      <svg
        className={s.icon}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={icon} />
      </svg>
      <span className={s.label}>{label}</span>
      {badge && <span className={s.badge}>{badge}</span>}
    </button>
  )
}
