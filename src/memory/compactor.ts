import type { Bubble, LLMProvider, LLMMessage } from '../shared/types.js'
import { createBubble, findCompactionCandidates, updateBubble } from '../bubble/model.js'
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

## 输出格式（严格 JSON，不要包裹在代码块中）
{"title":"概念标题(不超过20字)","content":"抽象描述(50-150字，包含模式识别、动因推测和趋势预判)","tags":["标签1","标签2"],"confidence":0.7}`

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

## 输出格式（严格 JSON，不要包裹在代码块中）
{"title":"画像标题(不超过15字)","content":"画像描述(80-200字，包含核心特质、决策模式和服务建议)","tags":["portrait","标签"],"confidence":0.6}`

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
const SIMILARITY_THRESHOLD = 0.3

export class BubbleCompactor {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  async compact(spaceId?: string): Promise<CompactionResult> {
    const result: CompactionResult = { synthesized: 0, portrayed: 0, clustersFound: 0, skipped: 0 }

    // Round 1: Level 0 → Level 1 (skip observations — they have their own lifecycle)
    const l0Candidates = findCompactionCandidates(0, spaceId)
      .filter(b => b.type !== 'observation')
    if (l0Candidates.length >= MIN_CLUSTER_SIZE) {
      const l0Clusters = this.findClusters(l0Candidates)
      result.clustersFound += l0Clusters.length

      let processed = 0
      for (const cluster of l0Clusters) {
        if (processed >= MAX_CLUSTERS_PER_RUN) break
        const created = await this.abstractCluster(cluster, 1)
        if (created) {
          result.synthesized++
          processed++
        } else {
          result.skipped++
        }
      }
    }

    // Round 2: Level 1 → Level 2
    const l1Candidates = findCompactionCandidates(1, spaceId)
    if (l1Candidates.length >= MIN_CLUSTER_SIZE) {
      const l1Clusters = this.findClusters(l1Candidates)
      result.clustersFound += l1Clusters.length

      let processed = 0
      for (const cluster of l1Clusters) {
        if (processed >= MAX_CLUSTERS_PER_RUN) break
        const created = await this.abstractCluster(cluster, 2)
        if (created) {
          result.portrayed++
          processed++
        } else {
          result.skipped++
        }
      }
    }

    return result
  }

  findClusters(bubbles: Bubble[]): BubbleCluster[] {
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
        if (sim > SIMILARITY_THRESHOLD) {
          uf.union(i, j)
        }
      }
    }

    // Extract clusters
    const groups = uf.groups()
    const clusters: BubbleCluster[] = []

    for (const [, indices] of groups) {
      if (indices.length < MIN_CLUSTER_SIZE) continue

      let clusterBubbles = indices.map(i => bubbles[i])

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
    // Tag Jaccard similarity (weight 0.4)
    const tagsA = new Set(a.tags)
    const tagsB = new Set(b.tags)
    const intersection = [...tagsA].filter(t => tagsB.has(t)).length
    const union = new Set([...tagsA, ...tagsB]).size
    const tagSim = union > 0 ? intersection / union : 0

    // Graph link (weight 0.4)
    const neighborsA = neighborSets.get(a.id)
    const graphSim = neighborsA?.has(b.id) ? 1.0 : 0

    // Time proximity (weight 0.2), 7-day half-life
    const timeDiff = Math.abs(a.createdAt - b.createdAt)
    const timeSim = Math.exp(-timeDiff / (7 * 86400000))

    return 0.4 * tagSim + 0.4 * graphSim + 0.2 * timeSim
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

  private async abstractCluster(cluster: BubbleCluster, targetLevel: 1 | 2): Promise<Bubble | null> {
    // Verify all bubbles share the same spaceId
    const spaceIds = new Set(cluster.bubbles.map(b => b.spaceId ?? '_null'))
    if (spaceIds.size > 1) {
      logger.debug('Compactor: skipping cross-space cluster')
      return null
    }
    const spaceId = cluster.bubbles[0].spaceId

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

      // Create the higher-level bubble
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
      })

      // Create composed_of links (parent → child)
      for (const child of cluster.bubbles) {
        addLink(newBubble.id, child.id, 'composed_of', 1.0, 'system')
      }

      // Accelerate decay of child bubbles
      this.accelerateDecay(cluster.bubbles)

      const levelName = targetLevel === 1 ? 'synthesis' : 'portrait'
      logger.info(`Compactor: created ${levelName} "${newBubble.title}" from ${cluster.bubbles.length} bubbles`)

      return newBubble
    } catch (err) {
      logger.debug('Compactor: abstraction failed:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  private accelerateDecay(children: Bubble[]): void {
    for (const child of children) {
      const newRate = Math.min(0.5, child.decayRate * 3)
      if (newRate !== child.decayRate) {
        updateBubble(child.id, { decayRate: newRate })
      }
    }
  }
}
