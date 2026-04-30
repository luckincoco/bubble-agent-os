import { useEffect, useRef } from 'react'
import { useKnowledgeStore } from '../../stores/knowledgeStore'
import { useBizStore } from '../../stores/bizStore'
import { uploadExcel } from '../../services/api'
import type { ExcelImportResult } from '../../services/api'
import { useState } from 'react'
import s from './KnowledgeBrowser.module.css'
import type { BubbleMemory, EvidenceNode as EvidenceNodeType } from '../../types'

// ── Helpers ────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts)
  const now = Date.now()
  const diffH = (now - ts) / (1000 * 60 * 60)
  if (diffH < 1) return `${Math.floor(diffH * 60)}m ago`
  if (diffH < 24) return `${Math.floor(diffH)}h ago`
  if (diffH < 168) return `${Math.floor(diffH / 24)}d ago`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

const LEVEL_LABELS: Record<number, string> = { 0: 'L0', 1: 'L1', 2: 'L2' }
const TYPE_LABELS: Record<string, string> = {
  memory: '记忆', entity: '实体', synthesis: '综合', portrait: '画像',
  observation: '观察', question: '问题', document: '文档', event: '事件',
}

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
  }
  return parts.join(' | ')
}

// ── Main Component ─────────────────────────────────────────────

