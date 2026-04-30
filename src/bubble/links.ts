import type { Bubble, BubbleLink } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'
import { getBubble } from './model.js'

export function addLink(sourceId: string, targetId: string, relation: string, weight = 1.0, linkSource = 'system'): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sourceId, targetId, relation, weight, linkSource, Date.now())
}

export function getLinks(bubbleId: string): BubbleLink[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT target_id, relation, weight, link_source, created_at
    FROM bubble_links WHERE source_id = ?
    UNION
    SELECT source_id, relation, weight, link_source, created_at
    FROM bubble_links WHERE target_id = ?
  `).all(bubbleId, bubbleId) as any[]

  return rows.map((r) => ({
    targetId: r.target_id,
    relation: r.relation,
    weight: r.weight,
    source: r.link_source,
    createdAt: r.created_at,
  }))
}

/** Update the weight of an existing link */
export function updateLinkWeight(sourceId: string, targetId: string, relation: string, newWeight: number): boolean {
  const db = getDatabase()
  const result = db.prepare(`
    UPDATE bubble_links SET weight = ?
    WHERE source_id = ? AND target_id = ? AND relation = ?
  `).run(newWeight, sourceId, targetId, relation)
  return result.changes > 0
}

/** Find all links of a given relation type, optionally filtered by source */
export function findLinksByRelation(relation: string, sourceId?: string): BubbleLink[] {
  const db = getDatabase()
  let sql = 'SELECT source_id, target_id, relation, weight, link_source, created_at FROM bubble_links WHERE relation = ?'
  const params: unknown[] = [relation]

  if (sourceId) {
    sql += ' AND source_id = ?'
    params.push(sourceId)
  }

  const rows = db.prepare(sql).all(...params) as any[]
  return rows.map((r) => ({
    targetId: r.target_id,
    relation: r.relation,
    weight: r.weight,
    source: r.link_source,
    createdAt: r.created_at,
  }))
}

/** Get IDs of bubbles connected within N hops */
export function getNeighborIds(bubbleId: string, maxHops = 2): Set<string> {
  const visited = new Set<string>()
  const queue: { id: string; depth: number }[] = [{ id: bubbleId, depth: 0 }]

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    if (depth >= maxHops) continue

    const links = getLinks(id)
    for (const link of links) {
      if (!visited.has(link.targetId)) {
        queue.push({ id: link.targetId, depth: depth + 1 })
      }
    }
  }

  visited.delete(bubbleId) // don't include self
  return visited
}

/** Get a graph subset centered on a bubble, with all nodes and links within N hops */
export function getGraphSubset(
  centerId: string,
  depth = 2,
  spaceId?: string,
): { center: Bubble | null; nodes: Bubble[]; links: Array<{ sourceId: string; targetId: string; relation: string; weight: number }> } {
  const center = getBubble(centerId)
  if (!center) return { center: null, nodes: [], links: [] }

  const neighborIds = getNeighborIds(centerId, Math.min(depth, 3))
  const allIds = new Set([centerId, ...neighborIds])

  // Cap at 200 nodes
  const idArray = [...allIds].slice(0, 200)

  // Batch fetch bubbles
  const nodes: Bubble[] = []
  for (const id of idArray) {
    const b = getBubble(id)
    if (!b) continue
    if (spaceId && b.spaceId !== spaceId) continue
    nodes.push(b)
  }

  const nodeIdSet = new Set(nodes.map(n => n.id))

  // Fetch links between these nodes
  const db = getDatabase()
  const links: Array<{ sourceId: string; targetId: string; relation: string; weight: number }> = []

  for (const id of nodeIdSet) {
    const rows = db.prepare(
      'SELECT source_id, target_id, relation, weight FROM bubble_links WHERE source_id = ? OR target_id = ?',
    ).all(id, id) as Array<{ source_id: string; target_id: string; relation: string; weight: number }>

    for (const r of rows) {
      if (nodeIdSet.has(r.source_id) && nodeIdSet.has(r.target_id)) {
        // Dedup: only add if source_id matches current id (avoid double-counting)
        if (r.source_id === id) {
          links.push({ sourceId: r.source_id, targetId: r.target_id, relation: r.relation, weight: r.weight })
        }
      }
    }
  }

  return { center, nodes, links }
}

