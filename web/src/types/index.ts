export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  timestamp: number
  isStreaming?: boolean
}

export interface WSMessage {
  type: 'start' | 'chunk' | 'done' | 'error'
  text?: string
}

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface BubbleMemory {
  id: string
  type: string
  title: string
  content: string
  metadata: Record<string, unknown>
  tags: string[]
  source: string
  confidence: number
  pinned: boolean
  createdAt: number
  updatedAt: number
}
