/**
 * Temporal module — public API for Bubble Agent OS temporal knowledge graph.
 */

export { createEpisode, getEpisodeById, queryEpisodes, getEpisodeThread, getRecentEpisodesByActor, countEpisodes, updateEpisodeSummary } from './episode-store.js'
export type { Episode, EpisodeType, EpisodeSource, CreateEpisodeInput, EpisodeQueryOptions } from './episode-store.js'

export { EntityExtractor } from './entity-extractor.js'
export type { ExtractedEntity, ExtractedRelation, ExtractedFact, ExtractionResult } from './entity-extractor.js'

export { createTemporalLink, invalidateLink, invalidateOutgoingLinks, getActiveLinks, getLinksAsOf, findContradiction, resolveContradiction } from './temporal-linker.js'
export type { TemporalLinkInput, TemporalLink } from './temporal-linker.js'

export { getBubblesAsOf, getNeighborsAsOf, getRelationTimeline, getInvalidatedBubbles, getTemporalStats } from './temporal-query.js'
export type { TemporalQueryOptions } from './temporal-query.js'
