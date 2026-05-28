// Bubble types
export type BubbleType = 'memory' | 'entity' | 'api' | 'workflow' | 'document' | 'event' | 'synthesis' | 'portrait' | 'question' | 'observation'

/**
 * EpistemicStatus — 置信度的"质"的层级，而非"量"的数值。
 * MemForge-inspired: graduation from provisional to established protects graduated memories.
 *
 * provisional  → 刚创建，未经充分验证。检索 ≥3 次 + 置信度 ≥0.9 + 存在 ≥24h 后毕业
 * established  → 已毕业，受驱逐保护，衰减率减半
 * contested    → 被矛盾证据挑战，但并不一定错误
 * deprecated   → 被明确推翻或过时，检索时降权
 * inferred     → 由系统推理产生（非直接来自用户/工具）
 */
export type EpistemicStatus = 'provisional' | 'established' | 'contested' | 'deprecated' | 'inferred'

// Cognition layer — maps to Agent's cognitive state for UI rendering
export type CognitionLayer = 'observation' | 'reflection' | 'consolidation' | 'resonance'

// Causal edge types — semantic meaning of BubbleLink.relation when set by causal-evaluator
export type CausalRelation = 'supports' | 'contradicts' | 'extends' | 'neutral'

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
  /** @clude-inspired epistemic status hierarchy */
  epistemicStatus?: EpistemicStatus
  /** How many times this bubble has been successfully retrieved (for graduation) */
  retrievalSuccessCount?: number
  /** Timestamp when this bubble graduated from provisional to established */
  graduatedAt?: number
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

/** Phase 4: tool call info for sidebar visualization */
export interface ToolCallInfo {
  name: string
  status: 'success' | 'error'
  durationMs: number
  error?: string
}

/**
 * SelfState – 跨 session 的自我状态持久化。
 * 不是"系统状态日志"，而是 Bubble 对"我正在想什么"的自我感知。
 * 每次 brain.think() 完成后自然填充，bubble 自身的"我"。
 *
 * 扩展自 Handoff 1 讨论 + 后续多轮架构共识：
 * - unresolvedTensions: 未被消化的认知矛盾，证据对向
 * - failedHypotheses: 被推翻的假设记录
 * - surpriseLog: 出乎意料的观察（惊讶是最强的学习信号）
 * - confidenceGradient: 各认知域的置信度变化趋势
 * - recentTransitions: 自我状态的演化轨迹（时间即叙事）
 */
export interface Tension {
  concepts: [string, string]
  evidenceRatio: number
  lastReevaluated: number
  resolutionStatus: 'open' | 'resolved' | 'abandoned'
  label?: string
}

export interface FailedHypothesis {
  hypothesis: string
  contradictedBy: string
  contradictedAt: number
  confidence: number
}

export interface SurpriseEntry {
  expected: string
  actual: string
  resolved: boolean
  timestamp: number
}

export interface ConfidenceGradient {
  domain: string
  direction: 'rising' | 'stable' | 'declining'
  strength: number
}

export interface SelfStateTransition {
  from: string
  to: string
  trigger: string
  timestamp: number
}

export interface SelfState {
  userId: string
  sessionId: string
  unresolvedTensions: Tension[]
  failedHypotheses: FailedHypothesis[]
  surpriseLog: SurpriseEntry[]
  confidenceGradient: ConfidenceGradient[]
  recentTransitions: SelfStateTransition[]
  lastActiveAt: number
}

export interface ThinkResult {
  response: string
  sources: SourceRef[]
  turnId?: string
  /** Phase 2: cognitive layer classification for UI rendering */
  cognitionLayer?: CognitionLayer
  /** Phase 2: structured panel data for inline cognitive panels */
  panel?: {
    moduleId: string
    component: string
    data: unknown
  }
  /** Phase 4: tool call execution records for sidebar visualization */
  toolCalls?: ToolCallInfo[]
  /** Phase 4: human-readable summary of what the agent did */
  contextSummary?: string
  /** Phase 5 (v2): value propositions — meaningful connections to user context */
  propositions?: ValueProposition[]
  /** Phase 5: detected data gaps */
  dataGaps?: DataGap[]
  /** Phase 5: number of value propositions generated */
  propositionCount?: number
}

