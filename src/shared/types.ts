// Bubble types
export type BubbleType = 'memory' | 'entity' | 'api' | 'workflow' | 'document' | 'event'

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

export interface Space {
  id: string
  name: string
  description: string
}

export interface UserContext {
  userId: string
  spaceIds: string[]
  activeSpaceId: string
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
  features: {
    focusTracking: boolean
    semanticBridge: boolean
    surpriseDetection: boolean
  }
}
