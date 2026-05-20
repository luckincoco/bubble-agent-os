/**
 * Causal Evaluator — assesses the impact of new information on existing beliefs.
 *
 * Multi-dimensional evaluation: when new info arrives (from interest-search,
 * conversations, or business events), determines HOW it changes understanding
 * rather than just storing it as another bubble.
 *
 * Dimensions: market dynamics, supplier behavior, customer patterns,
 * operational risk, financial exposure, tech improvement.
 */

import type { LLMProvider, Bubble, BubbleType } from '../shared/types.js'
import { findBubblesByType, searchBubbles } from '../bubble/model.js'
import { logger } from '../shared/logger.js'
import type { ObservationMetadata } from '../memory/reflector.js'

// ── Types ───────────────────────────────────────────────────────

export type ImpactType = 'confirms' | 'contradicts' | 'extends' | 'refines' | 'novel'
export type BusinessDimension = 'market_dynamics' | 'supplier_behavior' | 'customer_pattern'
  | 'operational_risk' | 'financial_exposure' | 'tech_improvement'
export type Urgency = 'low' | 'medium' | 'high'
export type InformationDepth = 'phenomenon' | 'motive' | 'pattern' | 'projection'

export interface EvaluationInput {
  bubbleId: string
  content: string
  source: 'interest-search' | 'conversation' | 'biz-event'
  tags: string[]
  spaceId: string
}

export interface CausalVerdict {
  impactType: ImpactType
  affectedObservations: Array<{
    observationId: string
    relationship: 'strengthens' | 'weakens' | 'modifies'
    delta: number
  }>
  causalChain: string
  confidence: number
  dimension: BusinessDimension
  urgency: Urgency
  informationDepth: InformationDepth
  needsMotiveGap?: boolean
  needsPatternSupport?: boolean
}

// ── Constants ───────────────────────────────────────────────────

const MAX_EVALUATIONS_PER_HOUR = 5
const CONFIDENCE_FLOOR = 0.3

const EVALUATE_PROMPT = `你是钢贸业务知识系统的因果分析师。评估新信息对已有认知的影响。

评估维度：
- market_dynamics: 钢材价格/市场供需变化
- supplier_behavior: 供应商行为/可靠性/定价模式
- customer_pattern: 客户需求/付款/采购模式
- operational_risk: 物流/库存/运营风险
- financial_exposure: 财务敞口/账期/资金风险
- tech_improvement: 系统技术可改进方向

信息深度分类：
- phenomenon: 观察到什么发生了（事实、数据、现象描述）
- motive: 为什么发生（动机推断、原因分析）
- pattern: 类似事件的历史结构（规律、模式、周期性）
- projection: 基于规律的推演（预测、推断、假设验证）

已有认知（最相关的观察）：
{observations}

新信息：
{newContent}

判断这条新信息对已有认知的因果影响，并判断信息本身的认知深度。

输出严格 JSON（不要代码块包裹）：
{"impactType":"confirms|contradicts|extends|refines|novel","affectedObservations":[{"id":"观察ID","relationship":"strengthens|weakens|modifies","delta":0.1}],"causalChain":"一句话因果链描述","confidence":0.7,"dimension":"market_dynamics","urgency":"low|medium|high","informationDepth":"phenomenon|motive|pattern|projection"}`

// ── Causal Evaluator Class ──────────────────────────────────────

export class CausalEvaluator {
  private llm: LLMProvider
  private evaluationCount = 0
  private lastResetHour = 0

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Gate function — not all bubbles need evaluation.
   * Expected to filter ~60% of input.
   */
  shouldEvaluate(bubble: Bubble): boolean {
    // Skip personal conversation memories
    if (bubble.type === 'memory') return false

    // Skip too-thin content
    const contentLen = (bubble.title?.length || 0) + (bubble.content?.length || 0)
    if (contentLen < 50) return false

    // Skip if no tag overlap with any observation
    const observations = findBubblesByType('observation' as BubbleType, 30)
    if (observations.length === 0) return false

    const bubbleTags = new Set(bubble.tags.filter(
      (t: string) => t !== 'interest-search' && t !== 'deep-read' && t !== 'event',
    ))
    if (bubbleTags.size === 0) return false

    const hasOverlap = observations.some(obs => {
      const obsTags = obs.tags.filter(
        (t: string) => t !== 'observation' && t !== 'auto-discovered',
      )
      return obsTags.some((t: string) => bubbleTags.has(t))
    })

    return hasOverlap
  }

