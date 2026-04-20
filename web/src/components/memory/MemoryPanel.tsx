import { useEffect, useRef, useState } from 'react'
import { useMemoryStore } from '../../stores/memoryStore'
import { useBizStore } from '../../stores/bizStore'
import { uploadExcel } from '../../services/api'
import type { ExcelImportResult } from '../../services/api'
import { BubbleCard } from './BubbleCard'
import s from './MemoryPanel.module.css'

function formatImportResult(res: ExcelImportResult): string {
  const parts: string[] = [`导入成功: ${res.created} 条记录`]
  const biz = res.bizBridge
  if (biz) {
    const bizCreated: string[] = []
    if (biz.created.purchases) bizCreated.push(`采购 ${biz.created.purchases}`)
    if (biz.created.sales) bizCreated.push(`销售 ${biz.created.sales}`)
    if (biz.created.logistics) bizCreated.push(`物流 ${biz.created.logistics}`)
    if (biz.created.payments) bizCreated.push(`付款 ${biz.created.payments}`)
    if (bizCreated.length) parts.push(`业务记录: ${bizCreated.join(', ')}`)

    const bizSkipped: string[] = []
    if (biz.skipped.purchases) bizSkipped.push(`采购 ${biz.skipped.purchases}`)
    if (biz.skipped.sales) bizSkipped.push(`销售 ${biz.skipped.sales}`)
    if (biz.skipped.logistics) bizSkipped.push(`物流 ${biz.skipped.logistics}`)
    if (biz.skipped.payments) bizSkipped.push(`付款 ${biz.skipped.payments}`)
    if (bizSkipped.length) parts.push(`跳过(重复): ${bizSkipped.join(', ')}`)

    if (biz.errors.length) parts.push(`错误: ${biz.errors.length} 条`)
  }
  return parts.join(' | ')
}

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
      setMsg(formatImportResult(res))

      // Excel 导入后，无条件刷新 bizStore（数据可能新建或跳过重复）
      const bizState = useBizStore.getState()
      await Promise.all([
        bizState.loadPurchases(),
        bizState.loadSales(),
        bizState.loadLogistics(),
        bizState.loadPayments(),
      ])
      await Promise.all([
        bizState.loadInventory(),
        bizState.loadReceivables(),
        bizState.loadPayables(),
      ])
      await bizState.loadMasterData()

      load()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : '导入失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (loading) {
    return (
      <div className={s.loading}>
        <div className={s.spinner} />
        <span>Loading memories...</span>
      </div>
    )
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
