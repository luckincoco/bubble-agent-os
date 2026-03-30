import { useState, useRef, useCallback, type KeyboardEvent } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { uploadImage } from '../../services/api'
import s from './InputBar.module.css'

export function InputBar() {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const status = useChatStore((s) => s.status)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')

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

  const handleImageUpload = useCallback(async () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return

    setUploading(true)
    setUploadMsg('')
    try {
      const result = await uploadImage(file)
      setUploadMsg(`OCR完成: ${result.regions}个区域, 置信度${result.confidence.toFixed(0)}%`)
      setTimeout(() => setUploadMsg(''), 4000)
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : '上传失败')
      setTimeout(() => setUploadMsg(''), 4000)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [])

  const disabled = isStreaming || status !== 'connected'

  return (
    <div className={s.bar}>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageUpload}
      />
      <button
        className={s.imageBtn}
        onClick={() => fileRef.current?.click()}
        disabled={disabled || uploading}
        title="拍照/上传图片 (OCR识别)"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
          <circle cx="12" cy="13" r="4" />
        </svg>
      </button>
      {uploadMsg && <span className={s.imageStatus}>{uploadMsg}</span>}
      <textarea
        ref={ref}
        className={s.input}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onInput={onInput}
        placeholder={status !== 'connected' ? '连接中...' : '输入消息...'}
        disabled={disabled}
      />
      <button className={s.send} onClick={send} disabled={disabled || !text.trim()}>
        &#x27A4;
      </button>
    </div>
  )
}