  /**
   * Evaluate a single piece of new information.
   */
  async evaluate(input: EvaluationInput): Promise<CausalVerdict | null> {
    // Rate limiting
    if (!this.checkRateLimit()) {
      logger.debug('CausalEvaluator: rate limit reached, skipping')
      return null
    }

    // Find relevant observations to evaluate against
    const observations = this.getRelevantObservations(input.tags, input.content)
    if (observations.length === 0) {
      return { impactType: 'novel', affectedObservations: [], causalChain: '无相关已有认知', confidence: 0.5, dimension: 'market_dynamics', urgency: 'low', informationDepth: 'phenomenon', needsMotiveGap: true }
    }

    // Build prompt context
    const obsStr = observations.slice(0, 5).map(o =>
      `[${o.id}] "${o.title}" (conf: ${o.confidence.toFixed(2)}, trend: ${(o.metadata as Partial<ObservationMetadata>)?.trend || 'unknown'})`,
    ).join('\n')

    const content = input.content.slice(0, 500)

    try {
      const response = await this.llm.chat([
        {
          role: 'system',
          content: EVALUATE_PROMPT
            .replace('{observations}', obsStr)
            .replace('{newContent}', content),
        },
      ])

      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0]) as CausalVerdict

      // Validate and enforce safety rules
      const verdict = this.sanitizeVerdict(parsed, observations)
      return verdict
    } catch (err) {
      logger.debug(`CausalEvaluator: evaluation failed: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  /**
   * Batch evaluate multiple inputs in a single LLM call.
   * Used by interest-search for efficiency.
   */
  async batchEvaluate(inputs: EvaluationInput[]): Promise<Array<{ input: EvaluationInput; verdict: CausalVerdict | null }>> {
    const results: Array<{ input: EvaluationInput; verdict: CausalVerdict | null }> = []

    // For now, evaluate one by one (batch prompt can be added later for optimization)
    for (const input of inputs) {
      if (!this.checkRateLimit()) {
        results.push({ input, verdict: null })
        continue
      }

      const verdict = await this.evaluate(input)
      results.push({ input, verdict })
    }

    return results
  }

  // ── Private helpers ─────────────────────────────────────────────

  private getRelevantObservations(tags: string[], content: string): Bubble[] {
    const observations = findBubblesByType('observation' as BubbleType, 30)

    // Score by tag overlap + content relevance
    const meaningfulTags = new Set(tags.filter(
      (t: string) => t !== 'interest-search' && t !== 'deep-read' && t !== 'event' && t.length > 1,
    ))

    const scored = observations.map(obs => {
      const obsTags = obs.tags.filter(
        (t: string) => t !== 'observation' && t !== 'auto-discovered',
      )
      const overlap = obsTags.filter((t: string) => meaningfulTags.has(t)).length
      const score = overlap * 2 + obs.confidence
      return { obs, score }
    })

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => s.obs)
  }

  private sanitizeVerdict(raw: CausalVerdict, observations: Bubble[]): CausalVerdict {
    const verdict = { ...raw }

    // Confidence floor — if too uncertain, mark as novel
    if (verdict.confidence < CONFIDENCE_FLOOR) {
      verdict.impactType = 'novel'
      verdict.affectedObservations = []
    }

    // Validate affected observations exist
    const obsIds = new Set(observations.map(o => o.id))
    verdict.affectedObservations = verdict.affectedObservations.filter(
      ao => obsIds.has(ao.observationId),
    )

    // Cap delta values
    verdict.affectedObservations = verdict.affectedObservations.map(ao => ({
      ...ao,
      delta: Math.max(-0.25, Math.min(0.15, ao.delta)),
    }))

    // Limit affected observations to 3
    verdict.affectedObservations = verdict.affectedObservations.slice(0, 3)

    // Validate dimension
    const validDimensions: BusinessDimension[] = ['market_dynamics', 'supplier_behavior', 'customer_pattern', 'operational_risk', 'financial_exposure', 'tech_improvement']
    if (!validDimensions.includes(verdict.dimension)) {
      verdict.dimension = 'market_dynamics'
    }

    // Validate urgency
    const validUrgency: Urgency[] = ['low', 'medium', 'high']
    if (!validUrgency.includes(verdict.urgency)) {
      verdict.urgency = 'low'
    }

    // Validate informationDepth and derive cognitive gap flags
    const validDepths: InformationDepth[] = ['phenomenon', 'motive', 'pattern', 'projection']
    if (!validDepths.includes(verdict.informationDepth)) {
      verdict.informationDepth = 'phenomenon'
    }
    verdict.needsMotiveGap = verdict.informationDepth === 'phenomenon'
    verdict.needsPatternSupport = verdict.informationDepth === 'motive'

    return verdict
  }

  private checkRateLimit(): boolean {
    const currentHour = Math.floor(Date.now() / (60 * 60 * 1000))
    if (currentHour !== this.lastResetHour) {
      this.evaluationCount = 0
      this.lastResetHour = currentHour
    }

    if (this.evaluationCount >= MAX_EVALUATIONS_PER_HOUR) {
      return false
    }

    this.evaluationCount++
    return true
  }
}
