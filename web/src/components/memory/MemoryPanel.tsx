import { useEffect } from 'react'
import { useMemoryStore } from '../../stores/memoryStore'
import { BubbleCard } from './BubbleCard'
import s from './MemoryPanel.module.css'

export function MemoryPanel() {
  const { memories, loading, error, load } = useMemoryStore()

  useEffect(() => { load() }, [load])

  if (loading) {
    return <div className={s.loading}>Loading memories...</div>
  }

  if (error) {
    return (
      <div className={s.error}>
        <div>Failed to load: {error}</div>
        <button className={s.retry} onClick={load}>Retry</button>
      </div>
    )
  }

  if (memories.length === 0) {
    return (
      <div className={s.empty}>
        <div className={s.emptyIcon}>&#x1FAE7;</div>
        <div>No memories yet</div>
      </div>
    )
  }

  return (
    <div className={s.panel}>
      <div className={s.grid}>
        {memories.map((m) => <BubbleCard key={m.id} memory={m} />)}
      </div>
    </div>
  )
}
