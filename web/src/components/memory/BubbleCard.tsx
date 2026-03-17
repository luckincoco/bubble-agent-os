import type { BubbleMemory } from '../../types'
import s from './BubbleCard.module.css'

export function BubbleCard({ memory }: { memory: BubbleMemory }) {
  return (
    <div className={s.card}>
      <div className={s.header}>
        <span className={s.badge}>{memory.type}</span>
        <span className={s.title}>{memory.title}</span>
        {memory.pinned && <span className={s.pin}>&#x1F4CC;</span>}
      </div>
      <div className={s.content}>{memory.content}</div>
      {memory.tags.length > 0 && (
        <div className={s.tags}>
          {memory.tags.map((t) => <span key={t} className={s.tag}>{t}</span>)}
        </div>
      )}
      <div className={s.confidence}>
        <div className={s.confidenceBar} style={{ width: `${memory.confidence * 100}%` }} />
      </div>
    </div>
  )
}
