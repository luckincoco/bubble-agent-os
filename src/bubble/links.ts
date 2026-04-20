import type { BubbleLink } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'

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
