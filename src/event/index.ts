/**
 * Event module — public API for Bubble Agent OS event sourcing.
 */

export { EventBus } from './event-bus.js'
export type { EmitOptions } from './event-bus.js'
export { EventStore } from './event-store.js'
export type { AppendEventInput } from './event-store.js'
export { Materializer } from './materializer.js'
export type { MaterializeHandler } from './materializer.js'
export type {
  BubbleEventData,
  EventType,
  StoredEvent,
  EventMetadata,
  BizPurchaseCreated,
  BizSaleCreated,
  BizPaymentRecorded,
  BizLogisticsCreated,
  MemoryBubbleCreated,
  MemoryBubbleInvalidated,
  MemoryCompactionCompleted,
  KnowledgeTensionDetected,
  ActionStepCompleted,
  ActionPlanFinished,
  ConversationEpisodeCreated,
  ConversationResponseSent,
  SystemGenesisEvent,
} from './event-types.js'
