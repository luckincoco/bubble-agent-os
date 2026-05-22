import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { uploadExcel, uploadImage } from '../../services/api'
import s from './InputBar.module.css'

export function InputBar() {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const sendMessage = useChatStore((s) => s.sendMessage)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const status = useChatStore((s) => s.status)
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingFile, setPendingFile] = useState<{ file: File; type: 'excel' | 'image' } | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const excelInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const send = useCallback(async () => {
    const trimmed = text.trim()
    if (!trimmed && !pendingFile) return
    if (pendingFile) {
      setIsUploading(true)
      setUploadError(null)
      try {
        if (pendingFile.type === 'excel') {
          await uploadExcel(pendingFile.file)
        } else {
          await uploadImage(pendingFile.file)
        }
        setPendingFile(null)
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : '上传失败')
        setIsUploading(false)
        return
      }
      setIsUploading(false)
    }
    if (trimmed) {
      sendMessage(trimmed)
      setText('')
      if (ref.current) ref.current.style.height = 'auto'
    }
  }, [text, sendMessage, pendingFile])

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

  const disabled = isStreaming || status !== 'connected' || isUploading

  const handleExcelClick = () => {
    excelInputRef.current?.click()
    setMenuOpen(false)
  }

  const handleImageClick = () => {
    imageInputRef.current?.click()
    setMenuOpen(false)
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>, type: 'excel' | 'image') => {
    const file = e.target.files?.[0]
    if (!file) return
    setPendingFile({ file, type })
    setUploadError(null)
    e.target.value = ''
  }

  return (
    <>
      <input
        ref={excelInputRef}
        type="file"
        accept=".xlsx,.xls"
        onChange={(e) => handleFileSelect(e, 'excel')}
        hidden
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => handleFileSelect(e, 'image')}
        hidden
      />
      <div className={s.container}>
        <div className={s.bar}>
          <div className={s.inputArea}>
            <div className={s.inputRow}>
              <div className={s.attachWrapper} ref={menuRef}>
                <button
                  className={s.attachBtn}
                  onClick={() => setMenuOpen(!menuOpen)}
                  disabled={isUploading}
                  title="附件"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                {menuOpen && (
                  <div className={s.menu}>
                    <button className={`${s.menuItem} ${s.menuItemActive}`} onClick={handleExcelClick}>
                      <span className={s.menuIcon}>&#x1F4CA;</span>
                      <span className={s.menuLabel}>Excel 表格</span>
                      <span className={s.menuBadge}>已上线</span>
                    </button>
                    <button className={`${s.menuItem} ${s.menuItemActive}`} onClick={handleImageClick}>
                      <span className={s.menuIcon}>&#x1F5BC;</span>
                      <span className={s.menuLabel}>图片/OCR</span>
                      <span className={s.menuBadge}>已上线</span>
                    </button>
                    <div className={s.menuDivider} />
                    <button className={s.menuItem} disabled title="即将上线">
                      <span className={s.menuIcon}>&#x1F4C4;</span>
                      <span className={s.menuLabel}>Word 文档</span>
                    </button>
                    <button className={s.menuItem} disabled title="即将上线">
                      <span className={s.menuIcon}>&#x1F4CB;</span>
                      <span className={s.menuLabel}>PPT 演示</span>
                    </button>
                    <button className={s.menuItem} disabled title="即将上线">
                      <span className={s.menuIcon}>&#x1F3B5;</span>
                      <span className={s.menuLabel}>音频</span>
                    </button>
                    <button className={s.menuItem} disabled title="即将上线">
                      <span className={s.menuIcon}>&#x1F3AC;</span>
                      <span className={s.menuLabel}>视频</span>
                    </button>
                    <div className={s.menuComingSoon}>即将上线</div>
                  </div>
                )}
              </div>
              <textarea
                ref={ref}
                className={s.input}
                rows={1}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKey}
                onInput={onInput}
                placeholder={'...'}
                disabled={disabled}
              />
              <button className={s.send} onClick={send} disabled={disabled || (!text.trim() && !pendingFile)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
            {pendingFile && (
              <div className={s.fileChip}>
                <span className={s.fileChipIcon}>{pendingFile.type === 'excel' ? '\u{1F4CA}' : '\u{1F5BC}'}</span>
                <span className={s.fileChipName}>{pendingFile.file.name}</span>
                <button className={s.fileChipRemove} onClick={() => setPendingFile(null)} disabled={isUploading} title="移除">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="3" y1="3" x2="9" y2="9" />
                    <line x1="9" y1="3" x2="3" y2="9" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
        {uploadError && <div className={s.error}>{uploadError}</div>}
      </div>
    </>
  )
}
