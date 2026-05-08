/**
 * Cognitive Orientation Graph — Bubble's self-awareness of her knowledge landscape.
 *
 * Replaces the flat `domainWeight` scoring with a structured map:
 * - What domains are established (high confidence, rich evidence)?
 * - Where are the frontiers (low confidence, stale, or gaps)?
 * - What tensions exist (contradicting observations)?
 *
 * Key principle: this is a LENS on existing data (observations + links),
 * not a separate store. Uses bubble_links with cognitive relation types.
 */

import type { LLMProvider, LLMMessage, Bubble, BubbleType } from '../shared/types.js'
import { findBubblesByType, searchBubbles } from '../bubble/model.js'
import { findLinksByRelation, addLink } from '../bubble/links.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { EventBus } from '../event/event-bus.js'
import type { ObservationMetadata } from '../memory/reflector.js'

// ── Types ───────────────────────────────────────────────────────

export type ConfidenceBand = 'frontier' | 'exploring' | 'grounded' | 'established'

export interface OrientationNode {
  observationId: string
  domain: string
  band: ConfidenceBand
  gapScore: number
  freshness: number            // days since last evidence
  dependsOn: string[]
  contradicts: string[]
}

export interface OrientationSnapshot {
  spaceId: string
  builtAt: number
  nodes: OrientationNode[]
  frontiers: OrientationNode[]
  tensions: Array<{ a: string; b: string; reason: string }>
}

export interface SearchGuidance {
  frontiers: Array<{ domain: string; suggestedQuery: string }>
  tensions: Array<{ pair: [string, string]; counterQuery: string }>
  avoidDomains: string[]
}

// ── Constants ───────────────────────────────────────────────────

const SNAPSHOT_PROMPT = `你是认知图谱分析师。给定一组观察（observations），分析它们之间的认知关系。

任务：
1. 为每个观察推断所属领域（用2-4个字概括，如"钢价趋势"、"供应商可靠性"）
2. 识别存在张力/矛盾的观察对（两者不能同时完全成立）
3. 识别认知依赖（观察A的成立是否依赖观察B为真）

输入观察列表：
{observations}

输出严格 JSON（不要代码块包裹）：
{"domains":[{"id":"观察ID","domain":"领域名"}],"tensions":[{"a":"ID1","b":"ID2","reason":"矛盾原因"}],"dependencies":[{"from":"依赖方ID","to":"被依赖ID"}]}`

// ── Orientation Graph Class ─────────────────────────────────────

export class OrientationGraph {
  private snapshot: OrientationSnapshot | null = null
  private llm: LLMProvider
  private eventBus: EventBus | null = null

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  setEventBus(bus: EventBus): void {
    this.eventBus = bus
  }

