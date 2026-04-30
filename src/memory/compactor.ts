import type { Bubble, LLMProvider, LLMMessage } from '../shared/types.js'
import { createBubble, findCompactionCandidates, updateBubble } from '../bubble/model.js'
import { getDatabase } from '../storage/database.js'
import { addLink, getNeighborIds } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

// --- Interfaces ---

interface BubbleCluster {
  bubbles: Bubble[]
  sharedTags: string[]
  cohesionScore: number
}

export interface CompactionResult {
  synthesized: number
  portrayed: number
  clustersFound: number
  skipped: number
  newBubbleIds: string[]
}

/** Provenance metadata stored in synthesis/portrait bubble metadata */
interface ProvenanceMetadata {
  sourceIds: string[]
  sourceWeights: number[]
  clusterCohesion: number
  temperature: number
  createdByVersion: string
}

/** Quality assessment stored in synthesis bubble metadata (set by Reflector) */
export interface SynthesisQualityAssessment {
  alignedObservations: number
  contradictedObservations: number
  noveltyScore: number
  assessedAt: number
}

/** Quality signal from Reflector for individual source bubbles */
export interface QualitySignal {
  validated: boolean
  observationTrend: 'new' | 'strengthening' | 'stable' | 'weakening' | 'stale'
  observationConfidence: number
}

/** Negation record: why a source bubble's info was or wasn't absorbed during compaction */
export interface NegationRecord {
  sourceIndex: number
  sourceId: string
  absorbed: boolean
  reason?: string   // only present when absorbed=false — the "why not" is the learning signal
}

// --- LLM Prompts ---

const SYNTHESIS_PROMPT = `你是一个认知科学家，专门从具体事实中提炼抽象概念。

## 任务
阅读以下原子记忆，执行「抽象跃迁」——不是总结它们说了什么，而是推断它们共同揭示了什么更深层的模式、趋势或意图。

## 抽象跃迁规则
1. 「向上一层」思考：如果这些记忆是树叶，你要找的是树枝
   - 错误: "用户提到了A、B、C三件事" (列举/摘要)
   - 正确: "用户表现出对XX领域的持续关注，可能的动因是YY" (模式识别)
2. 寻找「意图」而非「内容」：为什么用户会关心这些事？
3. 发现「趋势」而非「事件」：这些事实放在一起说明了什么变化？
4. 提出「预测」：基于已有模式，用户下一步可能关心什么？

## 否定信号（同等重要）
完成抽象后，对每条原子记忆做判断：它的核心信息是否已融入你的抽象？
- absorbed=true: 该条信息已融入抽象
- absorbed=false: 该条信息未被吸收，写明原因（偏离模式方向/孤证无法纳入趋势/与主流证据矛盾/讨论了不同维度）
不被吸收不代表不重要——记录原因是为了理解这次选择本身。

## 输出格式（严格 JSON，不要包裹在代码块中）
{"title":"概念标题(不超过20字)","content":"抽象描述(50-150字，包含模式识别、动因推测和趋势预判)","tags":["标签1","标签2"],"confidence":0.7,"negations":[{"index":0,"absorbed":true},{"index":2,"absorbed":false,"reason":"该记忆讨论的是物流效率，与发现的价格趋势无关"}]}`

const PORTRAIT_PROMPT = `你是一个用户研究专家，专门从行为模式中构建用户画像。

## 任务
阅读以下概念级记忆（每条都是从多个原子事实中抽象出来的），进一步提炼出一个「用户画像片段」——描述用户的某个核心特质、决策模式或深层需求。

## 画像构建规则
1. 聚焦「是谁」而非「做了什么」
   - 错误: "用户关注钢价和天气" (行为描述)
   - 正确: "用户是数据驱动的决策者，通过多维数据交叉验证降低采购风险" (人格画像)
2. 挖掘「决策逻辑」：用户如何做决定？什么因素影响他？
3. 发现「矛盾与张力」：不同行为之间是否存在有趣的张力？
4. 可操作性：这个画像应能指导AI更好地服务用户

## 否定信号（同等重要）
完成画像构建后，对每条概念记忆做判断：它的核心洞察是否已融入画像？
- absorbed=true: 已融入
- absorbed=false: 未融入，写明原因
记录"为什么不选它"的信息密度可能比"为什么选它"更高。

## 输出格式（严格 JSON，不要包裹在代码块中）
{"title":"画像标题(不超过15字)","content":"画像描述(80-200字，包含核心特质、决策模式和服务建议)","tags":["portrait","标签"],"confidence":0.6,"negations":[{"index":0,"absorbed":true},{"index":1,"absorbed":false,"reason":"原因"}]}`

