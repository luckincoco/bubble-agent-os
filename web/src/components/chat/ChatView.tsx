import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { StreamingDots } from './StreamingDots'
import s from './ChatView.module.css'

export function ChatView() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const scrollRef = useAutoScroll([messages])

  return (
    <div className={s.view} ref={scrollRef}>
      {messages.length === 0 && (
        <div className={s.empty}>
          <div className={s.emptyIcon}>&#x1FAE7;</div>
          <div className={s.emptyText}>Say hi to Bubble Agent</div>
        </div>
      )}
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
      {isStreaming && messages[messages.length - 1]?.content === '' && <StreamingDots />}
    </div>
  )
}
