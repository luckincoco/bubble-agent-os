/**
 * Cognition module — Bubble's cognitive evolution layer.
 *
 * Three sub-modules:
 * 1. OrientationGraph — knowledge landscape awareness
 * 2. CausalEvaluator — impact assessment for new information
 * 3. InternalizationEngine — belief update with cascade and provenance
 */

export { OrientationGraph } from './orientation-graph.js'
export type { ConfidenceBand, OrientationNode, OrientationSnapshot, SearchGuidance } from './orientation-graph.js'

export { CausalEvaluator } from './causal-evaluator.js'
export type { ImpactType, BusinessDimension, Urgency, InformationDepth, EvaluationInput, CausalVerdict } from './causal-evaluator.js'

export { InternalizationEngine } from './internalization.js'
export type { ActionType, InternalizationAction, EvolutionRecord, CascadeResult, InternalizationProposal } from './internalization.js'

export { ConceptForge } from './concept-forge.js'
export type { CandidatePair, ForgedConcept } from './concept-forge.js'

export { ObsidianIngest } from './obsidian-ingest.js'
export type { IngestResult } from './obsidian-ingest.js'
