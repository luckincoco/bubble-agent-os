import { create } from 'zustand'
import type { ChatMessage, ConnectionStatus, WSMessage } from '../types'
import { WSManager, getWSUrl } from '../services/websocket'
import { useAuthStore } from './authStore'
import { fetchAssertionsByTurn } from '../services/api'

interface ChatState {
  messages: ChatMessage[]
  isStreaming: boolean
  status: ConnectionStatus
  wsManager: WSManager | null
  connect: () => void
  disconnect: () => void
  sendMessage: (text: string) => void
}

let msgCounter = 0
const genId = () => `msg-${Date.now()}-${++msgCounter}`

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  status: 'disconnected',
  wsManager: null,

  connect: () => {
    const existing = get().wsManager
    if (existing) existing.disconnect()

    const manager = new WSManager(
      getWSUrl(),
      (msg: WSMessage) => {
        const state = get()
        switch (msg.type) {
          case 'start': {
            const aiMsg: ChatMessage = {
              id: genId(),
              role: 'assistant',
              content: '',
              timestamp: Date.now(),
              isStreaming: true,
            }
            set({ messages: [...state.messages, aiMsg], isStreaming: true })
            break
          }
          case 'chunk': {
            const msgs = [...state.messages]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant') {
              msgs[msgs.length - 1] = { ...last, content: last.content + (msg.text || '') }
              set({ messages: msgs })
            }
            break
          }
          case 'done': {
            const msgs = [...state.messages]
            const last = msgs[msgs.length - 1]
            if (last?.role === 'assistant') {
              msgs[msgs.length - 1] = {
                ...last,
                content: msg.text || last.content,
                isStreaming: false,
                sources: msg.sources,
                turnId: msg.turnId,
                cognitionLayer: msg.cognitionLayer,
                panel: msg.panel,
                toolCalls: msg.toolCalls,
                contextSummary: msg.contextSummary,
              }
              set({ messages: msgs, isStreaming: false })
              // Fetch assertions after async identification completes (~3.5s)
              if (msg.turnId) {
                const turnId = msg.turnId
                setTimeout(async () => {
                  try {
                    const assertions = await fetchAssertionsByTurn(turnId)
                    if (assertions.length > 0) {
                      const currentMsgs = get().messages
                      const idx = currentMsgs.findIndex(m => m.turnId === turnId)
                      if (idx >= 0) {
                        const updated = [...currentMsgs]
                        updated[idx] = { ...updated[idx], assertions }
                        set({ messages: updated })
                      }
                    }
                  } catch { /* non-critical, silent */ }
                }, 3500)
              }
            }
            break
          }
          case 'error': {
            const errMsg: ChatMessage = {
              id: genId(),
              role: 'error',
              content: msg.text || 'Unknown error',
              timestamp: Date.now(),
            }
            set({ messages: [...state.messages, errMsg], isStreaming: false })
            break
          }
        }
      },
      (status: ConnectionStatus) => set({ status }),
    )

    manager.connect()
    set({ wsManager: manager })
  },

  disconnect: () => {
    get().wsManager?.disconnect()
    set({ wsManager: null, status: 'disconnected' })
  },

  sendMessage: (text: string) => {
    const { wsManager, isStreaming } = get()
    if (!wsManager || isStreaming) return
    const spaceId = useAuthStore.getState().currentSpaceId
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    }
    set((s) => ({ messages: [...s.messages, userMsg] }))
    wsManager.send({ message: text, spaceId })
  },
}))
