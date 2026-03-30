import { create } from 'zustand'
import type { BubbleMemory } from '../types'
import { fetchMemories, softDeleteBubbleApi } from '../services/api'
import { useAuthStore } from './authStore'

interface MemoryState {
  memories: BubbleMemory[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
  deleteBubble: (id: string, reason: string) => Promise<void>
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  loading: false,
  error: null,
  load: async () => {
    set({ loading: true, error: null })
    try {
      const spaceId = useAuthStore.getState().currentSpaceId || undefined
      const data = await fetchMemories(spaceId)
      set({ memories: data.memories || [], loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), loading: false })
    }
  },
  deleteBubble: async (id: string, reason: string) => {
    await softDeleteBubbleApi(id, reason)
    set({ memories: get().memories.filter(m => m.id !== id) })
  },
}))
