import { useEffect, useState, useCallback } from 'react'
import { fetchForgeTools, fetchForgeToolCode, approveForge, disableForge } from '../../services/api'
import type { ForgeToolMeta } from '../../services/api'
import s from './ForgeManager.module.css'

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diffH = (now - ts) / (1000 * 60 * 60)
  if (diffH < 1) return `${Math.floor(diffH * 60)} 分钟前`
  if (diffH < 24) return `${Math.floor(diffH)} 小时前`
  if (diffH < 168) return `${Math.floor(diffH / 24)} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

const STATUS_LABEL: Record<string, string> = {
  pending: '待审批',
  active: '已生效',
  disabled: '已禁用',
  experimental: '试验中',
}

export function ForgeManager() {
  const [tools, setTools] = useState<ForgeToolMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState<string | null>(null)
  const [codeView, setCodeView] = useState<{ name: string; code: string } | null>(null)
  const [error, setError] = useState('')

  const loadTools = useCallback(async () => {
    try {
      setLoading(true)
      const list = await fetchForgeTools()
      setTools(list)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadTools() }, [loadTools])

  const handleApprove = async (name: string) => {
    if (!confirm(`确认审批工具 "${name}"？审批后重启即生效。`)) return
    setActing(name)
    try {
      await approveForge(name)
      await loadTools()
    } catch (err) {
      alert(err instanceof Error ? err.message : '审批失败')
    } finally {
      setActing(null)
    }
  }

  const handleDisable = async (name: string) => {
    if (!confirm(`确认禁用工具 "${name}"？`)) return
    setActing(name)
    try {
      await disableForge(name)
      await loadTools()
    } catch (err) {
      alert(err instanceof Error ? err.message : '禁用失败')
    } finally {
      setActing(null)
    }
  }

  const handleViewCode = async (name: string) => {
    try {
      const code = await fetchForgeToolCode(name)
      setCodeView({ name, code })
    } catch {
      alert('该工具无待审批代码')
    }
  }

  const pendingTools = tools.filter(t => t.status === 'pending')
  const otherTools = tools.filter(t => t.status !== 'pending')

  if (loading) {
    return <div className={s.container}><div className={s.loading}>加载中...</div></div>
  }

  return (
    <div className={s.container}>
      <div className={s.header}>
        <div>
          <div className={s.title}>自编码工具管理</div>
          <div className={s.subtitle}>管理 Bubble 自动生成的业务查询工具</div>
        </div>
      </div>

      {error && <div style={{ color: '#ef4444', fontSize: '13px' }}>{error}</div>}

      {tools.length === 0 && (
        <div className={s.empty}>
          暂无自编码工具。在飞书对话中说"帮我做一个查询XX的功能"即可触发。
        </div>
      )}

      {pendingTools.length > 0 && (
        <>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fbbf24' }}>
            待审批 ({pendingTools.length})
          </div>
          {pendingTools.map(tool => (
            <ToolCard
              key={tool.name}
              tool={tool}
              acting={acting}
              onApprove={handleApprove}
              onDisable={handleDisable}
              onViewCode={handleViewCode}
            />
          ))}
        </>
      )}

      {otherTools.length > 0 && (
        <>
          {pendingTools.length > 0 && (
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', marginTop: '8px' }}>
              已处理 ({otherTools.length})
            </div>
          )}
          {otherTools.map(tool => (
            <ToolCard
              key={tool.name}
              tool={tool}
              acting={acting}
              onApprove={handleApprove}
              onDisable={handleDisable}
              onViewCode={handleViewCode}
            />
          ))}
        </>
      )}

      {codeView && (
        <div className={s.codeOverlay} onClick={() => setCodeView(null)}>
          <div className={s.codePanel} onClick={e => e.stopPropagation()}>
            <div className={s.codePanelHeader}>
              <span className={s.codePanelTitle}>{codeView.name}.ts</span>
              <button className={s.closeBtn} onClick={() => setCodeView(null)}>x</button>
            </div>
            <div className={s.codeContent}>
              <pre className={s.codeBlock}>{codeView.code}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ToolCard({ tool, acting, onApprove, onDisable, onViewCode }: {
  tool: ForgeToolMeta
  acting: string | null
  onApprove: (name: string) => void
  onDisable: (name: string) => void
  onViewCode: (name: string) => void
}) {
  const badgeClass = tool.status === 'pending' ? s.badgePending
    : tool.status === 'active' ? s.badgeActive
    : s.badgeDisabled

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <span className={s.toolName}>{tool.name}</span>
        <span className={`${s.badge} ${badgeClass}`}>
          {STATUS_LABEL[tool.status] || tool.status}
        </span>
      </div>
      {tool.description && <div className={s.description}>{tool.description}</div>}
      <div className={s.meta}>
        <span>创建: {formatTime(tool.createdAt)}</span>
        {tool.approvedBy && <span>审批: {tool.approvedBy}</span>}
        {tool.invocationCount > 0 && (
          <span>调用: {tool.invocationCount} 次 (错误 {tool.errorCount})</span>
        )}
      </div>
      <div className={s.actions}>
        {tool.status === 'pending' && (
          <>
            <button
              className={`${s.btn} ${s.btnCode}`}
              onClick={() => onViewCode(tool.name)}
            >
              查看代码
            </button>
            <button
              className={`${s.btn} ${s.btnApprove}`}
              disabled={acting === tool.name}
              onClick={() => onApprove(tool.name)}
            >
              {acting === tool.name ? '处理中...' : '审批通过'}
            </button>
            <button
              className={`${s.btn} ${s.btnDisable}`}
              disabled={acting === tool.name}
              onClick={() => onDisable(tool.name)}
            >
              拒绝
            </button>
          </>
        )}
        {tool.status === 'active' && (
          <button
            className={`${s.btn} ${s.btnDisable}`}
            disabled={acting === tool.name}
            onClick={() => onDisable(tool.name)}
          >
            禁用
          </button>
        )}
      </div>
    </div>
  )
}
