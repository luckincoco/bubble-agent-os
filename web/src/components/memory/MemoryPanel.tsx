import { useEffect, useRef, useState } from 'react'
import { useMemoryStore } from '../../stores/memoryStore'
import { uploadExcel } from '../../services/api'
import { BubbleCard } from './BubbleCard'
import s from './MemoryPanel.module.css'

export function MemoryPanel() {
  const { memories, loading, error, load } = useMemoryStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => { load() }, [load])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setMsg('')
    try {
      const res = await uploadExcel(file)
      setMsg(`导入成功: ${res.created} 条记录`)
      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '导入失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (loading) {
    return <div className={s.loading}>Loading memories...</div>
  }

  if (error) {
    return (
      <div className={s.error}>
        <div>Failed to load: {error}</div>
        <button className={s.retry} onClick={load}>Retry</button>
      </div>
    )
  }

  return (
    <div className={s.panel}>
      <div className={s.toolbar}>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.xls"
          onChange={handleUpload}
          hidden
        />
        <button
          className={s.uploadBtn}
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '导入中...' : '上传Excel'}
        </button>
        {msg && <span className={s.uploadMsg}>{msg}</span>}
      </div>
      {memories.length === 0 ? (
        <div className={s.empty}>
          <div className={s.emptyIcon}>&#x1FAE7;</div>
          <div>No memories yet</div>
        </div>
      ) : (
        <div className={s.grid}>
          {memories.map((m) => <BubbleCard key={m.id} memory={m} />)}
        </div>
      )}
    </div>
  )
}
