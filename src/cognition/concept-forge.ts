/**
 * Concept Forge — cross-space structural isomorphism detection.
 *
 * Detects when the same topological structure appears across different domains
 * (or within a single space across different time windows), names the pattern,
 * and submits it for human validation.
 *
 * Design principles:
 * - Pre-filter with numeric scoring (0 LLM cost)
 * - Single LLM call for structural mapping only on high-scoring pairs
 * - Token budget: <5k tokens/day total
 * - Output: synthesis bubble at abstractionLevel=2
 */

import type { LLMProvider, LLMMessage, Bubble, BubbleType } from '../shared/types.js'
import { findBubblesByType } from '../bubble/model.js'
import { createBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { EventBus } from '../event/event-bus.js'
import type { OrientationGraph, OrientationSnapshot, OrientationNode } from './orientation-graph.js'
import type { InternalizationEngine } from './internalization.js'

// ── Types ───────────────────────────────────────────────────────

export interface CandidatePair {
  nodeA: OrientationNode
  nodeB: OrientationNode
  preScore: number
  components: {
    trendAlignment: number
    temporalCooccurrence: number
    evidenceShapeSim: number
    bandCompatibility: number
  }
}

export interface ForgedConcept {
  name: string
  description: string
  structureType: 'isomorphism' | 'duality' | 'analogy'
  sourceNodes: [string, string]
  confidence: number
  bubbleId?: string
}

// ── Constants ───────────────────────────────────────────────────

const PRE_FILTER_THRESHOLD = 0.55

const WEIGHTS = {
  trendAlignment: 0.40,
  temporalCooccurrence: 0.25,
  evidenceShapeSim: 0.20,
  bandCompatibility: 0.15,
} as const

const MAX_PAIRS_PER_RUN = 3  // max LLM calls per daily run
const MAX_CONCEPTS_PER_RUN = 2

const STRUCTURAL_MAPPING_PROMPT = `你是一个跨领域结构分析师。给定两个来自不同认知领域的观察，检测它们之间是否存在结构同构、对偶或类比关系。

结构同构：两者虽然领域不同，但变化模式/因果结构/拓扑形状相同。
对偶关系：两者互为镜像——一个增强时另一个削弱，或者它们是同一深层现象在不同维度的投影。
类比关系：两者可以用相同的抽象模型描述，但映射需要非平凡的转换。

观察A [{domainA}]:
标题: {titleA}
内容: {contentA}
置信度: {confA}, 趋势: {trendA}

观察B [{domainB}]:
标题: {titleB}
内容: {contentB}
置信度: {confB}, 趋势: {trendB}

如果检测到结构关系，输出严格JSON（不要代码块包裹）：
{"found":true,"type":"isomorphism|duality|analogy","name":"用4-8个字命名这个抽象概念","description":"一句话描述发现的结构关系","confidence":0.0-1.0}

如果没有发现有意义的结构关系：
{"found":false}`

// ── Concept Forge Class ─────────────────────────────────────────

export class ConceptForge {
  private llm: LLMProvider
  private orientationGraph: OrientationGraph
  private eventBus: EventBus | null = null
  private internalizationEngine: InternalizationEngine | null = null

  constructor(llm: LLMProvider, orientationGraph: OrientationGraph) {
    this.llm = llm
    this.orientationGraph = orientationGraph
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus
  }

  setInternalizationEngine(engine: InternalizationEngine): void {
    this.internalizationEngine = engine
  }

  /**
   * Main entry point — run the concept forge cycle.
   * Called daily after orientation_snapshot completes.
   */
  async forge(): Promise<ForgedConcept[]> {
    const snapshot = this.orientationGraph.getSnapshot()
    if (!snapshot || snapshot.nodes.length < 4) {
      logger.debug('ConceptForge: insufficient nodes for cross-domain analysis')
      return []
    }

    // Step 1: Generate candidate pairs with pre-filter (0 LLM cost)
    const candidates = this.generateCandidates(snapshot)
    if (candidates.length === 0) {
      logger.info('ConceptForge: no candidate pairs passed pre-filter')
      return []
    }

    // Step 2: LLM structural mapping on top candidates
    const topCandidates = candidates.slice(0, MAX_PAIRS_PER_RUN)
    const forged: ForgedConcept[] = []

    for (const pair of topCandidates) {
      if (forged.length >= MAX_CONCEPTS_PER_RUN) break

      try {
        const concept = await this.detectStructure(pair, snapshot)
        if (concept) {
          forged.push(concept)
        }
      } catch (err) {
        logger.debug(`ConceptForge: structural mapping failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Step 3: Materialize concepts based on confidence
    for (const concept of forged) {
      await this.materialize(concept, snapshot.spaceId)
    }

    logger.info(`ConceptForge: forged ${forged.length} concepts from ${candidates.length} candidates`)
    return forged
  }

  // ── Pre-filter: numeric scoring ─────────────────────────────────

  private generateCandidates(snapshot: OrientationSnapshot): CandidatePair[] {
    const nodes = snapshot.nodes
    const candidates: CandidatePair[] = []

    // Compare nodes from different domains
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]

        // Skip same-domain pairs — we want cross-domain detection
        if (a.domain === b.domain) continue

        const components = this.computePreScore(a, b, snapshot)
        const preScore =
          WEIGHTS.trendAlignment * components.trendAlignment +
          WEIGHTS.temporalCooccurrence * components.temporalCooccurrence +
          WEIGHTS.evidenceShapeSim * components.evidenceShapeSim +
          WEIGHTS.bandCompatibility * components.bandCompatibility

        if (preScore >= PRE_FILTER_THRESHOLD) {
          candidates.push({ nodeA: a, nodeB: b, preScore, components })
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.preScore - a.preScore)

    // Deduplicate: skip pairs that share existing 'abstracted_from' links
    return this.deduplicateAgainstExisting(candidates)
  }

  private computePreScore(
    a: OrientationNode,
    b: OrientationNode,
    snapshot: OrientationSnapshot,
  ): CandidatePair['components'] {
    // 1. Trend alignment: do they evolve in similar or mirror directions?
    const trendAlignment = this.computeTrendAlignment(a, b)

    // 2. Temporal co-occurrence: were they updated around the same time?
    const temporalCooccurrence = this.computeTemporalCooccurrence(a, b)

    // 3. Evidence shape similarity: similar graph structure (deps/contradictions)?
    const evidenceShapeSim = this.computeEvidenceShapeSim(a, b, snapshot)

    // 4. Band compatibility: similar confidence level suggests parallel development
    const bandCompatibility = this.computeBandCompatibility(a, b)

    return { trendAlignment, temporalCooccurrence, evidenceShapeSim, bandCompatibility }
  }

  private computeTrendAlignment(a: OrientationNode, b: OrientationNode): number {
    const db = getDatabase()
    const getConf = (id: string) => {
      const row = db.prepare('SELECT confidence FROM bubbles WHERE id = ? AND deleted_at IS NULL').get(id) as { confidence: number } | undefined
      return row?.confidence ?? 0.5
    }

    const confA = getConf(a.observationId)
    const confB = getConf(b.observationId)

    // Similar confidence movement suggests similar underlying forces
    const diff = Math.abs(confA - confB)
    return 1 - diff  // closer confidence = higher alignment
  }

  private computeTemporalCooccurrence(a: OrientationNode, b: OrientationNode): number {
    // Similar freshness suggests they were reinforced around the same time
    const freshnessGap = Math.abs(a.freshness - b.freshness)
    if (freshnessGap <= 2) return 1.0
    if (freshnessGap <= 7) return 0.7
    if (freshnessGap <= 14) return 0.4
    return 0.1
  }

  private computeEvidenceShapeSim(
    a: OrientationNode,
    b: OrientationNode,
    _snapshot: OrientationSnapshot,
  ): number {
    // Compare graph topology: similar number of dependencies and contradictions
    const depsA = a.dependsOn.length
    const depsB = b.dependsOn.length
    const conA = a.contradicts.length
    const conB = b.contradicts.length

    const depSim = 1 - Math.abs(depsA - depsB) / Math.max(depsA + depsB, 1)
    const conSim = 1 - Math.abs(conA - conB) / Math.max(conA + conB, 1)

    // Also: both having contradictions suggests they're in tension-rich areas
    const tensionBonus = (conA > 0 && conB > 0) ? 0.2 : 0

    return Math.min(1, (depSim + conSim) / 2 + tensionBonus)
  }

  private computeBandCompatibility(a: OrientationNode, b: OrientationNode): number {
    const bandOrder: Record<string, number> = { frontier: 0, exploring: 1, grounded: 2, established: 3 }
    const diff = Math.abs((bandOrder[a.band] ?? 0) - (bandOrder[b.band] ?? 0))
    if (diff === 0) return 1.0
    if (diff === 1) return 0.7
    return 0.3
  }

  // ── LLM structural mapping ─────────────────────────────────────

  private async detectStructure(
    pair: CandidatePair,
    snapshot: OrientationSnapshot,
  ): Promise<ForgedConcept | null> {
    const db = getDatabase()

    const getBubble = (id: string) =>
      db.prepare('SELECT id, title, content, confidence, metadata FROM bubbles WHERE id = ? AND deleted_at IS NULL')
        .get(id) as { id: string; title: string; content: string; confidence: number; metadata: string } | undefined

    const bubbleA = getBubble(pair.nodeA.observationId)
    const bubbleB = getBubble(pair.nodeB.observationId)

    if (!bubbleA || !bubbleB) return null

    // Parse metadata for trend info
    const metaA = JSON.parse(bubbleA.metadata || '{}')
    const metaB = JSON.parse(bubbleB.metadata || '{}')

    const prompt = STRUCTURAL_MAPPING_PROMPT
      .replace('{domainA}', pair.nodeA.domain)
      .replace('{titleA}', bubbleA.title)
      .replace('{contentA}', bubbleA.content.slice(0, 300))
      .replace('{confA}', bubbleA.confidence.toFixed(2))
      .replace('{trendA}', metaA.trend || 'stable')
      .replace('{domainB}', pair.nodeB.domain)
      .replace('{titleB}', bubbleB.title)
      .replace('{contentB}', bubbleB.content.slice(0, 300))
      .replace('{confB}', bubbleB.confidence.toFixed(2))
      .replace('{trendB}', metaB.trend || 'stable')

    const response = await this.llm.chat([{ role: 'system', content: prompt }])
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return null

    const result = JSON.parse(jsonMatch[0]) as {
      found: boolean
      type?: 'isomorphism' | 'duality' | 'analogy'
      name?: string
      description?: string
      confidence?: number
    }

    if (!result.found || !result.name || !result.type) return null

    return {
      name: result.name,
      description: result.description || '',
      structureType: result.type,
      sourceNodes: [pair.nodeA.observationId, pair.nodeB.observationId],
      confidence: result.confidence ?? 0.5,
    }
  }

  // ── Materialization ────────────────────────────────────────────

  private async materialize(concept: ForgedConcept, spaceId: string): Promise<void> {
    if (concept.confidence > 0.85) {
      // Auto-create: high confidence, direct materialization
      concept.bubbleId = this.createConceptBubble(concept, spaceId)
      logger.info(`ConceptForge: auto-created concept "${concept.name}" (conf: ${concept.confidence.toFixed(2)})`)
    } else if (concept.confidence >= 0.5) {
      // Medium confidence: queue for human approval
      concept.bubbleId = this.createConceptBubble(concept, spaceId, true)
      logger.info(`ConceptForge: queued concept "${concept.name}" for approval (conf: ${concept.confidence.toFixed(2)})`)
    } else {
      // Low confidence: discard silently
      logger.debug(`ConceptForge: discarded low-confidence concept "${concept.name}" (conf: ${concept.confidence.toFixed(2)})`)
      return
    }

    // Emit event
    if (this.eventBus) {
      this.eventBus.emitFireAndForget(
        {
          type: 'knowledge.concept.forged',
          payload: {
            conceptId: concept.bubbleId!,
            name: concept.name,
            structureType: concept.structureType,
            sourceNodes: concept.sourceNodes,
            confidence: concept.confidence,
            autoApproved: concept.confidence > 0.85,
          },
        },
        { actor: 'system', spaceId },
      )
    }
  }

  private createConceptBubble(concept: ForgedConcept, spaceId: string, pendingApproval = false): string {
    const content = [
      `## ${concept.name}`,
      '',
      `**结构类型**: ${concept.structureType}`,
      `**描述**: ${concept.description}`,
      `**置信度**: ${concept.confidence.toFixed(2)}`,
      '',
      `发现于 ${concept.sourceNodes[0]} 和 ${concept.sourceNodes[1]} 之间的跨领域结构映射。`,
    ].join('\n')

    const bubble = createBubble({
      type: 'synthesis' as BubbleType,
      title: `概念: ${concept.name}`,
      content,
      tags: ['concept', 'cross-domain', concept.structureType, 'auto-forged'],
      source: 'concept-forge',
      confidence: concept.confidence,
      decayRate: 0.02,  // slow decay for concepts
      spaceId,
      abstractionLevel: 2,
      metadata: {
        forgeType: 'structural-isomorphism',
        structureType: concept.structureType,
        sourceNodes: concept.sourceNodes,
        pendingApproval,
        forgedAt: Date.now(),
      },
    })

    // Create 'abstracted_from' links to source observations
    for (const sourceId of concept.sourceNodes) {
      addLink(bubble.id, sourceId, 'abstracted_from', concept.confidence, 'concept-forge')
    }

    return bubble.id
  }

  // ── Deduplication ──────────────────────────────────────────────

  private deduplicateAgainstExisting(candidates: CandidatePair[]): CandidatePair[] {
    const db = getDatabase()

    // Find existing concept bubbles
    const existing = db.prepare(
      `SELECT metadata FROM bubbles
       WHERE type = 'synthesis' AND json_extract(metadata, '$.forgeType') = 'structural-isomorphism'
       AND deleted_at IS NULL`,
    ).all() as Array<{ metadata: string }>

    const existingPairs = new Set<string>()
    for (const row of existing) {
      try {
        const meta = JSON.parse(row.metadata)
        if (meta.sourceNodes?.length === 2) {
          const key = [meta.sourceNodes[0], meta.sourceNodes[1]].sort().join('|')
          existingPairs.add(key)
        }
      } catch { /* skip */ }
    }

    return candidates.filter(c => {
      const key = [c.nodeA.observationId, c.nodeB.observationId].sort().join('|')
      return !existingPairs.has(key)
    })
  }
}
