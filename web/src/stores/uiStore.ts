import { create } from 'zustand'

export type Tab = string

interface UIState {
  activeTab: Tab
  setTab: (tab: Tab) => void
}

export const useUIStore = create<UIState>((set) => ({
  activeTab: 'chat',
  setTab: (tab) => set({ activeTab: tab }),
}))
