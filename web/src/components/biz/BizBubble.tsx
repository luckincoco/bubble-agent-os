import type { ReactNode } from 'react'
import s from './BizBubble.module.css'

interface Props {
  emoji: string
  label: string
  color: string
  active?: boolean
  onClick: () => void
  badge?: ReactNode
}

export function BizBubble({ emoji, label, color, active, onClick, badge }: Props) {
  return (
    <button
      className={s.bubble}
      data-active={active}
      style={{ '--bubble-color': color } as React.CSSProperties}
      onClick={onClick}
    >
      <span className={s.glow} />
      <span className={s.emoji}>{emoji}</span>
      <span className={s.label}>{label}</span>
      {badge && <span className={s.badge}>{badge}</span>}
    </button>
  )
}