// --- Union-Find ---

class UnionFind {
  private parent: number[]
  private rank: number[]

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.rank = new Array(n).fill(0)
  }

  find(x: number): number {
    if (this.parent[x] !== x) {
      this.parent[x] = this.find(this.parent[x])
    }
    return this.parent[x]
  }

  union(x: number, y: number): void {
    const px = this.find(x)
    const py = this.find(y)
    if (px === py) return
    if (this.rank[px] < this.rank[py]) {
      this.parent[px] = py
    } else if (this.rank[px] > this.rank[py]) {
      this.parent[py] = px
    } else {
      this.parent[py] = px
      this.rank[px]++
    }
  }

  groups(): Map<number, number[]> {
    const map = new Map<number, number[]>()
    for (let i = 0; i < this.parent.length; i++) {
      const root = this.find(i)
      if (!map.has(root)) map.set(root, [])
      map.get(root)!.push(i)
    }
    return map
  }
}

// --- BubbleCompactor ---

const MAX_CLUSTERS_PER_RUN = 20
const MIN_CLUSTER_SIZE = 3
const MAX_CLUSTER_SIZE = 12

export class BubbleCompactor {
  private llm: LLMProvider
  private qualitySignals: Map<string, QualitySignal>
  private lastCompactedAt = 0

  constructor(llm: LLMProvider) {
    this.llm = llm
    this.qualitySignals = new Map()
  }

  /**
   * Compute dynamic similarity threshold based on candidate bubble properties.
   * Low confidence / high density → higher temperature (more aggressive merging).
   * High confidence / low density / wide time spread → lower temperature (conservative).
   */
  private computeTemperature(bubbles: Bubble[]): number {
    const BASE = 0.3

    // Factor 1: average confidence — low confidence → merge more aggressively
    const avgConf = bubbles.reduce((s, b) => s + b.confidence, 0) / bubbles.length
    const confAdjust = avgConf < 0.5 ? 0.1 : avgConf > 0.8 ? -0.1 : 0

    // Factor 2: candidate density — more candidates → need more compression
    const densityAdjust = bubbles.length > 50 ? 0.05 : bubbles.length < 10 ? -0.05 : 0

    // Factor 3: time spread — wider spread → more conservative
    const timestamps = bubbles.map(b => b.createdAt)
    const timeSpread = Math.max(...timestamps) - Math.min(...timestamps)
    const ageAdjust = timeSpread > 30 * 86400000 ? -0.05 : 0

    const temperature = Math.max(0.15, Math.min(0.55, BASE + confAdjust + densityAdjust + ageAdjust))
    logger.debug(`Compactor: temperature=${temperature.toFixed(3)} (avgConf=${avgConf.toFixed(2)}, count=${bubbles.length}, spread=${(timeSpread / 86400000).toFixed(0)}d)`)
    return temperature
  }

  /**
   * Compute quality signal score for a pair of bubbles.
   * Returns 0 if no signals available, positive if both are strengthening evidence, negative if weakening.
   */
  private computeQualityBonus(a: Bubble, b: Bubble): number {
    const sigA = this.qualitySignals.get(a.id)
    const sigB = this.qualitySignals.get(b.id)
    if (!sigA && !sigB) return 0

    let bonus = 0

    // Both bubbles are evidence for strengthening observations → reward clustering
    if (sigA?.observationTrend === 'strengthening' && sigB?.observationTrend === 'strengthening') {
      bonus += 0.1
    }

    // Either bubble is evidence for a weakening observation → penalize
    if (sigA?.observationTrend === 'weakening') bonus -= 0.05
    if (sigB?.observationTrend === 'weakening') bonus -= 0.05

    return bonus
  }

