import { useState, useEffect } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useAutoScroll } from '../../hooks/useAutoScroll'
import { MessageBubble } from './MessageBubble'
import { ConsolidationNotice } from './ConsolidationNotice'
import { StreamingDots } from './StreamingDots'
import s from './ChatView.module.css'

/**
 * Mock consolidation demonstrations.
 * In production, these are emitted by the backend via WebSocket.
 */
const MOCK_CONSOLIDATIONS: Record<string, string> = {
  'price-window': '价差窗口判断',
  'credit-risk': '客户A信用风险',
}

/** Message IDs that should show a consolidation notice after them (for demo). */
const DEMO_CONSOLIDATION_AFTER = new Set<string>()

export function ChatView() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const scrollRef = useAutoScroll([messages])
  const [showDemoTip, setShowDemoTip] = useState(() => {
    return localStorage.getItem('bubble_demo_suggested') !== 'true'
  })

  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem('bubble_demo_suggested', 'true')
      setShowDemoTip(false)
    }
  }, [messages.length])

  const handleDemoClick = () => {
    localStorage.setItem('bubble_demo_suggested', 'true')
    setShowDemoTip(false)
    sendMessage('帮我管采购')
  }

  // Pick the first non-streaming assistant message for demo mock
  const firstAssistant = messages.find(
    (m) => m.role === 'assistant' && m.content.length > 0 && !m.isStreaming,
  )
  if (firstAssistant && !DEMO_CONSOLIDATION_AFTER.has(firstAssistant.id)) {
    DEMO_CONSOLIDATION_AFTER.add(firstAssistant.id)
  }

  return (
    <div className={s.view} ref={scrollRef}>
      {messages.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyIcon}>&#x1FAE7;</div>
          <div className={s.emptyText}>你好，我是 Bubble</div>
          <div className={s.emptyHint}>输入问题，开始对话</div>
          {showDemoTip && (
            <div className={s.demoTip}>
              <span className={s.demoTipLabel}>试试说：</span>
              <button className={s.demoTipChip} onClick={handleDemoClick}>
                帮我管采购
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className={s.messageList}>
          {messages.flatMap((msg) => {
            const elements: React.ReactNode[] = [
              <MessageBubble key={msg.id} message={msg} />,
            ]
            if (!msg.isStreaming && DEMO_CONSOLIDATION_AFTER.has(msg.id)) {
              elements.push(
                <ConsolidationNotice
                  key={`consol-${msg.id}`}
                  text={MOCK_CONSOLIDATIONS['price-window']}
                />,
              )
            }
            return elements
          })}
          {isStreaming && messages[messages.length - 1]?.content === '' && <StreamingDots />}
        </div>
      )}
    </div>
  )
}
