/**
 * Evidence Chain — builds a tree of supporting evidence for any bubble.
 *
 * Walks composed_of / references / supports links recursively to show
 * where a piece of knowledge comes from and what supports it.
 */

import type { Bubble } from '../shared/types.js'
import { getBubble } from '../bubble/model.js'
import { getDatabase } from '../storage/database.js'

// ── Types ──────────────────────────────────────────────────────

export interface EvidenceNode {
  bubble: Bubble
  relation: string
  depth: number
  children: EvidenceNode[]
}

export interface EvidenceTree {
  root: Bubble
  nodes: EvidenceNode[]
  totalCount: number
  oldestEvidence: number
  newestEvidence: number
  sourceBreakdown: Record<string, number>
}

// ── Constants ──────────────────────────────────────────────────

const EVIDENCE_RELATIONS = new Set(['composed_of', 'references', 'supports'])
const MAX_DEPTH = 5
const MAX_NODES = 200

// ── Builder ────────────────────────────────────────────────────

export function buildEvidenceChain(bubbleId: string, maxDepth = MAX_DEPTH): EvidenceTree | null {
  const root = getBubble(bubbleId)
  if (!root) return null

  const db = getDatabase()
  const visited = new Set<string>([bubbleId])
  const allNodes: EvidenceNode[] = []
  let oldest = Infinity
  let newest = 0
  const sourceCount: Record<string, number> = {}

  function walk(parentId: string, depth: number): EvidenceNode[] {
    if (depth >= maxDepth || allNodes.length >= MAX_NODES) return []

    // Find bubbles that point TO this parent via evidence relations
    const rows = db.prepare(`
      SELECT source_id, relation FROM bubble_links
      WHERE target_id = ? AND relation IN ('composed_of', 'references', 'supports')
    `).all(parentId) as Array<{ source_id: string; relation: string }>

    const children: EvidenceNode[] = []
    for (const row of rows) {
      if (visited.has(row.source_id) || allNodes.length >= MAX_NODES) continue
      visited.add(row.source_id)

      const bubble = getBubble(row.source_id)
      if (!bubble) continue

      // Track stats
      if (bubble.createdAt < oldest) oldest = bubble.createdAt
      if (bubble.createdAt > newest) newest = bubble.createdAt
      sourceCount[bubble.source] = (sourceCount[bubble.source] || 0) + 1

      const node: EvidenceNode = {
        bubble,
        relation: row.relation,
        depth,
        children: [],
      }
      allNodes.push(node)

      // Recurse
      node.children = walk(row.source_id, depth + 1)
      children.push(node)
    }

    return children
  }

  const topChildren = walk(bubbleId, 1)

  return {
    root,
    nodes: topChildren,
    totalCount: allNodes.length,
    oldestEvidence: oldest === Infinity ? root.createdAt : oldest,
    newestEvidence: newest || root.createdAt,
    sourceBreakdown: sourceCount,
  }
}