export function KnowledgeBrowser() {
  const store = useKnowledgeStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')

  useEffect(() => {
    store.loadStats()
    store.loadIndex(1)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadMsg('')
    try {
      const res = await uploadExcel(file)
      setUploadMsg(formatImportResult(res))
      const bizState = useBizStore.getState()
      await Promise.all([bizState.loadPurchases(), bizState.loadSales(), bizState.loadLogistics(), bizState.loadPayments()])
      store.loadIndex(1)
      store.loadStats()
    } catch (err) {
      setUploadMsg(err instanceof Error ? err.message : '导入失败')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const handleSearch = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') store.doSearch()
  }

  const handleSearchClear = () => {
    store.setSearchQuery('')
    store.setViewMode('index')
  }

  return (
    <div className={s.browser}>
      {/* Toolbar */}
      <div className={s.toolbar}>
        <div className={s.searchBox}>
          <svg className={s.searchIcon} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input
            className={s.searchInput}
            placeholder="搜索知识..."
            value={store.searchQuery}
            onChange={e => store.setSearchQuery(e.target.value)}
            onKeyDown={handleSearch}
          />
          {store.searchQuery && (
            <button style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer' }} onClick={handleSearchClear}>x</button>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} hidden />
        <button className={s.sortBtn} onClick={() => fileRef.current?.click()} disabled={uploading}>
          {uploading ? '导入中...' : '上传Excel'}
        </button>
        {uploadMsg && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)' }}>{uploadMsg}</span>}
      </div>

      {/* Filter chips */}
      <FilterChips />

      {/* Content area */}
      {store.viewMode === 'detail' ? (
        <BubbleDetailView />
      ) : store.viewMode === 'search' ? (
        <SearchResultsView />
      ) : (
        <>
          {store.stats && <StatsSummary />}
          <KnowledgeListView />
        </>
      )}
    </div>
  )
}

// ── Filter Chips ───────────────────────────────────────────────

function FilterChips() {
  const { filters, setFilters, stats } = useKnowledgeStore()

  const types = stats ? Object.keys(stats.byType) : []
  const toggleType = (t: string) => {
    const current = filters.types || []
    const next = current.includes(t) ? current.filter(x => x !== t) : [...current, t]
    setFilters({ types: next.length ? next : undefined })
  }

  const cycleSortBy = () => {
    const order: Array<'updated' | 'created' | 'confidence'> = ['updated', 'created', 'confidence']
    const idx = order.indexOf(filters.sortBy || 'updated')
    setFilters({ sortBy: order[(idx + 1) % order.length] })
  }

  const sortLabels = { updated: '最近更新', created: '最新创建', confidence: '可信度' }

  return (
    <div className={s.filterChips}>
      {types.map(t => (
        <span
          key={t}
          className={`${s.chip} ${filters.types?.includes(t) ? s.chipActive : ''}`}
          onClick={() => toggleType(t)}
        >
          {TYPE_LABELS[t] || t}
        </span>
      ))}
      <button className={s.sortBtn} onClick={cycleSortBy}>
        {sortLabels[filters.sortBy || 'updated']} {filters.sortDir === 'asc' ? '↑' : '↓'}
      </button>
    </div>
  )
}

// ── Stats Summary ──────────────────────────────────────────────

function StatsSummary() {
  const stats = useKnowledgeStore(s => s.stats)!
  return (
    <div className={s.statsRow}>
      <div className={s.statCard}><div className={s.statValue}>{stats.total}</div><div className={s.statLabel}>Total</div></div>
      <div className={s.statCard}><div className={s.statValue}>{stats.recentWeek}</div><div className={s.statLabel}>This Week</div></div>
      <div className={s.statCard}><div className={s.statValue}>{stats.totalLinks}</div><div className={s.statLabel}>Links</div></div>
      <div className={s.statCard}><div className={s.statValue}>{Object.keys(stats.bySource).length}</div><div className={s.statLabel}>Sources</div></div>
    </div>
  )
}

// ── Knowledge Card ─────────────────────────────────────────────

function KnowledgeCard({ bubble }: { bubble: BubbleMemory }) {
  const openDetail = useKnowledgeStore(s => s.openDetail)
  return (
    <div className={s.card} onClick={() => openDetail(bubble.id)}>
      <div className={s.cardHeader}>
        <span className={s.typeBadge}>{TYPE_LABELS[bubble.type] || bubble.type}</span>
        {(bubble.abstractionLevel ?? 0) > 0 && (
          <span className={s.levelBadge}>{LEVEL_LABELS[bubble.abstractionLevel ?? 0] ?? `L${bubble.abstractionLevel}`}</span>
        )}
        <span className={s.cardTitle}>{bubble.title}</span>
      </div>
      <div className={s.cardContent}>{bubble.summary || bubble.content}</div>
      {bubble.tags.length > 0 && (
        <div className={s.tags}>
          {bubble.tags.slice(0, 4).map(t => <span key={t} className={s.tag}>{t}</span>)}
        </div>
      )}
      <div className={s.cardMeta}>
        <span className={s.sourceBadge}>{bubble.source}</span>
        <div className={s.confidenceBar}>
          <div className={s.confidenceFill} style={{ width: `${bubble.confidence * 100}%` }} />
        </div>
        <span>{formatTime(bubble.updatedAt)}</span>
      </div>
    </div>
  )
}

// ── Knowledge List View ────────────────────────────────────────

function KnowledgeListView() {
  const { items, total, page, pageSize, loading, error, loadIndex } = useKnowledgeStore()
  const totalPages = Math.ceil(total / pageSize)

  if (loading) return <div className={s.loading}><div className={s.spinner} /><span>Loading...</span></div>
  if (error) return <div className={s.empty}><div>Error: {error}</div></div>
  if (items.length === 0) return <div className={s.empty}><div className={s.emptyIcon}>&#x1F9E0;</div><div>No knowledge yet</div></div>

  return (
    <>
      <div className={s.list}>
        {items.map(b => <KnowledgeCard key={b.id} bubble={b} />)}
      </div>
      {totalPages > 1 && (
        <div className={s.pagination}>
          <button className={s.pageBtn} disabled={page <= 1} onClick={() => loadIndex(page - 1)}>Prev</button>
          <span className={s.pageInfo}>{page} / {totalPages}</span>
          <button className={s.pageBtn} disabled={page >= totalPages} onClick={() => loadIndex(page + 1)}>Next</button>
        </div>
      )}
    </>
  )
}

// ── Search Results View ────────────────────────────────────────

function SearchResultsView() {
  const { searchResults, searching, searchQuery, setViewMode } = useKnowledgeStore()

  if (searching) return <div className={s.loading}><div className={s.spinner} /><span>Searching...</span></div>

  return (
    <>
      <button className={s.backBtn} onClick={() => setViewMode('index')}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        Back to index
      </button>
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-dim)', marginBottom: 'var(--space-3)' }}>
        "{searchQuery}" - {searchResults.length} results
      </div>
      {searchResults.length === 0 ? (
        <div className={s.empty}><div>No results found</div></div>
      ) : (
        <div className={s.list}>
          {searchResults.map(b => <KnowledgeCard key={b.id} bubble={b} />)}
        </div>
      )}
    </>
  )
}

// ── Bubble Detail View ─────────────────────────────────────────

function BubbleDetailView() {
  const {
    selectedBubble, selectedLinks, evidenceTree, detailLoading,
    closeDetail, loadEvidence, loadGraph,
  } = useKnowledgeStore()
  const [tab, setTab] = useState<'content' | 'links' | 'evidence'>('content')

  if (detailLoading) return <div className={s.loading}><div className={s.spinner} /><span>Loading detail...</span></div>
  if (!selectedBubble) return null

  const b = selectedBubble

  return (
    <div className={s.detailPanel}>
      <button className={s.backBtn} onClick={closeDetail}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6"/></svg>
        Back
      </button>

      <div className={s.detailHeader}>
        <span className={s.typeBadge}>{TYPE_LABELS[b.type] || b.type}</span>
        {(b.abstractionLevel ?? 0) > 0 && (
          <span className={s.levelBadge}>{LEVEL_LABELS[b.abstractionLevel ?? 0]}</span>
        )}
        <span className={s.detailTitle}>{b.title}</span>
      </div>

      {/* Tabs */}
      <div className={s.detailTabs}>
        <button className={`${s.detailTab} ${tab === 'content' ? s.detailTabActive : ''}`} onClick={() => setTab('content')}>Content</button>
        <button className={`${s.detailTab} ${tab === 'links' ? s.detailTabActive : ''}`} onClick={() => setTab('links')}>Links ({selectedLinks.length})</button>
        <button
          className={`${s.detailTab} ${tab === 'evidence' ? s.detailTabActive : ''}`}
          onClick={() => { setTab('evidence'); if (!evidenceTree) loadEvidence(b.id) }}
        >
          Evidence
        </button>
      </div>

      {tab === 'content' && (
        <div className={s.detailBody}>
          <div className={s.detailContent}>{b.content}</div>
          <div className={s.detailMeta}>
            <span>Source: {b.source}</span>
            <span>Confidence: {(b.confidence * 100).toFixed(0)}%</span>
            <span>Created: {new Date(b.createdAt).toLocaleDateString('zh-CN')}</span>
            <span>Updated: {formatTime(b.updatedAt)}</span>
            {b.tags.length > 0 && <span>Tags: {b.tags.join(', ')}</span>}
          </div>
        </div>
      )}

      {tab === 'links' && (
        <LinksView links={selectedLinks} />
      )}

      {tab === 'evidence' && (
        <EvidenceView tree={evidenceTree} />
      )}
    </div>
  )
}

// ── Links View ─────────────────────────────────────────────────

function LinksView({ links }: { links: Array<{ targetId: string; relation: string; weight: number; source: string }> }) {
  const openDetail = useKnowledgeStore(s => s.openDetail)

  if (links.length === 0) return <div className={s.empty}><div>No links</div></div>

  return (
    <div className={s.linkList}>
      {links.map((link, i) => (
        <div key={i} className={s.linkRow} onClick={() => openDetail(link.targetId)}>
          <span className={s.linkRelation}>{link.relation}</span>
          <span className={s.linkTitle}>{link.targetId}</span>
          <span className={s.linkWeight}>{(link.weight * 100).toFixed(0)}%</span>
        </div>
      ))}
    </div>
  )
}

// ── Evidence View ──────────────────────────────────────────────

function EvidenceView({ tree }: { tree: EvidenceNodeType[] | null | { nodes: EvidenceNodeType[]; totalCount: number; sourceBreakdown: Record<string, number> } }) {
  if (!tree) return <div className={s.loading}><div className={s.spinner} /><span>Loading evidence chain...</span></div>

  const nodes = Array.isArray(tree) ? tree : tree.nodes
  const total = Array.isArray(tree) ? nodes.length : tree.totalCount

  if (nodes.length === 0) return <div className={s.empty}><div>No evidence found</div></div>

  return (
    <div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-dim)', marginBottom: 'var(--space-3)' }}>
        {total} evidence nodes
        {!Array.isArray(tree) && tree.sourceBreakdown && (
          <span> ({Object.entries(tree.sourceBreakdown).map(([k, v]) => `${k}: ${v}`).join(', ')})</span>
        )}
      </div>
      {nodes.map((node, i) => (
        <EvidenceNodeComponent key={i} node={node} />
      ))}
    </div>
  )
}

function EvidenceNodeComponent({ node }: { node: EvidenceNodeType }) {
  const openDetail = useKnowledgeStore(s => s.openDetail)
  return (
    <div className={s.evidenceNode}>
      <div className={s.evidenceNodeInner} onClick={() => openDetail(node.bubble.id)} style={{ cursor: 'pointer' }}>
        <div className={s.evidenceRelation}>{node.relation}</div>
        <div className={s.evidenceTitle}>{node.bubble.title}</div>
        <div className={s.evidenceSnippet}>{node.bubble.content}</div>
      </div>
      {node.children.length > 0 && node.children.map((child, i) => (
        <EvidenceNodeComponent key={i} node={child} />
      ))}
    </div>
  )
}
