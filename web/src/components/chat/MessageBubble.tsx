import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { AssertionType, ChatMessage, CognitionLayer } from '../../types'
import { useAuthStore } from '../../stores/authStore'
import { CognitivePanel } from './CognitivePanel'
import { markInaccurate } from '../../services/api'
import s from './MessageBubble.module.css'

const assertionLabels: Record<AssertionType, string> = {
  fact: '事实',
  judgment: '判断',
  speculation: '推测',
  reference: '引用',
}

const layerLabels: Record<CognitionLayer, string> = {
  observation: '观察',
  reflection: '反思',
  consolidation: '压实',
}

const layerColors: Record<CognitionLayer, string> = {
  observation: 'var(--cog-obs)',
  reflection: 'var(--cog-ref)',
  consolidation: 'var(--cog-con)',
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const layer = message.cognitionLayer
  const layerColor = layer ? layerColors[layer] : undefined
  const userDisplayName = useAuthStore((s) => s.user?.displayName ?? '?')
  const userInitial = userDisplayName.charAt(0)
  const spaceId = useAuthStore((s) => s.currentSpaceId ?? '')
  const [feedbackSent, setFeedbackSent] = useState(message.markedInaccurate ?? false)

  const handleMarkInaccurate = async () => {
    if (feedbackSent) return
    if (!message.turnId) return
    try {
      await markInaccurate(message.turnId)
      setFeedbackSent(true)
    } catch { /* non-critical */ }
  }

  return (
    <div className={`${s.row} ${s[`row${message.role === 'assistant' ? 'Left' : 'Right'}`]}`}>
      {message.role === 'assistant' && (
        <div className={s.avatar}>{'B'}</div>
      )}
      <div className={s.wrapper}>
        <div
          className={`${s.bubble} ${s[message.role]} ${layer === 'reflection' ? s.reflection : ''}`}
          style={layer && message.role === 'assistant' ? { borderLeftColor: layerColor } : undefined}
        >
          {message.role === 'assistant' ? (
            <div className={s.markdown}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            </div>
          ) : (
            message.content
          )}
          {message.assertions && message.assertions.length > 0 && !message.isStreaming && (
            <div className={s.assertions}>
              {message.assertions.map(a => (
                <span
                  key={a.id}
                  className={`${s.assertionTag} ${s[a.assertionType]}`}
                  title={a.textSnippet}
                >
                  {assertionLabels[a.assertionType]}
                </span>
              ))}
            </div>
          )}
          {message.panel && message.role === 'assistant' && !message.isStreaming && (
            <CognitivePanel
              moduleId={message.panel.moduleId}
              cognitionLayer={layer || 'observation'}
              data={message.panel.data}
              spaceId={spaceId}
            />
          )}
        </div>
        {layer && message.role === 'assistant' && !message.isStreaming && (
          <div className={s.meta}>
            <span className={s.metaDot} style={{ background: layerColor }} />
            <span className={s.metaLabel}>{layerLabels[layer]}</span>
            <span className={s.metaTime}>{formatTime(message.timestamp)}</span>
          </div>
        )}
        {message.role === 'assistant' && !message.isStreaming && (
          <div className={s.feedbackRow}>
            {feedbackSent ? (
              <span className={s.feedbackDone}>已记录</span>
            ) : (
              <button className={s.feedbackBtn} onClick={handleMarkInaccurate} title="标记为不准确">
                这个不对
              </button>
            )}
          </div>
        )}
      </div>
      {message.role === 'user' && (
        <div className={`${s.avatar} ${s.userAvatar}`}>{userInitial}</div>
      )}
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  return `${hh}:${mm}`
}
