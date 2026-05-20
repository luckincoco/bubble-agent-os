import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble } from '../../bubble/model.js'
import { logger } from '../../shared/logger.js'
import type { OrientationNode, OrientationSnapshot } from '../../cognition/orientation-graph.js'

/**
 * Orientation Snapshot — daily rebuild of the cognitive landscape.
 * Outputs a Memory Wiki formatted document for context pre-loading,
 * inspired by the Karpathy "LLM Wiki" pattern from the OpenClaw community.
 *
 * The wiki replaces cold-start exploration with a pre-compiled cognitive
 * context document, reducing per-session token usage by ~90%.
 */
export async function executeOrientationSnapshot(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  if (!deps.orientationGraph) {
    return { success: true, message: '认知快照: OrientationGraph 未启用' }
  }

  const db = getDatabase()
  const spaceRows = db.prepare(
    'SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL AND deleted_at IS NULL',
  ).all() as Array<{ space_id: string }>

  let totalNodes = 0
  let totalFrontiers = 0
  let totalTensions = 0
  const allSnapshots: OrientationSnapshot[] = []

  for (const row of spaceRows) {
    try {
      const snapshot = await deps.orientationGraph.buildSnapshot(row.space_id)
      totalNodes += snapshot.nodes.length
      totalFrontiers += snapshot.frontiers.length
      totalTensions += snapshot.tensions.length
      allSnapshots.push(snapshot)
    } catch (err) {
      logger.error(`OrientationSnapshot failed for space ${row.space_id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  // Also build for default/no-space bubbles
  try {
    const snapshot = await deps.orientationGraph.buildSnapshot('default')
    totalNodes += snapshot.nodes.length
    totalFrontiers += snapshot.frontiers.length
    totalTensions += snapshot.tensions.length
    allSnapshots.push(snapshot)
  } catch (err) {
    logger.debug(`OrientationSnapshot default space: ${err instanceof Error ? err.message : String(err)}`)
  }

  // ── P0: Generate Memory Wiki ──────────────────────────────────
  if (allSnapshots.length > 0) {
    const wiki = buildCognitiveWiki(allSnapshots)

    // Upsert the wiki bubble — replace previous day's wiki
    const existingWiki = db.prepare(
      `SELECT id FROM bubbles WHERE type = 'event' AND json_extract(metadata, '$.wikiType') = 'cognitive-wiki' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    ).get() as { id: string } | undefined

    if (existingWiki) {
      db.prepare('UPDATE bubbles SET content = ?, metadata = json_set(metadata, "$.builtAt", ?), updated_at = ? WHERE id = ?')
        .run(wiki, Date.now(), Date.now(), existingWiki.id)
    } else {
      createBubble({
        type: 'event',
        title: '认知全景 — Cognitive Wiki',
        content: wiki,
        tags: ['cognitive-wiki', 'memory-wiki', 'orientation'],
        source: 'orientation-snapshot',
        confidence: 0.9,
        decayRate: 0.01,
        metadata: { wikiType: 'cognitive-wiki', builtAt: Date.now() },
      })
    }
    logger.info('OrientationSnapshot: cognitive wiki updated')
  }

  const message = `认知快照: ${totalNodes} 节点, ${totalFrontiers} 前沿, ${totalTensions} 张力, wiki已更新`
  logger.info(`OrientationSnapshot: ${message}`)

  return { success: true, message }
}

// ── Memory Wiki Builder ───────────────────────────────────────────

function buildCognitiveWiki(snapshots: OrientationSnapshot[]): string {
  const now = new Date()
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

  const sections: string[] = []

  // PROFILE section — cognitive identity
  sections.push(`# 认知全景 (${dateStr})\n`)
  sections.push(`## 认知概览\n`)

  const totalNodes = snapshots.reduce((s, snap) => s + snap.nodes.length, 0)
  const totalFrontiers = snapshots.reduce((s, snap) => s + snap.frontiers.length, 0)
  const totalTensions = snapshots.reduce((s, snap) => s + snap.tensions.length, 0)
  const spaces = snapshots.map(s => s.spaceId).filter(s => s !== 'default')

  sections.push(`- 认知节点: ${totalNodes}`)
  sections.push(`- 认知前沿: ${totalFrontiers}`)
  sections.push(`- 认知张力: ${totalTensions}`)
  sections.push(`- 活跃空间: ${spaces.length > 0 ? spaces.join(', ') : '默认空间'}`)
  sections.push('')

  // DOMAINS section — established knowledge
  sections.push(`## 已建立的认知 (Established)\n`)
  const established = snapshots.flatMap(s => s.nodes.filter(n => n.band === 'established'))
  if (established.length > 0) {
    for (const node of established) {
      sections.push(`- **${node.domain}** (置信度 ${(1 - node.gapScore).toFixed(2)}, 新鲜度 ${node.freshness}天)`)
    }
  } else {
    sections.push(`_暂无已建立的认知节点_`)
  }
  sections.push('')

  // GROUNDED section — solid but not yet established
  sections.push(`## 扎实认知 (Grounded)\n`)
  const grounded = snapshots.flatMap(s => s.nodes.filter(n => n.band === 'grounded'))
  if (grounded.length > 0) {
    for (const node of grounded.slice(0, 10)) {
      const deps = node.dependsOn.length > 0 ? ` [依赖: ${node.dependsOn.length}个]` : ''
      sections.push(`- ${node.domain}${deps}`)
    }
  } else {
    sections.push(`_暂无扎实认知节点_`)
  }
  sections.push('')

  // FRONTIERS section — where to explore next
  sections.push(`## 认知前沿 (Frontiers) — 搜索引导\n`)
  sections.push(`以下领域认知薄弱或过时，优先补充：\n`)
  const allFrontiers = snapshots.flatMap(s => s.frontiers)
  if (allFrontiers.length > 0) {
    for (const f of deduplicateNodes(allFrontiers).slice(0, 8)) {
      sections.push(`- **${f.domain}** — gap=${f.gapScore.toFixed(2)}, ${f.freshness}天未更新, band=${f.band}`)
    }
  } else {
    sections.push(`_暂无明显认知缺口_`)
  }
  sections.push('')

  // TENSIONS section — contradictions to resolve
  sections.push(`## 认知张力 (Tensions) — 待解决矛盾\n`)
  const allTensions = snapshots.flatMap(s => s.tensions)
  if (allTensions.length > 0) {
    for (const t of allTensions.slice(0, 5)) {
      const nodeA = snapshots.flatMap(s => s.nodes).find(n => n.observationId === t.a)
      const nodeB = snapshots.flatMap(s => s.nodes).find(n => n.observationId === t.b)
      sections.push(`- **${nodeA?.domain || t.a}** vs **${nodeB?.domain || t.b}**: ${t.reason}`)
    }
  } else {
    sections.push(`_暂无认知矛盾_`)
  }
  sections.push('')

  // AVOID section — don't waste tokens on these
  sections.push(`## 搜索回避 (Avoid) — 无需重复搜索\n`)
  const avoid = snapshots.flatMap(s =>
    s.nodes.filter(n => n.band === 'established' && n.freshness < 7),
  )
  if (avoid.length > 0) {
    sections.push(`以下领域近期已充分覆盖：`)
    for (const a of deduplicateNodes(avoid).slice(0, 5)) {
      sections.push(`- ${a.domain} (${a.freshness}天前更新)`)
    }
  } else {
    sections.push(`_暂无需回避的领域_`)
  }
  sections.push('')

  // DECISIONS section — key cognitive decisions (from internalization proposals)
  sections.push(`## 认知决策记录 (Decisions)\n`)
  try {
    const db = getDatabase()
    const decisions = db.prepare(
      `SELECT title, content, metadata, updated_at FROM bubbles
       WHERE json_extract(metadata, '$.proposalId') IS NOT NULL
       AND json_extract(metadata, '$.status') = 'approved'
       AND deleted_at IS NULL
       ORDER BY updated_at DESC LIMIT 10`,
    ).all() as Array<{ title: string; content: string; metadata: string; updated_at: number }>

    if (decisions.length > 0) {
      for (const d of decisions) {
        const date = new Date(d.updated_at)
        const dStr = `${date.getMonth() + 1}/${date.getDate()}`
        sections.push(`- [${dStr}] ${d.title}`)
      }
    } else {
      sections.push(`_暂无已批准的认知决策_`)
    }
  } catch {
    sections.push(`_决策记录查询失败_`)
  }

  return sections.join('\n')
}

function deduplicateNodes(nodes: OrientationNode[]): OrientationNode[] {
  const seen = new Set<string>()
  return nodes.filter(n => {
    if (seen.has(n.domain)) return false
    seen.add(n.domain)
    return true
  })
}
