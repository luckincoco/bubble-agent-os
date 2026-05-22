export interface SourceRef {
  refIndex: number
  id: string
  title: string
  type: string
  tags: string[]
  source: string
  snippet: string
}

export type AssertionType = 'fact' | 'judgment' | 'speculation' | 'reference'

export interface AssertionTag {
  id: string
  turnId: string
  textSnippet: string
  assertionType: AssertionType
  source: string
  verificationStatus: string
  confidence: number
  userCalibrated: boolean
}

export type CognitionLayer = 'observation' | 'reflection' | 'consolidation'

/** Phase 4: tool call execution info for sidebar visualization */
export interface ToolCallInfo {
  name: string
  status: 'success' | 'error'
  durationMs: number
  error?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  timestamp: number
  isStreaming?: boolean
  sources?: SourceRef[]
  turnId?: string
  assertions?: AssertionTag[]
  cognitionLayer?: CognitionLayer
  /** Phase 2: inline cognitive panel rendered by module */
  panel?: {
    moduleId: string
    component: string
    data: unknown
  }
  /** Phase 4: tool call records for this turn */
  toolCalls?: ToolCallInfo[]
  /** Phase 4: human-readable context summary for this turn */
  contextSummary?: string
  /** Handoff 1: user marked this message as inaccurate */
  markedInaccurate?: boolean
}

export interface WSMessage {
  type: 'start' | 'chunk' | 'done' | 'error'
  text?: string
  sources?: SourceRef[]
  turnId?: string
  /** Phase 2: cognition layer from backend */
  cognitionLayer?: CognitionLayer
  /** Phase 2: inline panel data from backend */
  panel?: {
    moduleId: string
    component: string
    data: unknown
  }
  /** Phase 4: tool call execution records for sidebar visualization */
  toolCalls?: ToolCallInfo[]
  /** Phase 4: human-readable summary of what the agent did */
  contextSummary?: string
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
  abstractionLevel?: number
  decayRate?: number
  summary?: string
  spaceId?: string
}

export interface UserPreferences {
  enabledModules?: string[]
  onboardingCompleted?: boolean
}

