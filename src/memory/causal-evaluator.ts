/**
 * Causal Evaluator — determines whether new information changes existing understanding.
 *
 * Positioned between information intake (interest-search, feed-watcher) and the reflector.
 * For each unevaluated bubble, it searches for related existing knowledge and asks:
 *   "Does this new information reinforce, contradict, extend, or not affect my existing understanding?"
 *
 * Output: causal metadata on bubbles + causal links between related knowledge.
 */

import type { LLMProvider, LLMMessage, Bubble } from '../shared/types.js'
import { searchBubbles, updateBubble, rowToBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

// ── Types ──────────────────────────────────────────────────────

export type CausalImpact = 'reinforces' | 'contradicts' | 'extends' | 'neutral'

export interface CausalMetadata {
  causalEvaluated: true
  causalImpact: CausalImpact
  affectedBubbleIds: string[]
  causalConfidence: number
  causalReason: string
}

export interface CausalEvalResult {
  evaluated: number
  reinforces: number
  contradicts: number
  extends: number
  neutral: number
}

// ── Constants ──────────────────────────────────────────────────

const MAX_EVAL_PER_RUN = 10
const MIN_RELATED_SCORE = 0.3

const CAUSAL_PROMPT = `你是因果推理引擎。你的任务是判断一条新信息是否改变了对已有知识的理解。

分析维度：
1. reinforces（强化）— 新信息支持已有理解，增加确信度
2. contradicts（矛盾）— 新信息与已有理解冲突，需要重新审视
3. extends（延伸）— 新信息补充了已有理解的盲区，拓展认知边界
4. neutral（无关）— 新信息与已有知识无因果关联

输出严格 JSON：
{
  "impact": "reinforces" | "contradicts" | "extends" | "neutral",
  "affectedIds": ["最相关的已有知识bubble ID，最多3个"],
  "confidence": 0.0-1.0,
  "reason": "一句话解释因果判断依据"
}`

// ── Evaluator ──────────────────────────────────────────────────

export class CausalEvaluator {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  async evaluate(spaceId?: string): Promise<CausalEvalResult> {
    const result: CausalEvalResult = { evaluated: 0, reinforces: 0, contradicts: 0, extends: 0, neutral: 0 }

    const unevaluated = this.findUnevaluatedBubbles(spaceId)
    if (unevaluated.length === 0) {
      logger.debug('CausalEvaluator: no unevaluated bubbles found')
      return result
    }

    logger.info(`CausalEvaluator: found ${unevaluated.length} unevaluated bubbles, processing up to ${MAX_EVAL_PER_RUN}`)

    for (const bubble of unevaluated.slice(0, MAX_EVAL_PER_RUN)) {
      try {
        const impact = await this.evaluateSingle(bubble, spaceId)
        if (!impact) continue

        result.evaluated++
        result[impact.causalImpact]++

        // Update bubble metadata with causal annotation
        const existingMeta = (bubble.metadata ?? {}) as Record<string, unknown>
        updateBubble(bubble.id, {
          metadata: { ...existingMeta, ...impact },
        })

        // Create causal links for non-neutral impacts
        if (impact.causalImpact !== 'neutral') {
          const relation = impact.causalImpact === 'contradicts' ? 'contradicts'
            : impact.causalImpact === 'extends' ? 'extends'
            : 'supports'
          for (const targetId of impact.affectedBubbleIds) {
            addLink(bubble.id, targetId, relation, impact.causalConfidence, 'causal-evaluator')

            // Anti-confirmation bias: if contradicts, reduce target's confidence
            if (impact.causalImpact === 'contradicts' && impact.causalConfidence > 0.6) {
              const target = searchBubbles(targetId, 1)
              if (target.length > 0 && target[0].id === targetId) {
                const newConf = Math.max(0.3, target[0].confidence * 0.8)
                updateBubble(targetId, { confidence: newConf })
                logger.info(`CausalEvaluator: reduced confidence of ${targetId} to ${newConf.toFixed(2)} due to contradiction`)
              }
            }
          }
        }
      } catch (err) {
        logger.error(`CausalEvaluator: failed for bubble ${bubble.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    logger.info(`CausalEvaluator: evaluated=${result.evaluated} (reinforces=${result.reinforces}, contradicts=${result.contradicts}, extends=${result.extends}, neutral=${result.neutral})`)
    return result
  }

  private findUnevaluatedBubbles(spaceId?: string): Bubble[] {
    const db = getDatabase()
    let sql = `SELECT * FROM bubbles
      WHERE deleted_at IS NULL
        AND abstraction_level = 0
        AND source IN ('interest-search', 'feed-watcher', 'user', 'chat')
        AND json_extract(metadata, '$.causalEvaluated') IS NULL`
    const params: unknown[] = []

    if (spaceId) {
      sql += ' AND space_id = ?'
      params.push(spaceId)
    }

    sql += ' ORDER BY created_at DESC LIMIT ?'
    params.push(MAX_EVAL_PER_RUN * 2) // fetch extra for filtering

    const rows = db.prepare(sql).all(...params) as any[]
    return rows.map(rowToBubble)
  }

  private async evaluateSingle(bubble: Bubble, spaceId?: string): Promise<CausalMetadata | null> {
    // Search for related existing knowledge (observations, syntheses, portraits)
    const spaceIds = spaceId ? [spaceId] : undefined
    const related = searchBubbles(bubble.title + ' ' + bubble.content.slice(0, 200), 8, spaceIds)
      .filter(b => b.id !== bubble.id && b.abstractionLevel >= 1)

    if (related.length === 0) {
      // No existing higher-level knowledge to compare against — mark as evaluated but neutral
      return {
        causalEvaluated: true,
        causalImpact: 'neutral',
        affectedBubbleIds: [],
        causalConfidence: 0.5,
        causalReason: '无相关高层知识可比对',
      }
    }

    // Build context for LLM
    const relatedList = related.slice(0, 5).map((b, i) =>
      `${i + 1}. [ID:${b.id}] [L${b.abstractionLevel}] ${b.title}: ${b.content.slice(0, 300)}`,
    ).join('\n')

    const userContent = `## 新信息
标题: ${bubble.title}
内容: ${bubble.content.slice(0, 800)}
来源: ${bubble.source}

## 已有知识
${relatedList}

请判断新信息对已有知识的因果影响：`

    const messages: LLMMessage[] = [
      { role: 'system', content: CAUSAL_PROMPT },
      { role: 'user', content: userContent },
    ]

    const response = await this.llm.chat(messages)
    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.debug(`CausalEvaluator: no JSON in LLM response for ${bubble.id}`)
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      impact: string
      affectedIds: string[]
      confidence: number
      reason: string
    }

    const validImpacts: CausalImpact[] = ['reinforces', 'contradicts', 'extends', 'neutral']
    const impact = validImpacts.includes(parsed.impact as CausalImpact)
      ? (parsed.impact as CausalImpact)
      : 'neutral'

    // Validate affected IDs — only keep those that actually exist in related results
    const relatedIds = new Set(related.map(b => b.id))
    const validAffectedIds = (parsed.affectedIds || [])
      .filter((id: string) => relatedIds.has(id))
      .slice(0, 3)

    return {
      causalEvaluated: true,
      causalImpact: impact,
      affectedBubbleIds: validAffectedIds,
      causalConfidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
      causalReason: parsed.reason || '',
    }
  }
}