  /**
   * Build a daily snapshot of the cognitive landscape.
   * One LLM call to classify domains + identify tensions.
   */
  async buildSnapshot(spaceId: string): Promise<OrientationSnapshot> {
    const observations = findBubblesByType('observation' as BubbleType, 50)
    const spaceObs = spaceId
      ? observations.filter(o => !o.spaceId || o.spaceId === spaceId)
      : observations

    if (spaceObs.length === 0) {
      const empty: OrientationSnapshot = { spaceId, builtAt: Date.now(), nodes: [], frontiers: [], tensions: [] }
      this.snapshot = empty
      return empty
    }

    // Build nodes with computed metrics
    const now = Date.now()
    const nodes: OrientationNode[] = spaceObs.map(obs => {
      const meta = obs.metadata as Partial<ObservationMetadata> | undefined
      const lastSeen = meta?.lastSeen ?? obs.updatedAt
      const freshness = Math.floor((now - lastSeen) / (24 * 60 * 60 * 1000))

      // Compute gap score: (1 - confidence) × staleness_factor
      const staleness = Math.min(freshness / 30, 1) // cap at 1 after 30 days
      const gapScore = (1 - obs.confidence) * (0.5 + 0.5 * staleness)

      // Get existing cognitive links
      const dependsOn = findLinksByRelation(obs.id, 'cognitively_depends_on')
        .map(l => l.targetId)
      const contradicts = findLinksByRelation(obs.id, 'cognitively_contradicts')
        .map(l => l.targetId)

      return {
        observationId: obs.id,
        domain: this.inferDomain(obs),
        band: this.classifyBand(obs.confidence),
        gapScore,
        freshness,
        dependsOn,
        contradicts,
      }
    })

    // LLM call: identify tensions and dependencies we haven't seen yet
    let tensions: Array<{ a: string; b: string; reason: string }> = []
    try {
      if (spaceObs.length >= 3) {
        const obsStr = spaceObs.slice(0, 20).map(o =>
          `[${o.id}] "${o.title}" (conf: ${o.confidence.toFixed(2)}, tags: ${o.tags.slice(0, 3).join(',')})`,
        ).join('\n')

        const response = await this.llm.chat([
          { role: 'system', content: SNAPSHOT_PROMPT.replace('{observations}', obsStr) },
        ])

        const jsonMatch = response.content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as {
            domains?: Array<{ id: string; domain: string }>
            tensions?: Array<{ a: string; b: string; reason: string }>
            dependencies?: Array<{ from: string; to: string }>
          }

          // Apply LLM-inferred domains
          if (parsed.domains) {
            for (const d of parsed.domains) {
              const node = nodes.find(n => n.observationId === d.id)
              if (node) node.domain = d.domain
            }
          }

          // Record tensions
          if (parsed.tensions) {
            tensions = parsed.tensions.filter(t =>
              nodes.some(n => n.observationId === t.a) &&
              nodes.some(n => n.observationId === t.b),
            )
            // Create cognitive links for discovered tensions
            for (const t of tensions) {
              this.ensureCognitiveLink(t.a, t.b, 'cognitively_contradicts')
            }
          }

          // Record dependencies
          if (parsed.dependencies) {
            for (const dep of parsed.dependencies) {
              if (nodes.some(n => n.observationId === dep.from) && nodes.some(n => n.observationId === dep.to)) {
                this.ensureCognitiveLink(dep.from, dep.to, 'cognitively_depends_on')
                const node = nodes.find(n => n.observationId === dep.from)
                if (node && !node.dependsOn.includes(dep.to)) {
                  node.dependsOn.push(dep.to)
                }
              }
            }
          }
        }
      }
    } catch (err) {
      logger.debug(`OrientationGraph: LLM analysis failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Update contradiction lists on nodes
    for (const t of tensions) {
      const nodeA = nodes.find(n => n.observationId === t.a)
      const nodeB = nodes.find(n => n.observationId === t.b)
      if (nodeA && !nodeA.contradicts.includes(t.b)) nodeA.contradicts.push(t.b)
      if (nodeB && !nodeB.contradicts.includes(t.a)) nodeB.contradicts.push(t.a)
    }

    // Sort frontiers by gapScore
    const frontiers = [...nodes]
      .sort((a, b) => b.gapScore - a.gapScore)
      .slice(0, 5)

    const snapshot: OrientationSnapshot = {
      spaceId,
      builtAt: now,
      nodes,
      frontiers,
      tensions,
    }

    this.snapshot = snapshot

    // Emit event
    if (this.eventBus) {
      this.eventBus.emitFireAndForget(
        { type: 'knowledge.snapshot.built', payload: { spaceId, nodeCount: nodes.length, frontierCount: frontiers.length, tensionCount: tensions.length } },
        { actor: 'system', spaceId },
      )
    }

    logger.info(`OrientationGraph: snapshot built — ${nodes.length} nodes, ${frontiers.length} frontiers, ${tensions.length} tensions`)
    return snapshot
  }

  /**
   * Provide search guidance to interest-search.
   * Zero LLM cost — pure computation from cached snapshot.
   */
  getGuidanceForSearch(spaceId: string): SearchGuidance {
    if (!this.snapshot || this.snapshot.spaceId !== spaceId) {
      return { frontiers: [], tensions: [], avoidDomains: [] }
    }

    const frontiers = this.snapshot.frontiers.slice(0, 3).map(f => ({
      domain: f.domain,
      suggestedQuery: `${f.domain} 最新进展 2026`,
    }))

    const tensions = this.snapshot.tensions.slice(0, 2).map(t => {
      const nodeA = this.snapshot!.nodes.find(n => n.observationId === t.a)
      const nodeB = this.snapshot!.nodes.find(n => n.observationId === t.b)
      return {
        pair: [nodeA?.domain || t.a, nodeB?.domain || t.b] as [string, string],
        counterQuery: `${nodeA?.domain || ''} vs ${nodeB?.domain || ''} 对比分析`,
      }
    })

    const avoidDomains = this.snapshot.nodes
      .filter(n => n.band === 'established' && n.freshness < 7)
      .map(n => n.domain)

    return { frontiers, tensions, avoidDomains }
  }

  /**
   * Register a new observation into the cognitive landscape.
   * Called when reflector discovers a new observation.
   * Zero LLM cost — uses tag similarity to find connections.
   */
  registerNewObservation(obsId: string): void {
    if (!this.snapshot) return

    const db = getDatabase()
    const row = db.prepare('SELECT id, title, tags, confidence FROM bubbles WHERE id = ?').get(obsId) as
      { id: string; title: string; tags: string; confidence: number } | undefined

    if (!row) return

    const newTags = new Set(row.tags ? JSON.parse(row.tags) as string[] : [])
    if (newTags.size === 0) return

    // Find potentially related observations by tag overlap
    for (const node of this.snapshot.nodes) {
      const existingBubble = db.prepare('SELECT tags FROM bubbles WHERE id = ?').get(node.observationId) as
        { tags: string } | undefined
      if (!existingBubble) continue

      const existingTags = new Set(existingBubble.tags ? JSON.parse(existingBubble.tags) as string[] : [])
      const overlap = [...newTags].filter(t => existingTags.has(t) && t !== 'observation' && t !== 'auto-discovered')

      // If strong tag overlap, mark as cognitively_extends
      if (overlap.length >= 2) {
        this.ensureCognitiveLink(obsId, node.observationId, 'cognitively_extends')
      }
    }

    logger.debug(`OrientationGraph: registered new observation ${obsId}`)
  }

  /**
   * Get the current snapshot (may be null if not yet built).
   */
  getSnapshot(): OrientationSnapshot | null {
    return this.snapshot
  }

  // ── Private helpers ─────────────────────────────────────────────

  private classifyBand(confidence: number): ConfidenceBand {
    if (confidence < 0.3) return 'frontier'
    if (confidence < 0.6) return 'exploring'
    if (confidence < 0.85) return 'grounded'
    return 'established'
  }

  private inferDomain(obs: Bubble): string {
    // Simple heuristic: use first non-system tag or title truncation
    const meaningfulTags = obs.tags.filter(
      (t: string) => t !== 'observation' && t !== 'auto-discovered' && t.length > 1,
    )
    if (meaningfulTags.length > 0) return meaningfulTags[0]
    return obs.title.slice(0, 8)
  }

  private ensureCognitiveLink(sourceId: string, targetId: string, relation: string): void {
    try {
      const existing = findLinksByRelation(sourceId, relation)
      if (existing.some(l => l.targetId === targetId)) return
      addLink(sourceId, targetId, relation, 0.5, 'system')
    } catch {
      // Non-critical, skip
    }
  }
}
