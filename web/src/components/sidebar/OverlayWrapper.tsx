import type { ReactNode } from 'react'
import s from './OverlayWrapper.module.css'

interface Props {
  title: string
  onClose: () => void
  children: ReactNode
}

export function OverlayWrapper({ title, onClose, children }: Props) {
  return (
    <div className={s.overlay}>
      <div className={s.header}>
        <span className={s.title}>{title}</span>
        <button className={s.closeBtn} onClick={onClose}>
          &times;
        </button>
      </div>
      <div className={s.body}>
        {children}
      </div>
    </div>
  )
}
