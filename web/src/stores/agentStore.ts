import { create } from 'zustand'
import { useChatStore } from './chatStore'
import type { AgentState, CognitionLayer } from '../types'

type ThinkingState = 'idle' | 'thinking' | 'responded'

interface AgentStoreState {
  // Cognitive state
  cognitionLayer: CognitionLayer
  thinkingChain: string | null

  // Thinking indicator (3-state: idle → thinking → responded → idle)
  thinkingState: ThinkingState

  // Actions
  setCognitionLayer: (layer: CognitionLayer) => void
  setThinkingChain: (chain: string | null) => void
  setThinkingState: (state: ThinkingState) => void
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  // Initial state
  cognitionLayer: 'observation',
  thinkingChain: null,
  thinkingState: 'idle',

  setCognitionLayer: (layer) => set({ cognitionLayer: layer }),
  setThinkingChain: (chain) => set({ thinkingChain: chain }),
  setThinkingState: (state) => set({ thinkingState: state }),
}))

/**
 * Hook that auto-drives thinkingState from chatStore.isStreaming.
 * Replaces the old inline useEffect in CognitiveSidebar.
 */
export function useThinkingState() {
  const isStreaming = useChatStore((s) => s.isStreaming)
  const thinkingState = useAgentStore((s) => s.thinkingState)
  const setThinkingState = useAgentStore((s) => s.setThinkingState)

  // idle → thinking → responded → idle
  // This logic lives in the component effect to manage the 2s timeout
  return { isStreaming, thinkingState, setThinkingState }
}
