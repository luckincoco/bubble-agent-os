import type { ChatMessage } from '../../types'
import s from './MessageBubble.module.css'

export function MessageBubble({ message }: { message: ChatMessage }) {
  return (
    <div className={`${s.bubble} ${s[message.role]}`}>
      {message.content}
    </div>
  )
}
