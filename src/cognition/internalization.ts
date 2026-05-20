/**
 * Internalization Engine — updates existing beliefs based on causal evaluation.
 *
 * Core principle: observations are hypotheses, not facts.
 * This module strengthens, weakens, or kills them based on new evidence,
 * with cascading effects and full provenance tracking.
 *
 * Safety: All operations require approval in initial deployment phase.
 */

import type { Bubble, BubbleType } from '../shared/types.js'
import { findBubblesByType, updateBubble, createBubble } from '../bubble/model.js'
import { findLinksByRelation, addLink } from '../bubble/links.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { EventBus } from '../event/event-bus.js'
import type { CausalVerdict, ImpactType } from './causal-evaluator.js'
import type { ObservationMetadata, ObservationTrend } from '../memory/reflector.js'
import type { OrientationGraph } from './orientation-graph.js'

// ── Types ───────────────────────────────────────────────────────

export type ActionType = 'strengthen' | 'weaken' | 'merge_evidence' | 'split_observation' | 'kill' | 'spawn_gap'

export interface InternalizationAction {
  type: ActionType
  targetObservationId: string
  evidenceBubbleId: string
  confidenceDelta: number
  trendTransition?: ObservationTrend
  reason: string
}

export interface EvolutionRecord {
  timestamp: number
  trigger: { bubbleId: string; source: string; causalChain: string }
  before: { confidence: number; trend: string; evidenceCount: number }
  after: { confidence: number; trend: string; evidenceCount: number }
  action: ActionType
  approvedBy?: string
}

export interface CascadeResult {
  primaryChange: InternalizationAction
  cascadedChanges: InternalizationAction[]
  newGaps: Array<{ domain: string; suggestedQueries: string[] }>
  requiresApproval: boolean
}

export interface InternalizationProposal {
  id: string
  verdict: CausalVerdict
  actions: InternalizationAction[]
  cascadeResult: CascadeResult | null
  status: 'pending' | 'approved' | 'rejected'
  createdAt: number
}

// ── Constants ───────────────────────────────────────────────────

const CASCADE_DAMPENING = 0.5
const CASCADE_MAX_DEPTH = 2
const KILL_CONFIDENCE_THRESHOLD = 0.1
const KILL_MIN_CONTRADICTIONS = 2
const CASCADE_APPROVAL_THRESHOLD = 3  // >3 cascaded → requires approval

// ── Internalization Engine Class ────────────────────────────────

export class InternalizationEngine {
  private eventBus: EventBus | null = null
  private orientationGraph: OrientationGraph | null = null
  private requireApproval = true  // 初期全审批

  constructor() {}

  setEventBus(bus: EventBus): void {
    this.eventBus = bus
  }

  setOrientationGraph(graph: OrientationGraph): void {
    this.orientationGraph = graph
  }

  setApprovalMode(require: boolean): void {
    this.requireApproval = require
  }

  /**
   * Generate internalization proposal from a causal verdict.
   * Does NOT apply changes — only plans them.
   */
  generateProposal(verdict: CausalVerdict, evidenceBubbleId: string): InternalizationProposal | null {
    // Skip novel — nothing to internalize
    if (verdict.impactType === 'novel') return null
    if (verdict.affectedObservations.length === 0) return null

    const actions = this.verdictToActions(verdict, evidenceBubbleId)
    if (actions.length === 0) return null

    // Check cascades for the primary action
    let cascadeResult: CascadeResult | null = null
    if (actions[0].type === 'weaken' || actions[0].type === 'kill') {
      cascadeResult = this.simulateCascade(actions[0])
    }

    const proposal: InternalizationProposal = {
      id: `prop_${Date.now().toString(36)}`,
      verdict,
      actions,
      cascadeResult,
      status: 'pending',
      createdAt: Date.now(),
    }

    // Store proposal as pending bubble
    createBubble({
      type: 'event',
      title: `认知内化提案: ${verdict.causalChain.slice(0, 30)}`,
      content: JSON.stringify(proposal, null, 2),
      tags: ['internalization-proposal', 'pending'],
      source: 'cognition-engine',
      confidence: verdict.confidence,
      decayRate: 0.1,
      metadata: {
        proposalId: proposal.id,
        status: 'pending',
        impactType: verdict.impactType,
        affectedCount: verdict.affectedObservations.length,
        cascadeCount: cascadeResult?.cascadedChanges.length ?? 0,
      },
    })

    logger.info(`Internalization: proposal ${proposal.id} created — ${verdict.impactType} affecting ${actions.length} observations`)
    return proposal
  }

