// Bubble types
export type BubbleType = 'memory' | 'entity' | 'api' | 'workflow' | 'document' | 'event' | 'synthesis' | 'portrait' | 'question' | 'observation'

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
  summary?: string
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

// External user context — extends UserContext with counterparty binding info
export interface ExternalUserContext extends UserContext {
  isExternal: true
  counterpartyId: string
  counterpartyName: string
  counterpartyType: 'supplier' | 'customer' | 'logistics'
  permissionLevel: 'query' | 'query_confirm'
  platformUserId: string
  platform: 'wecom' | 'feishu'
}

export function isExternalContext(ctx: UserContext): ctx is ExternalUserContext {
  return 'isExternal' in ctx && (ctx as ExternalUserContext).isExternal === true
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

// ── v0.7.0: Temporal + Event + View + Working Memory types ─────

export interface Episode {
  id: string
  type: 'conversation' | 'business' | 'system'
  source: 'feishu' | 'wecom' | 'scheduler' | 'admin' | 'api' | 'cli'
  actorId: string | null
  spaceId: string | null
  content: string
  summary: string | null
  metadata: Record<string, unknown>
  parentEpisodeId: string | null
  createdAt: number
}

export interface MemoryView {
  id: string
  name: string
  description: string | null
  rolePattern: string
  filters: ViewFilter
  priority: number
  createdAt: number
}

export interface ViewFilter {
  allowedTypes: string[] | '*'
  maxAbstractionLevel: number
  counterpartyFilter: 'none' | 'bound'
  timeWindow: { since?: number; until?: number } | null
  tagFilter: string[] | null
}

export interface WorkingMemoryEntry {
  id: string
  sessionId: string
  bubbleId: string
  tier: 'hot' | 'warm' | 'cold'
  priorityScore: number
  pinned: boolean
  loadedAt: number
  lastAccessed: number
  tokenCost: number
}

export interface TemporalBubbleLink extends BubbleLink {
  validFrom?: number
  validUntil?: number
  episodeId?: string
  metadata?: Record<string, unknown>
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
    codeTools: boolean
    selfEvolution: boolean
    markitdown: boolean
    eventSourcing: boolean
    temporalGraph: boolean
    memoryViews: boolean
    workingMemory: boolean
    cognitionOrientation: boolean
    cognitionEvaluator: boolean
    cognitionInternalization: boolean
    cognitionCascade: boolean
    cognitionGapTrigger: boolean
  }
}
