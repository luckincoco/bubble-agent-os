import { useState } from 'react'
import type { BubbleMemory } from '../../types'
import { useMemoryStore } from '../../stores/memoryStore'
import s from './BubbleCard.module.css'

export function BubbleCard({ memory }: { memory: BubbleMemory }) {
  const [showDelete, setShowDelete] = useState(false)
  const [reason, setReason] = useState('')
  const [deleting, setDeleting] = useState(false)
  const deleteBubble = useMemoryStore(s => s.deleteBubble)

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await deleteBubble(memory.id, reason)
    } catch {
      setDeleting(false)
    }
  }

  return (
    <div className={s.card}>
      <div className={s.header}>
        <span className={s.badge}>{memory.type}</span>
        <span className={s.title}>{memory.title}</span>
        {memory.pinned && <span className={s.pin}>&#x1F4CC;</span>}
        <button
          className={s.deleteBtn}
          onClick={() => setShowDelete(true)}
          title="删除记忆"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
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

      {showDelete && (
        <div className={s.deleteOverlay}>
          <div className={s.deleteDialog}>
            <div className={s.deleteTitle}>删除这条记忆？</div>
            <textarea
              className={s.deleteReason}
              placeholder="删除原因（可选，帮助AI学习）"
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={2}
            />
            <div className={s.deleteActions}>
              <button
                className={s.cancelBtn}
                onClick={() => { setShowDelete(false); setReason('') }}
                disabled={deleting}
              >
                取消
              </button>
              <button
                className={s.confirmDeleteBtn}
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? '删除中...' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
