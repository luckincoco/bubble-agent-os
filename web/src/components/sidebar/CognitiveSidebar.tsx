import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuthStore } from '../../stores/authStore'
import { useChatStore } from '../../stores/chatStore'
import { useMemoryStore } from '../../stores/memoryStore'
import { useAgentStore } from '../../stores/agentStore'
import { useDragResize } from '../../hooks/useDragResize'
import s from './CognitiveSidebar.module.css'

const SNAP_POINTS_SIDEBAR = [160, 240, 320]
const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 320
const COLLAPSE_THRESHOLD = 80

const COGNITION_COLORS: Record<string, string> = {
  observation: 'var(--cog-obs)',
  reflection: 'var(--cog-ref)',
  consolidation: 'var(--cog-con)',
}

interface Props {
  onOpenModule: (moduleId: string) => void
  activeOverlay: string | null
}

export function CognitiveSidebar({ onOpenModule, activeOverlay }: Props) {
  const user = useAuthStore((s) => s.user)
  const currentSpaceId = useAuthStore((s) => s.currentSpaceId)
  const spaces = user?.spaces || []
  const currentSpace = spaces.find((s) => s.id === currentSpaceId)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const memories = useMemoryStore((s) => s.memories)
  const messages = useChatStore((s) => s.messages)
  const logout = useAuthStore((s) => s.logout)
  const [toolOpen, setToolOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState(() => localStorage.getItem('bubble_avatar') || '')
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      return parseInt(localStorage.getItem('bubble.sidebar.width') || '240', 10)
    } catch {
      return 240
    }
  })

  // Agent state from store
  const thinkingState = useAgentStore((s) => s.thinkingState)
  const setThinkingState = useAgentStore((s) => s.setThinkingState)
  const respondedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 3-state thinking indicator: idle → thinking → responded → idle
  useEffect(() => {
    if (isStreaming) {
      setThinkingState('thinking')
      if (respondedTimer.current) {
        clearTimeout(respondedTimer.current)
        respondedTimer.current = null
      }
    } else if (thinkingState === 'thinking') {
      setThinkingState('responded')
      respondedTimer.current = setTimeout(() => {
        setThinkingState('idle')
      }, 2000)
    }
    return () => {
      if (respondedTimer.current) clearTimeout(respondedTimer.current)
    }
  }, [isStreaming])

  const isEffectivelyExpanded = !collapsed || hovered
  const spaceColor = currentSpaceId === 'space-2' ? 'var(--teal)' : 'var(--purple)'

  const recentMemories = memories.slice(0, 5)

  // Get tool calls + context summary from the last non-streaming assistant message
  const lastAssistantMessage = messages.filter(m => m.role === 'assistant' && !m.isStreaming).pop()
  const lastToolCalls = lastAssistantMessage?.toolCalls ?? []
  const contextSummary = lastAssistantMessage?.contextSummary

  // Capability modules — colored dot + label
  const capabilities = [
    { id: 'biz', label: '业务管理', color: 'var(--cog-obs)' },
    { id: 'memory', label: '知识', color: 'var(--cog-con)' },
    { id: 'forge', label: '自编码', color: 'var(--cog-ref)' },
  ]

  const sidebarRef = useRef<HTMLElement>(null)
  const displayWidth = collapsed && !hovered ? 8 : sidebarWidth

  const onDragEnd = useCallback((w: number) => {
    if (w < COLLAPSE_THRESHOLD) {
      setCollapsed(true)
    } else {
      localStorage.setItem('bubble.sidebar.width', String(w))
    }
  }, [])

  const { isDragging, handleMouseDown } = useDragResize({
    ref: sidebarRef,
    initialWidth: sidebarWidth,
    minWidth: SIDEBAR_MIN,
    maxWidth: SIDEBAR_MAX,
    snapPoints: SNAP_POINTS_SIDEBAR,
    onWidthChange: setSidebarWidth,
    onDragEnd,
  })

  const handleCollapse = () => {
    localStorage.setItem('bubble.sidebar.width', String(sidebarWidth))
    setCollapsed(!collapsed)
  }

  const handleAvatarSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = reader.result as string
      localStorage.setItem('bubble_avatar', url)
      setAvatarUrl(url)
    }
    reader.readAsDataURL(file)
    e.target.value = ''
  }

  const handleMouseEnter = () => {
    if (collapsed) {
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
      setHovered(true)
    }
  }

  const handleMouseLeave = () => {
    if (collapsed) {
      hoverTimer.current = setTimeout(() => setHovered(false), 300)
    }
  }

  return (
    <aside
      ref={sidebarRef}
      className={`${s.sidebar} ${isEffectivelyExpanded ? '' : s.collapsed}`}
      style={{ width: `${displayWidth}px` } as React.CSSProperties}
      data-sidebar=""
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {isEffectivelyExpanded ? (
        <>
          {/* Space Switcher + collapse button */}
          <div className={s.spaceArea}>
            <span className={s.spaceDot} style={{ background: spaceColor }} />
            <span className={s.spaceName}>{currentSpace?.name || '私人空间'}</span>
            <button className={s.collapseBtn} onClick={handleCollapse} title="折叠侧边栏">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <polyline points="6 2, 3 5, 6 8" />
              </svg>
            </button>
          </div>

          {/* Thinking state indicator — only visible when actively thinking */}
          {thinkingState === 'thinking' && (
            <div className={s.statusRow}>
              <span className={`${s.statusDot} ${s.thinkingThinking}`} />
              思考中...
            </div>
          )}

          {/* Context Summary */}
          <div className={s.section}>
            <div className={s.sectionTitle}>上下文摘要</div>
            <div className={s.contextSummary}>
              {contextSummary || '当前会话暂无上下文'}
            </div>
          </div>

          {/* Active Memory List */}
          <div className={s.section}>
            <div className={s.sectionTitle}>活跃记忆</div>
            <div className={s.memoryList}>
              {recentMemories.length === 0 && (
                <div style={{ padding: '8px', fontSize: '11px', color: 'var(--text-dim)' }}>
                  暂无活跃记忆
                </div>
              )}
              {recentMemories.map((m) => (
                <div key={m.id} className={s.memoryItem}>
                  <span
                    className={s.memoryDot}
                    style={{ background: COGNITION_COLORS[m.type] || 'var(--text-dim)' }}
                  />
                  <span className={s.memoryTitle}>{m.title || m.summary || '记忆'}</span>
                  <span className={s.memoryTime}>{relativeTime(m.updatedAt)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tool Call Records */}
          <div className={s.toolSection}>
            <button className={s.toolHeader} onClick={() => setToolOpen(!toolOpen)}>
              <span className={`${s.toolChevron} ${toolOpen ? s.toolChevronOpen : ''}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 2, 7 5, 4 8" />
                </svg>
              </span>
              工具调用
              <span className={s.toolCount}>{lastToolCalls.length}</span>
            </button>
            {toolOpen && (
              <div className={s.toolList}>
                {lastToolCalls.length === 0 ? (
                  <div style={{ padding: '4px 8px', fontSize: '11px', color: 'var(--text-dim)' }}>
                    暂无工具调用记录
                  </div>
                ) : (
                  lastToolCalls.map((tc, i) => (
                    <div key={i} className={s.toolItem}>
                      <span className={`${s.toolDot} ${tc.status === 'success' ? s.toolOk : ''}`} />
                      <span className={s.toolName}>{humanizeToolName(tc.name)}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-dim)' }}>
                        {tc.durationMs}ms
                      </span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Spacer to push capabilities + user to bottom */}
          <div className={s.spacer} />

          {/* Capability Tags */}
          <div className={s.capabilityList}>
            {capabilities.map((cap) => (
              <button
                key={cap.id}
                className={`${s.capabilityTag} ${activeOverlay === cap.id ? s.capabilityTagActive : ''}`}
                onClick={() => onOpenModule(cap.id)}
              >
                <span className={s.capabilityDot} style={{ background: cap.color }} />
                <span className={s.capabilityLabel}>{cap.label}</span>
              </button>
            ))}
          </div>

          {/* User Area */}
          {user && (
            <div className={s.userArea}>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                onChange={handleAvatarSelect}
                hidden
              />
              <button className={s.userAvatar} onClick={() => avatarInputRef.current?.click()} title="更换头像">
                {avatarUrl
                  ? <img src={avatarUrl} alt="" className={s.userAvatarImg} />
                  : (currentSpace?.name?.[0] || user.displayName?.[0] || 'U')
                }
              </button>
              <span className={s.userName}>{user.displayName || '用户'}</span>
              <button
                className={s.actionBtn}
                onClick={() => onOpenModule('settings')}
                title="设置"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                  <circle cx="7" cy="7" r="2" />
                  <path d="M7 1v2M7 11v2M1 7h2M11 7h2M2.5 2.5l1.5 1.5M10 10l1.5 1.5M2.5 11.5l1.5-1.5M10 3l1.5-1.5" />
                </svg>
              </button>
              <button
                className={`${s.actionBtn} ${s.actionBtnLogout}`}
                onClick={logout}
                title="退出登录"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 2H3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
                  <polyline points="9 10, 12 7, 9 4" />
                  <line x1="12" y1="7" x2="5" y2="7" />
                </svg>
              </button>
            </div>
          )}
          {/* Resize handle */}
          <div
            className={`${s.resizeHandle} ${isDragging ? s.resizeHandleActive : ''}`}
            onMouseDown={handleMouseDown}
          />
        </>
      ) : (
        /* Collapsed: space dot + expand button */
        <div className={s.collapsedContent}>
          <span className={s.spaceDot} style={{ background: spaceColor }} />
          <button className={s.expandBtn} onClick={() => setCollapsed(false)} title="展开侧边栏">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <polyline points="3.5 2, 6.5 5, 3.5 8" />
            </svg>
          </button>
        </div>
      )}
    </aside>
  )
}

function humanizeToolName(name: string): string {
  const map: Record<string, string> = {
    web_search: '搜索',
    fetch_page: '网页抓取',
    cross_analyze: '交叉分析',
    weather: '天气',
    time: '时间',
    query_excel: 'Excel 查询',
    export_excel: 'Excel 导出',
    clean_excel: 'Excel 清理',
    biz_dashboard: '业务概览',
    biz_inventory: '库存查询',
    biz_receivables: '应收款查询',
    biz_payables: '应付款查询',
    biz_profit_report: '利润报表',
    biz_profit_by_order: '按单利润',
    biz_counterparty_statement: '往来对账',
    biz_monthly_overview: '月度总览',
    biz_project_reconciliation: '项目结算',
    biz_uninvoiced: '未开票查询',
    biz_silence_alerts: '沉默预警',
    biz_exposure: '财务敞口',
    biz_concentration: '集中度分析',
    biz_relationships: '交易对手关系',
    biz_excel_lookup: 'Excel 原始数据',
    ext_my_orders: '我的订单',
    ext_my_payments: '我的付款',
    ext_my_logistics: '我的物流',
    ext_price_inquiry: '询价',
    ext_confirm_receipt: '确认收货',
    ext_payment_status: '对账单',
    ext_switch_role: '切换公司',
  }
  if (map[name]) return map[name]

  // Fallback: strip prefixes for cleaner display
  let label = name
  if (label.startsWith('biz_')) label = label.slice(4)
  else if (label.startsWith('ext_')) label = label.slice(4)
  else if (label.startsWith('excel_')) label = `Excel:${label.slice(6)}`
  else if (label.startsWith('code_')) label = label.slice(5)

  // Convert snake_case to spaced words
  return label.replace(/_/g, ' ')
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}
