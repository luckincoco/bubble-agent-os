import { create } from 'zustand'
import type { BubbleMemory } from '../types'
import { fetchMemories } from '../services/api'
import { useAuthStore } from './authStore'

interface MemoryState {
  memories: BubbleMemory[]
  loading: boolean
  error: string | null
  load: () => Promise<void>
}

export const useMemoryStore = create<MemoryState>((set) => ({
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
}))