  /**
   * Execute an approved proposal — apply all actions.
   * Called after user approves via Feishu.
   */
  async executeProposal(proposal: InternalizationProposal, approvedBy: string): Promise<boolean> {
    try {
      // Apply primary actions
      for (const action of proposal.actions) {
        this.applyAction(action, proposal.verdict.causalChain, approvedBy)
      }

      // Apply cascaded actions if present
      if (proposal.cascadeResult?.cascadedChanges) {
        for (const cascadeAction of proposal.cascadeResult.cascadedChanges) {
          this.applyAction(cascadeAction, `[cascade] ${proposal.verdict.causalChain}`, approvedBy)
        }

        // Emit cascade event
        if (this.eventBus && proposal.cascadeResult.cascadedChanges.length > 0) {
          this.eventBus.emitFireAndForget(
            {
              type: 'knowledge.cascade.triggered',
              payload: {
                primaryId: proposal.actions[0].targetObservationId,
                cascadedIds: proposal.cascadeResult.cascadedChanges.map(c => c.targetObservationId),
                depth: 1,
              },
            },
            { actor: 'system' },
          )
        }
      }

      // Trigger gap filling if needed
      if (proposal.cascadeResult?.newGaps) {
        for (const gap of proposal.cascadeResult.newGaps) {
          this.triggerGapFill(gap.domain, gap.suggestedQueries)
        }
      }

      // Mark proposal bubble as approved
      this.updateProposalStatus(proposal.id, 'approved')

      // P2: OPD feedback — approval confirms our causal reasoning was valid
      this.applyOpdFeedback(proposal, 'approved')

      logger.info(`Internalization: proposal ${proposal.id} executed by ${approvedBy}`)
      return true
    } catch (err) {
      logger.error(`Internalization: execution failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * Reject a proposal.
   */
  rejectProposal(proposalId: string, proposal?: InternalizationProposal): void {
    this.updateProposalStatus(proposalId, 'rejected')
    // P2: OPD feedback — rejection means our causal reasoning was flawed
    if (proposal) this.applyOpdFeedback(proposal, 'rejected')
    logger.info(`Internalization: proposal ${proposalId} rejected`)
  }

  /**
   * Format proposal as Feishu message for approval.
   */
  formatApprovalMessage(proposal: InternalizationProposal): string {
    const actionSummary = proposal.actions.map(a => {
      const arrow = a.type === 'strengthen' ? '+' : a.type === 'weaken' ? '-' : a.type === 'kill' ? 'X' : '~'
      return `  ${arrow} ${a.type}: "${a.reason}" (delta: ${a.confidenceDelta > 0 ? '+' : ''}${a.confidenceDelta.toFixed(2)})`
    }).join('\n')

    const cascadeInfo = proposal.cascadeResult?.cascadedChanges.length
      ? `\n级联影响: ${proposal.cascadeResult.cascadedChanges.length} 个下游观察`
      : ''

    return `🧠 认知内化提案\n\n因果链: ${proposal.verdict.causalChain}\n维度: ${proposal.verdict.dimension}\n操作:\n${actionSummary}${cascadeInfo}\n\n回复 "approve ${proposal.id}" 执行\n回复 "reject ${proposal.id}" 驳回`
  }

  // ── Private: Action generation ────────────────────────────────

  private verdictToActions(verdict: CausalVerdict, evidenceBubbleId: string): InternalizationAction[] {
    const actions: InternalizationAction[] = []

    for (const affected of verdict.affectedObservations) {
      let actionType: ActionType
      let trendTransition: ObservationTrend | undefined

      switch (verdict.impactType) {
        case 'confirms':
          actionType = 'strengthen'
          trendTransition = 'strengthening'
          break
        case 'contradicts':
          actionType = 'weaken'
          trendTransition = 'weakening'
          break
        case 'extends':
          actionType = 'merge_evidence'
          break
        case 'refines':
          actionType = 'merge_evidence'
          break
        default:
          continue
      }

      // Apply diminishing returns for strengthening
      let adjustedDelta = affected.delta
      if (actionType === 'strengthen') {
        const obs = this.getObservation(affected.observationId)
        if (obs) {
          const meta = obs.metadata as Partial<ObservationMetadata> | undefined
          const evidenceCount = meta?.evidenceCount ?? 1
          if (evidenceCount > 5) {
            adjustedDelta *= 0.5  // diminishing returns
          }
        }
      }

      actions.push({
        type: actionType,
        targetObservationId: affected.observationId,
        evidenceBubbleId,
        confidenceDelta: adjustedDelta,
        trendTransition,
        reason: verdict.causalChain,
      })
    }

    return actions
  }

  // ── Private: Action application ───────────────────────────────

  private applyAction(action: InternalizationAction, causalChain: string, approvedBy: string): void {
    const obs = this.getObservation(action.targetObservationId)
    if (!obs) {
      logger.debug(`Internalization: observation ${action.targetObservationId} not found, skipping`)
      return
    }

    const meta = (obs.metadata || {}) as Record<string, unknown>
    const obsMeta = meta as Partial<ObservationMetadata>
    const before = {
      confidence: obs.confidence,
      trend: obsMeta.trend || 'unknown',
      evidenceCount: obsMeta.evidenceCount || 0,
    }

    // Apply changes based on action type
    switch (action.type) {
      case 'strengthen': {
        const newConf = Math.min(1.0, obs.confidence + action.confidenceDelta)
        const newDecayRate = Math.max(0.02, obs.decayRate * 0.9) // reduce decay
        updateBubble(obs.id, {
          confidence: newConf,
          decayRate: newDecayRate,
          metadata: {
            ...meta,
            trend: action.trendTransition || obsMeta.trend,
            evidenceCount: (obsMeta.evidenceCount || 0) + 1,
            lastSeen: Date.now(),
          },
        })
        addLink(obs.id, action.evidenceBubbleId, 'evidence_for', 0.8, 'system')
        if (this.eventBus) {
          this.eventBus.emitFireAndForget(
            { type: 'knowledge.observation.strengthened', payload: { observationId: obs.id, newConfidence: newConf, evidenceBubbleId: action.evidenceBubbleId } },
            { actor: 'system' },
          )
        }
        break
      }

      case 'weaken': {
        const newConf = Math.max(0, obs.confidence + action.confidenceDelta) // delta is negative
        const newDecayRate = Math.min(0.15, obs.decayRate * 1.3) // increase decay
        updateBubble(obs.id, {
          confidence: newConf,
          decayRate: newDecayRate,
          metadata: {
            ...meta,
            trend: action.trendTransition || 'weakening',
            lastSeen: Date.now(),
          },
        })
        addLink(action.evidenceBubbleId, obs.id, 'contradicts', 0.7, 'system')
        if (this.eventBus) {
          this.eventBus.emitFireAndForget(
            { type: 'knowledge.observation.weakened', payload: { observationId: obs.id, newConfidence: newConf, contradictionBubbleId: action.evidenceBubbleId } },
            { actor: 'system' },
          )
        }
        break
      }

      case 'merge_evidence': {
        const evidenceIds = (obsMeta.evidenceIds || []) as string[]
        if (!evidenceIds.includes(action.evidenceBubbleId)) {
          evidenceIds.push(action.evidenceBubbleId)
        }
        updateBubble(obs.id, {
          confidence: Math.min(1.0, obs.confidence + 0.03),
          metadata: {
            ...meta,
            evidenceIds,
            evidenceCount: evidenceIds.length,
            lastSeen: Date.now(),
          },
        })
        addLink(obs.id, action.evidenceBubbleId, 'evidence_for', 0.6, 'system')
        break
      }

      case 'kill': {
        updateBubble(obs.id, {
          confidence: 0,
          decayRate: 0.25,
          metadata: {
            ...meta,
            trend: 'stale' as ObservationTrend,
            killedAt: Date.now(),
            killedBy: action.evidenceBubbleId,
          },
        })
        addLink(action.evidenceBubbleId, obs.id, 'invalidated_by', 1.0, 'system')
        if (this.eventBus) {
          this.eventBus.emitFireAndForget(
            { type: 'knowledge.observation.killed', payload: { observationId: obs.id, killedBy: action.evidenceBubbleId, reason: action.reason } },
            { actor: 'system' },
          )
        }
        break
      }

      case 'spawn_gap': {
        // Just emit gap event — interest-search will handle it
        break
      }
    }

    // Record evolution history
    const after = {
      confidence: action.type === 'kill' ? 0 : Math.max(0, Math.min(1, obs.confidence + action.confidenceDelta)),
      trend: action.trendTransition || obsMeta.trend || 'unknown',
      evidenceCount: (obsMeta.evidenceCount || 0) + (action.type === 'merge_evidence' ? 1 : 0),
    }

    this.recordEvolution(obs.id, {
      timestamp: Date.now(),
      trigger: { bubbleId: action.evidenceBubbleId, source: 'causal-evaluator', causalChain },
      before,
      after,
      action: action.type,
      approvedBy,
    })
  }

  // ── Private: Cascade simulation ───────────────────────────────

  private simulateCascade(primaryAction: InternalizationAction): CascadeResult {
    const cascadedChanges: InternalizationAction[] = []
    const newGaps: Array<{ domain: string; suggestedQueries: string[] }> = []

    // Only cascade for weaken/kill
    if (primaryAction.type !== 'weaken' && primaryAction.type !== 'kill') {
      return { primaryChange: primaryAction, cascadedChanges, newGaps, requiresApproval: this.requireApproval }
    }

    this.cascadeDown(primaryAction.targetObservationId, primaryAction.confidenceDelta, 1, cascadedChanges, newGaps, primaryAction.evidenceBubbleId)

    return {
      primaryChange: primaryAction,
      cascadedChanges,
      newGaps,
      requiresApproval: this.requireApproval || cascadedChanges.length > CASCADE_APPROVAL_THRESHOLD,
    }
  }

  private cascadeDown(
    observationId: string,
    parentDelta: number,
    depth: number,
    cascaded: InternalizationAction[],
    gaps: Array<{ domain: string; suggestedQueries: string[] }>,
    evidenceBubbleId: string,
  ): void {
    if (depth > CASCADE_MAX_DEPTH) return

    // Find all observations that depend on this one
    const dependents = findLinksByRelation(observationId, 'cognitively_depends_on')
    // Note: we need to find links where TARGET is this observation (others depend on it)
    const db = getDatabase()
    const rows = db.prepare(
      `SELECT source_id FROM bubble_links WHERE target_id = ? AND relation = 'cognitively_depends_on'`,
    ).all(observationId) as Array<{ source_id: string }>

    for (const row of rows) {
      const depObs = this.getObservation(row.source_id)
      if (!depObs) continue

      // Apply dampened cascade
      const cascadeDelta = parentDelta * CASCADE_DAMPENING
      const newConfidence = depObs.confidence + cascadeDelta

      if (newConfidence < 0.3) {
        cascaded.push({
          type: 'weaken',
          targetObservationId: depObs.id,
          evidenceBubbleId,
          confidenceDelta: cascadeDelta,
          trendTransition: 'weakening',
          reason: `[cascade] dependency on weakened observation`,
        })

        // If this cascaded observation drops significantly, check for gap
        if (newConfidence < 0.2) {
          const domain = depObs.tags.find((t: string) => t !== 'observation' && t !== 'auto-discovered') || depObs.title.slice(0, 8)
          gaps.push({ domain, suggestedQueries: [`${domain} 最新情况`, `${domain} 验证`] })
        }

        // Recurse
        this.cascadeDown(depObs.id, cascadeDelta, depth + 1, cascaded, gaps, evidenceBubbleId)
      }
    }
  }

  // ── Private: OPD Feedback ──────────────────────────────────────

  /**
   * P2: OPD-inspired feedback — extract "hint" from approval/rejection
   * and feed it back to OrientationGraph to adjust domain weights.
   */
  private applyOpdFeedback(proposal: InternalizationProposal, action: 'approved' | 'rejected'): void {
    if (!this.orientationGraph) return

    try {
      // Extract affected domains from the verdict
      const affectedDomains: string[] = [proposal.verdict.dimension]

      // Also include domains of affected observations
      for (const ao of proposal.verdict.affectedObservations) {
        const obs = this.getObservation(ao.observationId)
        if (obs) {
          const domainTag = obs.tags.find((t: string) => t !== 'observation' && t !== 'auto-discovered' && t.length > 1)
          if (domainTag && !affectedDomains.includes(domainTag)) {
            affectedDomains.push(domainTag)
          }
        }
      }

      this.orientationGraph.applyFeedback({
        action,
        affectedDomains,
        impactType: proposal.verdict.impactType,
        causalChain: proposal.verdict.causalChain,
      })
    } catch (err) {
      logger.debug(`Internalization: OPD feedback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Private: Gap triggering ───────────────────────────────────

  private triggerGapFill(domain: string, suggestedQueries: string[]): void {
    if (this.eventBus) {
      this.eventBus.emitFireAndForget(
        { type: 'knowledge.gap.detected', payload: { domain, suggestedQueries, priority: 0.8 } },
        { actor: 'system' },
      )
    }
    logger.info(`Internalization: gap detected in "${domain}", triggering search`)
  }

  // ── Private: Helpers ──────────────────────────────────────────

  private getObservation(id: string): Bubble | null {
    const db = getDatabase()
    const row = db.prepare(
      `SELECT * FROM bubbles WHERE id = ? AND type = 'observation' AND deleted_at IS NULL`,
    ).get(id) as Record<string, unknown> | undefined

    if (!row) return null

    return {
      id: row.id as string,
      type: 'observation' as BubbleType,
      title: row.title as string,
      content: row.content as string,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      links: [],
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      accessedAt: row.accessed_at as number,
      source: row.source as string,
      confidence: row.confidence as number,
      decayRate: row.decay_rate as number,
      pinned: !!(row.pinned as number),
      spaceId: row.space_id as string | undefined,
      abstractionLevel: row.abstraction_level as number,
      summary: row.summary as string | undefined,
    }
  }

  private recordEvolution(observationId: string, record: EvolutionRecord): void {
    try {
      const db = getDatabase()
      const row = db.prepare('SELECT metadata FROM bubbles WHERE id = ?').get(observationId) as { metadata: string } | undefined
      if (!row) return

      const meta = row.metadata ? JSON.parse(row.metadata) : {}
      const history = (meta.evolutionHistory || []) as EvolutionRecord[]
      history.push(record)

      db.prepare('UPDATE bubbles SET metadata = ?, updated_at = ? WHERE id = ?').run(
        JSON.stringify({ ...meta, evolutionHistory: history }),
        Date.now(),
        observationId,
      )
    } catch (err) {
      logger.debug(`Internalization: failed to record evolution: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private updateProposalStatus(proposalId: string, status: 'approved' | 'rejected'): void {
    try {
      const db = getDatabase()
      const row = db.prepare(
        `SELECT id, metadata FROM bubbles WHERE json_extract(metadata, '$.proposalId') = ? AND deleted_at IS NULL`,
      ).get(proposalId) as { id: string; metadata: string } | undefined

      if (row) {
        const meta = JSON.parse(row.metadata)
        db.prepare('UPDATE bubbles SET metadata = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify({ ...meta, status }),
          Date.now(),
          row.id,
        )
      }
    } catch {
      // Non-critical
    }
  }
}
