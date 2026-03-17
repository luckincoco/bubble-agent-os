import { create } from 'zustand'

type Tab = 'chat' | 'memory'

interface UIState {
  activeTab: Tab
  setTab: (tab: Tab) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'chat',
  setTab: (tab) => set({ activeTab: tab }),
}))
