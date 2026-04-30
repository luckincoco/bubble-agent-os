import { create } from 'zustand'
import type { BubbleMemory, BubbleLink, KnowledgeStats, KnowledgeFilters, EvidenceTree, GraphSubset } from '../types'
import {
  fetchKnowledgeStats, fetchKnowledgeIndex, searchKnowledge,
  fetchBubbleDetail, fetchEvidenceChain, fetchGraphSubset, softDeleteBubbleApi,
} from '../services/api'
import { useAuthStore } from './authStore'

type ViewMode = 'index' | 'search' | 'detail'

interface KnowledgeState {
  // View state
  viewMode: ViewMode
  setViewMode: (mode: ViewMode) => void

  // Stats
  stats: KnowledgeStats | null
  loadStats: () => Promise<void>

  // Index (paginated list)
  items: BubbleMemory[]
  total: number
  page: number
  pageSize: number
  filters: KnowledgeFilters
  loading: boolean
  error: string | null
  loadIndex: (page?: number) => Promise<void>
  setFilters: (filters: KnowledgeFilters) => void

  // Search
  searchQuery: string
  searchResults: BubbleMemory[]
  searching: boolean
  setSearchQuery: (q: string) => void
  doSearch: () => Promise<void>

  // Detail view
  selectedId: string | null
  selectedBubble: BubbleMemory | null
  selectedLinks: BubbleLink[]
  evidenceTree: EvidenceTree | null
  graphData: GraphSubset | null
  detailLoading: boolean
  openDetail: (id: string) => Promise<void>
  closeDetail: () => void
  loadEvidence: (id: string) => Promise<void>
  loadGraph: (id: string) => Promise<void>

  // Actions
  deleteBubble: (id: string, reason: string) => Promise<void>
}

export const useKnowledgeStore = create<KnowledgeState>((set, get) => ({
  viewMode: 'index',
  setViewMode: (mode) => set({ viewMode: mode }),

  stats: null,
  loadStats: async () => {
    const spaceId = useAuthStore.getState().currentSpaceId || undefined
    const stats = await fetchKnowledgeStats(spaceId)
    set({ stats })
  },

  items: [],
  total: 0,
  page: 1,
  pageSize: 30,
  filters: { sortBy: 'updated', sortDir: 'desc' },
  loading: false,
  error: null,
  loadIndex: async (page?: number) => {
    const state = get()
    const p = page ?? state.page
    set({ loading: true, error: null, page: p })
    try {
      const spaceId = useAuthStore.getState().currentSpaceId || undefined
      const result = await fetchKnowledgeIndex(p, state.pageSize, spaceId, state.filters)
      set({ items: result.items, total: result.total, loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },
  setFilters: (filters) => {
    set({ filters: { ...get().filters, ...filters } })
    get().loadIndex(1)
  },

  searchQuery: '',
  searchResults: [],
  searching: false,
  setSearchQuery: (q) => set({ searchQuery: q }),
  doSearch: async () => {
    const { searchQuery, filters } = get()
    if (!searchQuery.trim()) return
    set({ searching: true, viewMode: 'search' })
    try {
      const spaceId = useAuthStore.getState().currentSpaceId || undefined
      const results = await searchKnowledge(searchQuery, 30, spaceId, filters)
      set({ searchResults: results, searching: false })
    } catch {
      set({ searching: false })
    }
  },

  selectedId: null,
  selectedBubble: null,
  selectedLinks: [],
  evidenceTree: null,
  graphData: null,
  detailLoading: false,
  openDetail: async (id) => {
    set({ selectedId: id, detailLoading: true, viewMode: 'detail', evidenceTree: null, graphData: null })
    try {
      const spaceId = useAuthStore.getState().currentSpaceId || undefined
      const { bubble, links } = await fetchBubbleDetail(id, spaceId)
      set({ selectedBubble: bubble, selectedLinks: links, detailLoading: false })
    } catch {
      set({ detailLoading: false })
    }
  },
  closeDetail: () => set({ viewMode: 'index', selectedId: null, selectedBubble: null, selectedLinks: [], evidenceTree: null, graphData: null }),
  loadEvidence: async (id) => {
    const spaceId = useAuthStore.getState().currentSpaceId || undefined
    const tree = await fetchEvidenceChain(id, spaceId)
    set({ evidenceTree: tree })
  },
  loadGraph: async (id) => {
    const spaceId = useAuthStore.getState().currentSpaceId || undefined
    const data = await fetchGraphSubset(id, 2, spaceId)
    set({ graphData: data })
  },

  deleteBubble: async (id, reason) => {
    await softDeleteBubbleApi(id, reason)
    const state = get()
    set({ items: state.items.filter(m => m.id !== id) })
    if (state.selectedId === id) {
      get().closeDetail()
    }
  },
}))