// ── Phase 5: Data Valuation & Value Network ────────────────────
// v1 (deprecated): DataValuation — monetary valuation per [DATA] block.
// v2: ValueProposition — human-readable connection between data and user context.

export interface DataValuationFactors {
  freshness: number
  completeness: number
  queryRelevance: number
  businessImpact: number
  acquisitionCost: number
}

/** @deprecated Use ValueProposition instead. */
export interface DataValuation {
  toolName: string
  computedAt: number
  estimatedValue: number
  confidence: number
  factors: DataValuationFactors
  label: 'critical' | 'significant' | 'informational' | 'negligible'
}

/**
 * ValueProposition — replaces monetary DataValuation with meaningful
 * connections between information and the user's specific context.
 *
 * Instead of "¥0.87", shows "与你库存 50 吨相关的螺纹钢价格变动".
 */
export interface ValueProposition {
  /** Short headline: e.g. "螺纹钢 HRB400E ¥3,420/吨" */
  label: string
  /** Why it matters to this user: e.g. "与你库存 50 吨相关" */
  relevance: string
  /** Optional impact statement: e.g. "库存价值变动 ¥1,000" */
  impact?: string
  /** Source description: e.g. "库存查询" */
  source: string
  /** Confidence [0, 1] */
  confidence: number
}

export interface DataGap {
  missingField: string
  estimatedCost: number
  confidence: number
  suggestion: string
}

// Assertion self-identification types
export type AssertionType = 'fact' | 'judgment' | 'speculation' | 'reference'
export type AssertionSource = 'user_statement' | 'tool_result' | 'self_inference' | 'external_source'
export type VerificationStatus = 'pending' | 'verified' | 'unverifiable'

export interface AssertionTag {
  id: string
  userId: string
  spaceId?: string
  turnId: string
  textSnippet: string
  assertionType: AssertionType
  source: AssertionSource
  verificationStatus: VerificationStatus
  confidence: number
  userCalibrated: boolean
  createdAt: number
  updatedAt: number
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

// ── Bubble Encoding & Difference Measurement (Handoff 汉语数学化) ──

/** A single semantic dimension for bubble encoding */
export interface SemanticDimension {
  id: string
  label: string
  description: string
}

/** A set of dimensions — user-configurable */
export type DimensionConfig = SemanticDimension[]

/** Dimension profile mapping dimension_id → value [0, 1] */
export interface DimensionProfile {
  dimensions: Record<string, number>
  confidence: Record<string, number>
  encodedAt: number
}

/** Signed difference between two bubbles' dimension profiles */
export interface BubbleDifference {
  bubbleIdA: string
  bubbleIdB: string
  perDimensionDelta: Record<string, number>
  magnitude: number
  dominantDimension: string
  dominantDelta: number
  interpretation: 'supports' | 'contradicts' | 'extends' | 'neutral'
  interpretationConfidence: number
  computedAt: number
}

// ── Math Abstraction Layer (P0) — 自然语言 → 结构化数学表达 ──────

/** A variable extracted from text with its domain */
export interface MathVariable {
  name: string
  label: string
  domain?: [number, number]
  unit?: string
}

/** A constraint/relationship between variables */
export interface MathConstraint {
  expression: string
  naturalLanguage: string
  type: 'inequality' | 'equality' | 'range' | 'proportion'
}

/** A conditional rule (if-then) extracted from text */
export interface MathConditional {
  condition: string
  action: string
}

/** A specific quantity mentioned in text */
export interface MathQuantity {
  variable: string
  value: number
  unit: string
}

/** Full abstraction result — the structured mathematical model of a text fragment */
export interface MathAbstraction {
  variables: MathVariable[]
  constraints: MathConstraint[]
  conditionals: MathConditional[]
  quantities: MathQuantity[]
  summary: string
  confidence: number
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
    taskLedger: boolean
    boundaryChecker: boolean
    resonanceLayer: boolean
    selfCalibration: boolean
    antiDuplication: boolean
    actionPlanner: boolean
    boundaryRuleSelfEvolution: boolean
    draftObservations: boolean
    assertionIdentification: boolean
    semanticNetwork: boolean
    bizStructuredData: boolean
    dataValuation: boolean
    dataGapDetection: boolean
    observability?: {
      enabled: boolean
      tracingLevel: 'off' | 'minimal' | 'full'
      metricsFlushIntervalMs?: number
      metricsBufferSize?: number
    }
  }
}
