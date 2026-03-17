import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { useChatStore } from '../../stores/chatStore'
import s from './InputBar.module.css'

export function InputBar() {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const status = useChatStore((s) => s.status)

  const send = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    sendMessage(trimmed)
    setText('')
    if (ref.current) ref.current.style.height = 'auto'
  }, [text, sendMessage])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const onInput = () => {
    const el = ref.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    }
  }

  const disabled = isStreaming || status !== 'connected'

  return (
    <div className={s.bar}>
      <textarea
        ref={ref}
        className={s.input}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onInput={onInput}
        placeholder={status !== 'connected' ? 'Connecting...' : 'Type a message...'}
        disabled={disabled}
      />
      <button className={s.send} onClick={send} disabled={disabled || !text.trim()}>
        &#x27A4;
      </button>
    </div>
  )
}
