import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatMessage } from '../../types'
import s from './MessageBubble.module.css'

function ThumbUp({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={active ? '#14B8A6' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3m7-2V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14" />
    </svg>
  )
}

function ThumbDown({ active }: { active: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke={active ? '#F87171' : 'currentColor'} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 2H20a2 2 0 012 2v7a2 2 0 01-2 2h-3m-7 2v4a3 3 0 003 3l4-9V2H6.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10" />
    </svg>
  )
}

export function MessageBubble({ message }: { message: ChatMessage }) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)

  const handleFeedback = (type: 'up' | 'down') => {
    setFeedback(feedback === type ? null : type)
  }

  return (
    <div className={s.wrapper}>
      <div className={`${s.bubble} ${s[message.role]}`}>
        {message.role === 'assistant' ? (
          <div className={s.markdown}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          message.content
        )}
      </div>
      {message.role === 'assistant' && !message.isStreaming && (
        <div className={s.feedbackRow}>
          <button
            className={`${s.fbBtn} ${feedback === 'up' ? s.fbUp : ''}`}
            onClick={() => handleFeedback('up')}
            title="有帮助"
          >
            <ThumbUp active={feedback === 'up'} />
          </button>
          <button
            className={`${s.fbBtn} ${feedback === 'down' ? s.fbDown : ''}`}
            onClick={() => handleFeedback('down')}
            title="没帮助"
          >
            <ThumbDown active={feedback === 'down'} />
          </button>
        </div>
      )}
    </div>
  )
}