  async compact(spaceId?: string, qualitySignals?: Map<string, QualitySignal>): Promise<CompactionResult> {
    this.qualitySignals = qualitySignals ?? new Map()
    const result: CompactionResult = { synthesized: 0, portrayed: 0, clustersFound: 0, skipped: 0, newBubbleIds: [] }

    // Token short-circuit: skip if no new L0 bubbles since last compaction
    if (this.lastCompactedAt > 0) {
      const db = getDatabase()
      let sql = 'SELECT COUNT(*) as cnt FROM bubbles WHERE abstraction_level = 0 AND created_at > ? AND deleted_at IS NULL'
      const params: unknown[] = [this.lastCompactedAt]
      if (spaceId) { sql += ' AND space_id = ?'; params.push(spaceId) }
      else { sql += ' AND space_id IS NULL' }
      const { cnt } = db.prepare(sql).get(...params) as { cnt: number }
      if (cnt === 0) {
        logger.debug('Compactor: no new L0 bubbles since last run, skipping LLM calls')
        return result
      }
    }
    this.lastCompactedAt = Date.now()

    if (this.qualitySignals.size > 0) {
      logger.info(`Compactor: received ${this.qualitySignals.size} quality signals from Reflector`)
    }

    // Round 1: Level 0 → Level 1 (skip observations — they have their own lifecycle)
    const l0Candidates = findCompactionCandidates(0, spaceId)
      .filter(b => b.type !== 'observation')
    if (l0Candidates.length >= MIN_CLUSTER_SIZE) {
      const temperature = this.computeTemperature(l0Candidates)
      const l0Clusters = this.findClusters(l0Candidates, temperature)
      result.clustersFound += l0Clusters.length

      let processed = 0
      for (const cluster of l0Clusters) {
        if (processed >= MAX_CLUSTERS_PER_RUN) break
        const created = await this.abstractCluster(cluster, 1, temperature)
        if (created) {
          result.synthesized++
          result.newBubbleIds.push(created.id)
          processed++
        } else {
          result.skipped++
        }
      }
    }

    // Round 2: Level 1 → Level 2
    const l1Candidates = findCompactionCandidates(1, spaceId)
    if (l1Candidates.length >= MIN_CLUSTER_SIZE) {
      const temperature = this.computeTemperature(l1Candidates)
      const l1Clusters = this.findClusters(l1Candidates, temperature)
      result.clustersFound += l1Clusters.length

      let processed = 0
      for (const cluster of l1Clusters) {
        if (processed >= MAX_CLUSTERS_PER_RUN) break
        const created = await this.abstractCluster(cluster, 2, temperature)
        if (created) {
          result.portrayed++
          result.newBubbleIds.push(created.id)
          processed++
        } else {
          result.skipped++
        }
      }
    }

    return result
  }

