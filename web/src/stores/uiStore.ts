import { create } from 'zustand'

export type Tab = 'home' | 'entry' | 'query' | 'chat' | 'memory'

interface UIState {
  activeTab: Tab
  setTab: (tab: Tab) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'home',
  setTab: (tab) => set({ activeTab: tab }),
}))
