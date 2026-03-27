/**
 * Reflector — the "discover → validate → suggest" engine for observation bubbles.
 *
 * Inspired by Hindsight's Consolidation Engine:
 * - Discover: scan recent memories for recurring patterns (≥3 related memories)
 * - Validate: re-evaluate existing observations against new evidence, update trend
 * - Suggest: surface high-confidence observations for proactive advice
 *
 * Trend states (borrowed from Hindsight):
 *   new          → first discovered, evidence < 3
 *   strengthening → recent evidence supports it
 *   stable       → enough evidence, no recent changes
 *   weakening    → contradictory evidence appeared
 *   stale        → no new evidence for 30+ days
 */

import type { LLMProvider, LLMMessage, Bubble, BubbleType } from '../shared/types.js'
import { createBubble, findBubblesByType, searchBubbles, updateBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

export type ObservationTrend = 'new' | 'strengthening' | 'stable' | 'weakening' | 'stale'

export interface ObservationMetadata {
  trend: ObservationTrend
  evidenceIds: string[]
  evidenceCount: number
  firstSeen: number
  lastSeen: number
  reviewCount: number
}

export interface ReflectResult {
  discovered: number
  validated: number
  staled: number
}

const DISCOVER_PROMPT = `你是一个数据分析师，擅长从碎片化信息中发现规律和趋势。

## 任务
阅读以下记忆片段，找出一个明显的、有证据支撑的观察结论（observation）。
观察结论应该是：
1. 一个可验证的模式或趋势（不是单一事件的复述）
2. 有至少 2-3 条记忆作为证据
3. 对用户有实际参考价值

## 输出格式（严格 JSON，不要包裹在代码块中）
如果发现了有价值的观察，输出：
{"found":true,"title":"观察标题(不超过20字)","content":"观察描述(50-150字，包含发现的模式和可能的原因)","evidenceIndices":[0,1,2],"confidence":0.6}

如果没有发现有意义的模式，输出：
{"found":false}`

const VALIDATE_PROMPT = `你是一个数据分析师，正在审查一个之前发现的观察结论是否仍然成立。

## 当前观察
标题: {title}
内容: {content}
当前趋势: {trend}
证据数量: {evidenceCount}

## 新的相关记忆
{newMemories}

## 任务
判断这些新记忆是否影响了观察的有效性：
- 如果新记忆支持观察 → strengthening
- 如果新记忆与观察矛盾 → weakening
- 如果新记忆无关 → 保持当前趋势

## 输出格式（严格 JSON，不要包裹在代码块中）
{"newTrend":"strengthening|weakening|stable","reason":"简短理由(一句话)","newEvidenceIndices":[0,1]}`

// --- Configuration ---
const MAX_MEMORIES_PER_RUN = 50
const MAX_OBSERVATIONS_PER_RUN = 20
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MIN_EVIDENCE_FOR_STABLE = 3

export class Reflector {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Run one full reflect cycle: discover → validate → mark stale.
   */
  async run(spaceId?: string): Promise<ReflectResult> {
    const result: ReflectResult = { discovered: 0, validated: 0, staled: 0 }

    // Phase 1: Discover new observations from recent memories
    try {
      result.discovered = await this.discover(spaceId)
    } catch (err) {
      logger.error('Reflector discover error:', err instanceof Error ? err.message : String(err))
    }

    // Phase 2: Validate existing observations
    try {
      const { validated, staled } = await this.validate(spaceId)
      result.validated = validated
      result.staled = staled
    } catch (err) {
      logger.error('Reflector validate error:', err instanceof Error ? err.message : String(err))
    }

    logger.info(`Reflector: discovered=${result.discovered}, validated=${result.validated}, staled=${result.staled}`)
    return result
  }

  /**
   * Phase 1: Discover — scan recent L0 memories for patterns.
   */
  private async discover(spaceId?: string): Promise<number> {
    // Get recent atomic memories (not yet used as evidence)
    const spaceIds = spaceId ? [spaceId] : undefined
    const recentMemories = findBubblesByType('memory' as BubbleType, MAX_MEMORIES_PER_RUN, spaceIds)
    if (recentMemories.length < 3) return 0

    // Group by shared tags to find clusters worth analyzing
    const tagGroups = this.groupByTags(recentMemories)
    let discovered = 0

    for (const group of tagGroups) {
      if (group.length < 3 || discovered >= 5) break

      // Check if this group already has an observation
      const existingObs = this.findExistingObservation(group)
      if (existingObs) continue

      // Ask LLM to discover a pattern
      const memoryList = group.slice(0, 10).map((m, i) =>
        `${i}. [${m.title}] ${m.content.slice(0, 200)}`
      ).join('\n')

      try {
        const messages: LLMMessage[] = [
          { role: 'system', content: DISCOVER_PROMPT },
          { role: 'user', content: `## 记忆片段（共${group.length}条）\n${memoryList}` },
        ]

        const response = await this.llm.chat(messages)
        const jsonMatch = response.content.match(/\{[\s\S]*\}/)
        if (!jsonMatch) continue

        const parsed = JSON.parse(jsonMatch[0])
        if (!parsed.found || !parsed.title || !parsed.content) continue

        const evidenceIndices: number[] = Array.isArray(parsed.evidenceIndices) ? parsed.evidenceIndices : []
        const evidenceIds = evidenceIndices
          .filter(i => i >= 0 && i < group.length)
          .map(i => group[i].id)

        const now = Date.now()
        const meta: ObservationMetadata = {
          trend: evidenceIds.length >= MIN_EVIDENCE_FOR_STABLE ? 'stable' : 'new',
          evidenceIds,
          evidenceCount: evidenceIds.length,
          firstSeen: now,
          lastSeen: now,
          reviewCount: 0,
        }

        const obs = createBubble({
          type: 'observation' as BubbleType,
          title: parsed.title,
          content: parsed.content,
          tags: ['observation', 'auto-discovered'],
          source: 'reflector',
          confidence: Math.min(1.0, Math.max(0.1, parsed.confidence ?? 0.5)),
          decayRate: 0.02,
          spaceId,
          abstractionLevel: 1,
          metadata: meta as unknown as Record<string, unknown>,
        })

        // Link observation to its evidence
        for (const eid of evidenceIds) {
          addLink(obs.id, eid, 'evidence_for', 1.0, 'system')
        }

        discovered++
        logger.info(`Reflector: discovered "${obs.title}" (evidence=${evidenceIds.length})`)
      } catch (err) {
        logger.debug('Reflector discover LLM error:', err instanceof Error ? err.message : String(err))
      }
    }

    return discovered
  }

  /**
   * Phase 2: Validate — re-evaluate existing observations.
   */
  private async validate(spaceId?: string): Promise<{ validated: number; staled: number }> {
    const spaceIds = spaceId ? [spaceId] : undefined
    const observations = findBubblesByType('observation' as BubbleType, MAX_OBSERVATIONS_PER_RUN, spaceIds)
    let validated = 0
    let staled = 0
    const now = Date.now()

    for (const obs of observations) {
      const meta = obs.metadata as unknown as ObservationMetadata
      if (!meta?.trend) continue

      // Mark stale if no new evidence for 30 days
      if (meta.lastSeen && now - meta.lastSeen > STALE_THRESHOLD_MS && meta.trend !== 'stale') {
        meta.trend = 'stale'
        meta.reviewCount = (meta.reviewCount || 0) + 1
        updateBubble(obs.id, { metadata: meta as unknown as Record<string, unknown> })
        staled++
        continue
      }

      // Search for new related memories since last review
      const newMemories = searchBubbles(obs.title, 10, spaceIds)
        .filter(b => b.type === 'memory' && b.createdAt > (meta.lastSeen || 0))

      if (newMemories.length === 0) continue

      // Ask LLM to validate
      const prompt = VALIDATE_PROMPT
        .replace('{title}', obs.title)
        .replace('{content}', obs.content)
        .replace('{trend}', meta.trend)
        .replace('{evidenceCount}', String(meta.evidenceCount))
        .replace('{newMemories}', newMemories.slice(0, 5).map((m, i) =>
          `${i}. [${m.title}] ${m.content.slice(0, 200)}`
        ).join('\n'))

      try {
        const messages: LLMMessage[] = [
          { role: 'system', content: prompt },
          { role: 'user', content: '请审查并输出 JSON：' },
        ]

        const response = await this.llm.chat(messages)
        const jsonMatch = response.content.match(/\{[\s\S]*\}/)
        if (!jsonMatch) continue

        const parsed = JSON.parse(jsonMatch[0])
        const newTrend = parsed.newTrend as ObservationTrend

        if (['strengthening', 'weakening', 'stable'].includes(newTrend)) {
          // Update evidence
          const newEvidenceIndices: number[] = Array.isArray(parsed.newEvidenceIndices) ? parsed.newEvidenceIndices : []
          const newEvidenceIds = newEvidenceIndices
            .filter(i => i >= 0 && i < newMemories.length)
            .map(i => newMemories[i].id)

          for (const eid of newEvidenceIds) {
            if (!meta.evidenceIds.includes(eid)) {
              meta.evidenceIds.push(eid)
              addLink(obs.id, eid, 'evidence_for', 1.0, 'system')
            }
          }

          meta.trend = newTrend
          meta.evidenceCount = meta.evidenceIds.length
          meta.lastSeen = now
          meta.reviewCount = (meta.reviewCount || 0) + 1

          // Adjust confidence based on trend
          let newConfidence = obs.confidence
          if (newTrend === 'strengthening') newConfidence = Math.min(1.0, obs.confidence + 0.1)
          else if (newTrend === 'weakening') newConfidence = Math.max(0.1, obs.confidence - 0.15)

          updateBubble(obs.id, {
            metadata: meta as unknown as Record<string, unknown>,
            confidence: newConfidence,
          })
          validated++
          logger.debug(`Reflector: validated "${obs.title}" → ${newTrend} (confidence=${newConfidence.toFixed(2)})`)
        }
      } catch (err) {
        logger.debug('Reflector validate LLM error:', err instanceof Error ? err.message : String(err))
      }
    }

    return { validated, staled }
  }

  /**
   * Group memories by shared tags for pattern discovery.
   * Returns groups sorted by size descending.
   */
  private groupByTags(memories: Bubble[]): Bubble[][] {
    const tagMap = new Map<string, Bubble[]>()
    for (const m of memories) {
      for (const tag of m.tags) {
        if (tag === 'novel' || tag === 'surprise' || tag === 'contradiction') continue
        if (!tagMap.has(tag)) tagMap.set(tag, [])
        tagMap.get(tag)!.push(m)
      }
    }
    return [...tagMap.values()]
      .filter(g => g.length >= 3)
      .sort((a, b) => b.length - a.length)
  }

  /**
   * Check if a memory group already has an observation with significant overlap.
   */
  private findExistingObservation(group: Bubble[]): Bubble | null {
    // Use the most common tag as search query
    const tagCount = new Map<string, number>()
    for (const m of group) {
      for (const t of m.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1)
    }
    const topTag = [...tagCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    if (!topTag) return null

    const existing = searchBubbles(topTag, 5)
      .filter(b => b.type === 'observation')
    return existing.length > 0 ? existing[0] : null
  }

  /**
   * Get high-confidence observations suitable for proactive suggestions.
   */
  getSuggestions(spaceId?: string, minConfidence = 0.7): Bubble[] {
    const spaceIds = spaceId ? [spaceId] : undefined
    return findBubblesByType('observation' as BubbleType, 50, spaceIds)
      .filter(b => {
        const meta = b.metadata as unknown as ObservationMetadata
        return b.confidence >= minConfidence
          && meta?.trend !== 'stale'
          && meta?.trend !== 'weakening'
      })
  }
}