export interface AuthUserInfo {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'user'
  spaceIds: string[]
  spaces: SpaceInfo[]
  preferences?: UserPreferences
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

// ── Structured Business Types (进销存 v0.5 → v0.6 SaaS) ──────────

export type DocStatus = 'draft' | 'confirmed' | 'completed' | 'cancelled'

export interface DocLink {
  id: string
  sourceType: string
  sourceId: string
  targetType: string
  targetId: string
  createdAt: number
}

export interface BizProduct {
  id: string
  tenantId: string
  code: string
  brand: string
  name: string
  spec: string
  specDisplay?: string
  category: string
  measureType: string
  weightPerBundle?: number
  piecesPerBundle?: number
  liftingFee?: number
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface BizCounterparty {
  id: string
  tenantId: string
  name: string
  type: 'supplier' | 'customer' | 'logistics' | 'both'
  contact?: string
  phone?: string
  address?: string
  bankInfo?: string
  taxId?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface BizProject {
  id: string
  tenantId: string
  name: string
  customerId?: string
  contractNo?: string
  address?: string
  builder?: string
  developer?: string
  contact?: string
  phone?: string
  status: 'active' | 'completed' | 'suspended'
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface BizPurchase {
  id: string
  tenantId: string
  date: string
  orderNo?: string
  supplierId: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  projectId?: string
  invoiceStatus: string
  paymentStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  docStatus: DocStatus
  sourceType?: string
  sourceId?: string
  cancelReason?: string
  amendedFrom?: string
  tradeId?: string
  settlementMethod?: string
  creditTermDays?: number
  dueDate?: string
  createdAt: number
  updatedAt: number
}

export interface BizSale {
  id: string
  tenantId: string
  date: string
  orderNo?: string
  customerId: string
  supplierId?: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  costPrice?: number
  costAmount?: number
  profit?: number
  projectId?: string
  logisticsProvider?: string
  invoiceStatus: string
  collectionStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  docStatus: DocStatus
  sourceType?: string
  sourceId?: string
  cancelReason?: string
  amendedFrom?: string
  tradeId?: string
  settlementMethod?: string
  creditTermDays?: number
  dueDate?: string
  createdAt: number
  updatedAt: number
}

/** Trade entity — parent record for cascaded trades (v1.0.2) */
export type SettlementMethod = 'cash' | 'transfer' | 'credit'

export interface BizTrade {
  id: string
  tenantId: string
  spaceId?: string
  tradeType: 'purchase' | 'sale'
  date: string
  docNo?: string
  counterpartyId: string
  contact?: string
  phone?: string
  settlementMethod: SettlementMethod
  creditTermDays?: number
  dueDate?: string
  totalAmount: number
  totalTonnage: number
  projectId?: string
  location?: string
  logisticsCarrier?: string
  logisticsFreight?: number
  logisticsLiftingFee?: number
  logisticsDestination?: string
  notes?: string
  docStatus: DocStatus
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

export interface BizLogisticsRecord {
  id: string
  tenantId: string
  date: string
  waybillNo?: string
  carrierId?: string
  projectId?: string
  destination?: string
  tonnage?: number
  freight: number
  liftingFee: number
  totalFee: number
  driver?: string
  driverPhone?: string
  licensePlate?: string
  settlementStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  docStatus: DocStatus
  sourceType?: string
  sourceId?: string
  cancelReason?: string
  amendedFrom?: string
  createdAt: number
  updatedAt: number
}

export interface BizPayment {
  id: string
  tenantId: string
  date: string
  docNo?: string
  direction: 'in' | 'out'
  counterpartyId: string
  projectId?: string
  amount: number
  method?: string
  referenceNo?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  docStatus: DocStatus
  sourceType?: string
  sourceId?: string
  cancelReason?: string
  amendedFrom?: string
  createdAt: number
  updatedAt: number
}

export interface InventoryItem {
  productId: string
  code: string
  brand: string
  name: string
  spec: string
  purchaseTons: number
  salesTons: number
  stockTons: number
}

export interface ReceivableItem {
  customerId: string
  name: string
  totalSales: number
  received: number
  outstanding: number
}

export interface PayableItem {
  supplierId: string
  name: string
  totalPurchases: number
  paid: number
  outstanding: number
}

export interface BizDashboardData {
  todayPurchases: number
  todaySales: number
  todayLogistics: number
  totalStockTons: number
  totalReceivable: number
  totalPayable: number
  recentTransactions: Array<{
    type: string
    date: string
    counterparty: string
    product?: string
    amount: number
  }>
}

export interface ProjectReconciliationItem {
  projectId: string
  projectName: string
  status: string
  totalSales: number
  totalLogistics: number
  totalPaymentsIn: number
  totalPaymentsOut: number
  outstanding: number
}

export interface BizInvoice {
  id: string
  tenantId: string
  date: string
  direction: 'in' | 'out'
  invoiceNo?: string
  counterpartyId: string
  amount: number
  taxRate: number
  taxAmount?: number
  totalAmount?: number
  relatedIds: string[]
  status: string
  notes?: string
  bubbleId?: string
  createdBy?: string
  docStatus: DocStatus
  sourceType?: string
  sourceId?: string
  cancelReason?: string
  amendedFrom?: string
  createdAt: number
  updatedAt: number
}

// ── Report types (v0.6 SaaS) ─────────────────────────────────────

export interface ProfitReportRow {
  month: string
  salesRevenue: number
  purchaseCost: number
  logisticsCost: number
  grossProfit: number
  margin: number
  salesTons: number
  purchaseTons: number
}

export interface CounterpartyStatementRow {
  date: string
  type: 'purchase' | 'sale' | 'payment_in' | 'payment_out' | 'invoice_in' | 'invoice_out'
  description: string
  debit: number
  credit: number
  balance: number
  docId: string
}

export interface CounterpartyStatementResult {
  counterpartyId: string
  counterpartyName: string
  counterpartyType: string
  rows: CounterpartyStatementRow[]
  totalDebit: number
  totalCredit: number
  closingBalance: number
}

export interface MonthlyOverviewRow {
  month: string
  purchaseAmount: number
  purchaseTons: number
  salesAmount: number
  salesTons: number
  logisticsAmount: number
  paymentsIn: number
  paymentsOut: number
  invoicesIn: number
  invoicesOut: number
}

// ── Agent UI Architecture Types (Phase 1) ─────────────────────────

/** Tool descriptor — what tools are available to the Agent */
export interface ToolDescriptor {
  id: string
  name: string
  description: string
  inputSchema?: Record<string, unknown>
}

/** Agent's current cognitive state — visualized in sidebar */
export interface AgentState {
  cognitionLayer: CognitionLayer
  thinkingChain: string | null
  activeMemories: BubbleMemory[]
  availableTools: ToolDescriptor[]
  activeContext: {
    spaceId: string
    entities: string[]
    recentTopics: string[]
  }
  /** Cognitive evolution trace (reserved, Phase 2+ drives UI) */
  cognitionTrace?: CognitionEvent[]
}

/** Single event in the cognitive trace timeline */
export interface CognitionEvent {
  id: string
  timestamp: number
  layer: CognitionLayer
  bubbleId?: string
  summary: string
  durationMs?: number
}

// ── Knowledge Browser Types ───────────────────────────────────────

export interface KnowledgeStats {
  total: number
  byType: Record<string, number>
  bySource: Record<string, number>
  byLevel: Record<string, number>
  recentWeek: number
  totalLinks: number
}

export interface KnowledgeFilters {
  types?: string[]
  sources?: string[]
  levels?: number[]
  tags?: string[]
  minConfidence?: number
  since?: number
  sortBy?: 'updated' | 'created' | 'confidence'
  sortDir?: 'asc' | 'desc'
}

export interface KnowledgeIndexResult {
  items: BubbleMemory[]
  total: number
  page: number
  pageSize: number
}

export interface BubbleLink {
  targetId: string
  relation: string
  weight: number
  source: string
  createdAt: number
}

export interface EvidenceNode {
  bubble: BubbleMemory
  relation: string
  depth: number
  children: EvidenceNode[]
}

export interface EvidenceTree {
  root: BubbleMemory
  nodes: EvidenceNode[]
  totalCount: number
  oldestEvidence: number
  newestEvidence: number
  sourceBreakdown: Record<string, number>
}

export interface GraphSubset {
  center: BubbleMemory | null
  nodes: BubbleMemory[]
  links: Array<{ sourceId: string; targetId: string; relation: string; weight: number }>
}