  findClusters(bubbles: Bubble[], threshold: number): BubbleCluster[] {
    const n = bubbles.length
    if (n < MIN_CLUSTER_SIZE) return []

    // Pre-compute neighbor sets for graph link check (1-hop)
    const neighborSets = new Map<string, Set<string>>()
    for (const b of bubbles) {
      neighborSets.set(b.id, getNeighborIds(b.id, 1))
    }

    // Build Union-Find based on pairwise similarity
    const uf = new UnionFind(n)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const sim = this.pairSimilarity(bubbles[i], bubbles[j], neighborSets)
        if (sim > threshold) {
          uf.union(i, j)
        }
      }
    }

    // Extract clusters
    const groups = uf.groups()
    const clusters: BubbleCluster[] = []

    for (const [, indices] of groups) {
      if (indices.length < MIN_CLUSTER_SIZE) continue

      const clusterBubbles = indices.map(i => bubbles[i])

      // Split large clusters by most frequent tag
      if (clusterBubbles.length > MAX_CLUSTER_SIZE) {
        const subClusters = this.splitByTag(clusterBubbles)
        for (const sub of subClusters) {
          if (sub.length >= MIN_CLUSTER_SIZE) {
            clusters.push(this.buildCluster(sub, bubbles, neighborSets))
          }
        }
      } else {
        clusters.push(this.buildCluster(clusterBubbles, bubbles, neighborSets))
      }
    }

    // Sort by cohesion score descending
    clusters.sort((a, b) => b.cohesionScore - a.cohesionScore)
    return clusters
  }

  private pairSimilarity(a: Bubble, b: Bubble, neighborSets: Map<string, Set<string>>): number {
    // Tag Jaccard similarity (weight 0.35)
    const tagsA = new Set(a.tags)
    const tagsB = new Set(b.tags)
    const intersection = [...tagsA].filter(t => tagsB.has(t)).length
    const union = new Set([...tagsA, ...tagsB]).size
    const tagSim = union > 0 ? intersection / union : 0

    // Graph link (weight 0.35)
    const neighborsA = neighborSets.get(a.id)
    const graphSim = neighborsA?.has(b.id) ? 1.0 : 0

    // Time proximity (weight 0.15), 7-day half-life
    const timeDiff = Math.abs(a.createdAt - b.createdAt)
    const timeSim = Math.exp(-timeDiff / (7 * 86400000))

    // Quality signal from Reflector (weight 0.15)
    const qualityBonus = this.computeQualityBonus(a, b)

    return 0.35 * tagSim + 0.35 * graphSim + 0.15 * timeSim + 0.15 * Math.max(0, Math.min(1, 0.5 + qualityBonus))
  }

  private splitByTag(bubbles: Bubble[]): Bubble[][] {
    // Find most frequent tag
    const tagCount = new Map<string, number>()
    for (const b of bubbles) {
      for (const tag of b.tags) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1)
      }
    }

    if (tagCount.size === 0) {
      // No tags — split by time (first half / second half)
      const mid = Math.ceil(bubbles.length / 2)
      return [bubbles.slice(0, mid), bubbles.slice(mid)]
    }

    // Pick the tag that best splits the group (~50/50)
    let bestTag = ''
    let bestBalance = Infinity
    for (const [tag, count] of tagCount) {
      const balance = Math.abs(count - bubbles.length / 2)
      if (balance < bestBalance) {
        bestBalance = balance
        bestTag = tag
      }
    }

    const withTag = bubbles.filter(b => b.tags.includes(bestTag))
    const withoutTag = bubbles.filter(b => !b.tags.includes(bestTag))
    return [withTag, withoutTag].filter(g => g.length > 0)
  }

  private buildCluster(clusterBubbles: Bubble[], _allBubbles: Bubble[], neighborSets: Map<string, Set<string>>): BubbleCluster {
    // Compute shared tags (present in > 50% of cluster bubbles)
    const tagCount = new Map<string, number>()
    for (const b of clusterBubbles) {
      for (const tag of b.tags) {
        tagCount.set(tag, (tagCount.get(tag) || 0) + 1)
      }
    }
    const threshold = clusterBubbles.length / 2
    const sharedTags = [...tagCount.entries()]
      .filter(([, count]) => count > threshold)
      .map(([tag]) => tag)

    // Compute cohesion score (average pairwise similarity)
    let totalSim = 0
    let pairs = 0
    for (let i = 0; i < clusterBubbles.length; i++) {
      for (let j = i + 1; j < clusterBubbles.length; j++) {
        totalSim += this.pairSimilarity(clusterBubbles[i], clusterBubbles[j], neighborSets)
        pairs++
      }
    }

    return {
      bubbles: clusterBubbles,
      sharedTags,
      cohesionScore: pairs > 0 ? totalSim / pairs : 0,
    }
  }

  /**
   * Compute contribution weights for each source bubble in a cluster.
   * Higher confidence → higher contribution weight (normalized to sum=1).
   */
  private computeContributionWeights(bubbles: Bubble[]): Map<string, number> {
    const totalConf = bubbles.reduce((s, b) => s + b.confidence, 0)
    const weights = new Map<string, number>()
    for (const b of bubbles) {
      weights.set(b.id, totalConf > 0 ? b.confidence / totalConf : 1 / bubbles.length)
    }
    return weights
  }

  private async abstractCluster(cluster: BubbleCluster, targetLevel: 1 | 2, temperature: number): Promise<Bubble | null> {
    // Verify all bubbles share the same spaceId
    const spaceIds = new Set(cluster.bubbles.map(b => b.spaceId ?? '_null'))
    if (spaceIds.size > 1) {
      logger.debug('Compactor: skipping cross-space cluster')
      return null
    }
    const spaceId = cluster.bubbles[0].spaceId

    // Compute contribution weights (soft labels)
    const contributionWeights = this.computeContributionWeights(cluster.bubbles)

    // Build the prompt content
    const systemPrompt = targetLevel === 1 ? SYNTHESIS_PROMPT : PORTRAIT_PROMPT
    const bubbleList = cluster.bubbles.map((b, i) => {
      const date = new Date(b.createdAt).toLocaleDateString('zh-CN')
      return targetLevel === 1
        ? `${i + 1}. [${b.title}] ${b.content} (${date})`
        : `${i + 1}. [${b.title}] ${b.content}`
    }).join('\n')

    const userContent = targetLevel === 1
      ? `## 原子记忆（共${cluster.bubbles.length}条）\n${bubbleList}\n\n请执行抽象跃迁：`
      : `## 概念记忆（共${cluster.bubbles.length}条）\n${bubbleList}\n\n请构建用户画像片段：`

    try {
      const messages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]

      const response = await this.llm.chat(messages)
      const text = response.content.trim()

      // Parse JSON from response (handle optional code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.debug('Compactor: no JSON found in LLM response')
        return null
      }

      const parsed = JSON.parse(jsonMatch[0]) as {
        title: string
        content: string
        tags: string[]
        confidence: number
        negations?: Array<{ index: number; absorbed: boolean; reason?: string }>
      }

      if (!parsed.title || !parsed.content) {
        logger.debug('Compactor: invalid LLM output — missing title or content')
        return null
      }

      // Merge tags: LLM output + shared cluster tags
      const mergedTags = [...new Set([
        ...(Array.isArray(parsed.tags) ? parsed.tags : []),
        ...cluster.sharedTags,
      ])]

      // Build provenance metadata (soft labels)
      const sourceIds = cluster.bubbles.map(b => b.id)
      const sourceWeights = sourceIds.map(id => contributionWeights.get(id) ?? 0)
      const provenance: ProvenanceMetadata = {
        sourceIds,
        sourceWeights,
        clusterCohesion: cluster.cohesionScore,
        temperature,
        createdByVersion: 'distill-v1',
      }

      // Parse negation records — the "why not" learning signal
      const rawNegations = Array.isArray(parsed.negations) ? parsed.negations : []
      const negations: NegationRecord[] = rawNegations
        .filter(n => typeof n.index === 'number' && n.index >= 0 && n.index < cluster.bubbles.length)
        .map(n => ({
          sourceIndex: n.index,
          sourceId: cluster.bubbles[n.index].id,
          absorbed: n.absorbed !== false,
          reason: n.absorbed === false ? (n.reason || '未说明') : undefined,
        }))

      const nonAbsorbedCount = negations.filter(n => !n.absorbed).length
      if (negations.length > 0) {
        logger.debug(`Compactor: negation signal — ${negations.length} evaluated, ${nonAbsorbedCount} not absorbed`)
      }

      // Create the higher-level bubble with provenance
      const newBubble = createBubble({
        type: targetLevel === 1 ? 'synthesis' : 'portrait',
        title: parsed.title,
        content: parsed.content,
        tags: mergedTags,
        source: 'compactor',
        confidence: Math.min(1.0, Math.max(0, parsed.confidence ?? (targetLevel === 1 ? 0.7 : 0.6))),
        decayRate: 0.02,
        spaceId,
        abstractionLevel: targetLevel,
        metadata: { provenance, negations } as unknown as Record<string, unknown>,
      })

      // Create composed_of links with differential weights (soft labels)
      for (const child of cluster.bubbles) {
        const weight = contributionWeights.get(child.id) ?? (1 / cluster.bubbles.length)
        addLink(newBubble.id, child.id, 'composed_of', weight, 'system')
      }

      // Check if any source is evidence for a contradicted observation
      const hasContradictions = cluster.bubbles.some(b => {
        const sig = this.qualitySignals.get(b.id)
        return sig?.observationTrend === 'weakening'
      })

      // Adaptive decay acceleration based on contribution weights and negation signals
      this.accelerateDecay(cluster.bubbles, contributionWeights, hasContradictions, negations)

      const levelName = targetLevel === 1 ? 'synthesis' : 'portrait'
      logger.info(`Compactor: created ${levelName} "${newBubble.title}" from ${cluster.bubbles.length} bubbles (temp=${temperature.toFixed(2)}, cohesion=${cluster.cohesionScore.toFixed(2)})`)

      return newBubble
    } catch (err) {
      logger.debug('Compactor: abstraction failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /**
   * Adaptive decay acceleration based on contribution weights and negation signals.
   *
   * Key insight from ocean.md "杀死即学习":
   * - Absorbed children → accelerate decay (their info lives on in the synthesis)
   * - Non-absorbed children → PROTECT from acceleration (their unique info isn't captured)
   *   These carry knowledge the synthesis chose not to include — that's valuable.
   */
  private accelerateDecay(
    children: Bubble[],
    contributionWeights: Map<string, number>,
    hasContradictions: boolean,
    negations: NegationRecord[] = [],
  ): void {
    const BASE_ACCELERATION = 3.0
    const PROTECTION_FACTOR = 4.0
    const nonAbsorbedIds = new Set(negations.filter(n => !n.absorbed).map(n => n.sourceId))

    for (const child of children) {
      // Non-absorbed children: protect from acceleration
      // Their unique information isn't captured by the synthesis — they survive longer
      if (nonAbsorbedIds.has(child.id)) {
        const newRate = Math.max(0.01, child.decayRate * 0.8)
        if (newRate !== child.decayRate) {
          updateBubble(child.id, { decayRate: newRate })
        }
        continue
      }

      const weight = contributionWeights.get(child.id) ?? 0
      // Higher weight → lower acceleration factor → slower decay
      let factor = BASE_ACCELERATION / (1 + weight * PROTECTION_FACTOR)
      // If synthesis has contradictions, halve acceleration to preserve evidence
      if (hasContradictions) factor /= 2

      const newRate = Math.min(0.5, child.decayRate * factor)
      if (newRate !== child.decayRate) {
        updateBubble(child.id, { decayRate: newRate })
      }
    }
  }
}
