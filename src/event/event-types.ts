/**
 * Event Types — discriminated union for all Bubble Agent OS events.
 * Follows hierarchical naming: domain.entity.action
 */

// ── Business Events ─────────────────────────────────────────────

export interface BizPurchaseCreated {
  type: 'biz.purchase.created'
  payload: { purchaseId: string; supplierId: string; productId: string; tonnage: number; unitPrice: number; totalAmount: number }
}

export interface BizSaleCreated {
  type: 'biz.sale.created'
  payload: { saleId: string; customerId: string; productId: string; tonnage: number; unitPrice: number; totalAmount: number }
}

export interface BizPaymentRecorded {
  type: 'biz.payment.recorded'
  payload: { paymentId: string; counterpartyId: string; amount: number; direction: 'in' | 'out'; method: string }
}

export interface BizLogisticsCreated {
  type: 'biz.logistics.created'
  payload: { logisticsId: string; carrierId: string; tonnage: number; freight: number; waybillNo?: string }
}

export interface BizInvoiceCreated {
  type: 'biz.invoice.created'
  payload: { invoiceId: string; counterpartyId: string; direction: 'in' | 'out'; amount: number }
}

export interface BizCounterpartyCreated {
  type: 'biz.counterparty.created'
  payload: { counterpartyId: string; name: string; counterpartyType: string }
}

export interface BizProductCreated {
  type: 'biz.product.created'
  payload: { productId: string; code: string; brand: string; spec: string; category: string }
}

// ── Memory Events ───────────────────────────────────────────────

export interface MemoryBubbleCreated {
  type: 'memory.bubble.created'
  payload: { bubbleId: string; bubbleType: string; source: string; title: string }
}

export interface MemoryBubbleInvalidated {
  type: 'memory.bubble.invalidated'
  payload: { bubbleId: string; reason: string; validUntil: number }
}

export interface MemoryCompactionCompleted {
  type: 'memory.compaction.completed'
  payload: { synthesisId: string; sourceIds: string[]; level: number; clusterId: string }
}

export interface MemoryObservationDiscovered {
  type: 'memory.observation.discovered'
  payload: { observationId: string; title: string; evidenceCount: number }
}

export interface MemoryObservationValidated {
  type: 'memory.observation.validated'
  payload: { observationId: string; trend: string; newEvidenceCount: number }
}

export interface MemoryDecayApplied {
  type: 'memory.decay.applied'
  payload: { affectedCount: number; deletedCount: number }
}

export interface MemoryLinkInvalidated {
  type: 'memory.link.invalidated'
  payload: { sourceId: string; targetId: string; relation: string; reason: string; validUntil: number }
}

// ── Knowledge / Cognition Events ────────────────────────────────

export interface KnowledgeObservationStrengthened {
  type: 'knowledge.observation.strengthened'
  payload: { observationId: string; newConfidence: number; evidenceBubbleId: string }
}

export interface KnowledgeObservationWeakened {
  type: 'knowledge.observation.weakened'
  payload: { observationId: string; newConfidence: number; contradictionBubbleId: string }
}

export interface KnowledgeObservationKilled {
  type: 'knowledge.observation.killed'
  payload: { observationId: string; killedBy: string; reason: string }
}

export interface KnowledgeGapDetected {
  type: 'knowledge.gap.detected'
  payload: { domain: string; suggestedQueries: string[]; priority: number }
}

export interface KnowledgeCascadeTriggered {
  type: 'knowledge.cascade.triggered'
  payload: { primaryId: string; cascadedIds: string[]; depth: number }
}

export interface KnowledgeSnapshotBuilt {
  type: 'knowledge.snapshot.built'
  payload: { spaceId: string; nodeCount: number; frontierCount: number; tensionCount: number }
}

// ── Conversation Events ─────────────────────────────────────────

export interface ConversationEpisodeCreated {
  type: 'conversation.episode.created'
  payload: { episodeId: string; episodeType: string; source: string; actorId: string }
}

export interface ConversationResponseSent {
  type: 'conversation.response.sent'
  payload: { episodeId: string; toolsUsed: string[]; tokenUsage?: number }
}

export interface ConversationExternalMessage {
  type: 'conversation.external.message'
  payload: { episodeId: string; platform: string; counterpartyId: string; actorId: string }
}

// ── System Events ───────────────────────────────────────────────

export interface SystemSchedulerTaskCompleted {
  type: 'system.scheduler.task_completed'
  payload: { taskName: string; duration: number; result?: string }
}

export interface SystemGenesisEvent {
  type: 'system.genesis'
  payload: { version: string; timestamp: number }
}

// ── Union Type ──────────────────────────────────────────────────

export type BubbleEventData =
  | BizPurchaseCreated
  | BizSaleCreated
  | BizPaymentRecorded
  | BizLogisticsCreated
  | BizInvoiceCreated
  | BizCounterpartyCreated
  | BizProductCreated
  | MemoryBubbleCreated
  | MemoryBubbleInvalidated
  | MemoryCompactionCompleted
  | MemoryObservationDiscovered
  | MemoryObservationValidated
  | MemoryDecayApplied
  | MemoryLinkInvalidated
  | KnowledgeObservationStrengthened
  | KnowledgeObservationWeakened
  | KnowledgeObservationKilled
  | KnowledgeGapDetected
  | KnowledgeCascadeTriggered
  | KnowledgeSnapshotBuilt
  | ConversationEpisodeCreated
  | ConversationResponseSent
  | ConversationExternalMessage
  | SystemSchedulerTaskCompleted
  | SystemGenesisEvent

export type EventType = BubbleEventData['type']

// ── Stored Event (persisted to events table) ────────────────────

export interface StoredEvent {
  id: string
  type: EventType
  timestamp: number
  actor: string
  spaceId: string | null
  payload: string  // JSON-serialized payload
  metadata: string // JSON: { correlationId?, causationId? }
  hash: string
  prevHash: string | null
  version: number
}

// ── Event Metadata ──────────────────────────────────────────────

export interface EventMetadata {
  correlationId?: string  // groups related events (e.g. same user action)
  causationId?: string    // the event that caused this event
  episodeId?: string      // link back to episode
}
