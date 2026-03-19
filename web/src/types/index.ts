export interface SourceRef {
  refIndex: number
  id: string
  title: string
  type: string
  tags: string[]
  source: string
  snippet: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  timestamp: number
  isStreaming?: boolean
  sources?: SourceRef[]
}

export interface WSMessage {
  type: 'start' | 'chunk' | 'done' | 'error'
  text?: string
  sources?: SourceRef[]
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

export interface AuthUserInfo {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  spaceIds: string[]
  spaces: SpaceInfo[]
}

export interface SpaceInfo {
  id: string
  name: string
  description: string
}

export interface LoginResponse {
  token: string
  user: AuthUserInfo
}

export type SpaceRole = 'owner' | 'editor' | 'viewer'

export interface SpaceMember {
  userId: string
  username: string
  displayName: string
  role: SpaceRole
}

export interface CustomAgent {
  id: string
  name: string
  description: string
  systemPrompt: string
  avatar: string
  tools: string[]
  spaceIds: string[]
  creatorId: string
  createdAt: number
  updatedAt: number
}
