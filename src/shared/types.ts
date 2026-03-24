// Bubble types
export type BubbleType = 'memory' | 'entity' | 'api' | 'workflow' | 'document' | 'event' | 'synthesis' | 'portrait' | 'question'

export interface BubbleLink {
  targetId: string
  relation: string
  weight: number
  source: 'user' | 'system' | 'inferred'
  createdAt: number
}

export interface Bubble {
  id: string
  type: BubbleType
  title: string
  content: string
  metadata: Record<string, unknown>
  tags: string[]
  embedding?: number[]
  links: BubbleLink[]
  createdAt: number
  updatedAt: number
  accessedAt: number
  source: string
  confidence: number
  decayRate: number
  pinned: boolean
  spaceId?: string
  abstractionLevel: number  // 0=atomic, 1=synthesis, 2=portrait
}

// Auth types
export interface AuthUser {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  spaceIds: string[]
  spaces: Space[]
}

export type SpaceRole = 'owner' | 'editor' | 'viewer'

export interface Space {
  id: string
  name: string
  description: string
  creatorId?: string
}

export interface SpaceMember {
  userId: string
  username: string
  displayName: string
  role: SpaceRole
}

export interface UserContext {
  userId: string
  spaceIds: string[]
  activeSpaceId: string
  activeAgentId?: string
}

// Citation / Source tracking
export interface SourceRef {
  refIndex: number
  id: string
  title: string
  type: BubbleType
  tags: string[]
  source: string
  snippet: string
}

export interface ThinkResult {
  response: string
  sources: SourceRef[]
}

// Custom Agent
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

// LLM types
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LLMResponse {
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

export interface LLMProvider {
  chat(messages: LLMMessage[]): Promise<LLMResponse>
  chatStream(messages: LLMMessage[], onChunk: (text: string) => void): Promise<LLMResponse>
}

// Embedding types
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
  embedBatch(texts: string[]): Promise<number[][]>
}

// Config types
export interface AppConfig {
  llm: {
    provider: 'deepseek' | 'openai' | 'ollama'
    apiKey?: string
    baseUrl?: string
    model?: string
  }
  storage: {
    dataDir: string
  }
  auth: {
    jwtSecret: string
    defaultPassword: string
    serviceApiKey?: string
  }
  feishu?: {
    appId: string
    appSecret: string
  }
  wecom?: {
    corpId: string
    agentId: number
    secret: string
    token: string
    encodingAESKey: string
  }
  tencent?: {
    secretId: string
    secretKey: string
    region?: string
  }
  features: {
    focusTracking: boolean
    semanticBridge: boolean
    surpriseDetection: boolean
  }
}
