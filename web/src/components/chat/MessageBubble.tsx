import type { ChatMessage } from '../../types'
import s from './MessageBubble.module.css'

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`${s.bubble} ${s[message.role]}`}>
      {message.content}
      {message.sources && message.sources.length > 0 && (
        <div className={s.sources}>
          <div className={s.sourcesLabel}>参考来源</div>
          {message.sources.map((src) => (
            <div key={src.refIndex} className={s.sourceItem}>
              <span className={s.sourceIndex}>[{src.refIndex}]</span>
              <span className={s.sourceTitle}>{src.title}</span>
              {src.snippet && <span className={s.sourceSnippet}>{src.snippet}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
