/**
 * Draft Observations — 自主思考待审机制
 *
 * Reflector / InterestSearch 产出的 observation 先写入 draft 表，
 * 等待用户审批后才升级为正式 observation。
 * draft 状态的内容不参与后续推理，防止未验证认知形成闭环。
 */

import { getDatabase } from '../storage/database.js'
import { createBubble } from '../bubble/model.js'
import type { BubbleType } from '../shared/types.js'
import { ulid } from 'ulid'
import { logger } from '../shared/logger.js'

export interface DraftObservation {
  id: string
  content: string
  source: string
  context: string
  spaceId: string
  createdAt: number
}

/** 写入一条 draft observation */
export function createDraft(input: {
  content: string
  source: string
  context?: string
  spaceId: string
}): DraftObservation {
  const db = getDatabase()
  const id = ulid()
  const now = Date.now()
  db.prepare(
    'INSERT INTO draft_observations (id, content, source, context, space_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, input.content, input.source, input.context ?? '', input.spaceId, now)
  logger.info(`Draft observation created: ${id} (source=${input.source})`)
  return { id, content: input.content, source: input.source, context: input.context ?? '', spaceId: input.spaceId, createdAt: now }
}

/** 列出所有待审 drafts */
export function listDrafts(spaceId?: string): DraftObservation[] {
  const db = getDatabase()
  const sql = spaceId
    ? 'SELECT * FROM draft_observations WHERE space_id = ? ORDER BY created_at DESC'
    : 'SELECT * FROM draft_observations ORDER BY created_at DESC'
  const rows = (spaceId ? db.prepare(sql).all(spaceId) : db.prepare(sql).all()) as Array<{
    id: string; content: string; source: string; context: string; space_id: string; created_at: number
  }>
  return rows.map(r => ({
    id: r.id,
    content: r.content,
    source: r.source,
    context: r.context,
    spaceId: r.space_id,
    createdAt: r.created_at,
  }))
}

/** 确认 draft -> 创建正式 observation bubble */
export function confirmDraft(draftId: string): string | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM draft_observations WHERE id = ?').get(draftId) as {
    id: string; content: string; source: string; context: string; space_id: string; created_at: number
  } | undefined
  if (!row) return null

  const obs = createBubble({
    type: 'observation' as BubbleType,
    title: row.content.slice(0, 60),
    content: row.content,
    tags: ['observation', 'auto-draft-reviewed'],
    source: 'auto-draft-reviewed',
    confidence: 0.6,
    decayRate: 0.05,
    spaceId: row.space_id,
    abstractionLevel: 1,
    metadata: {
      trend: 'new',
      evidenceIds: [],
      evidenceCount: 0,
      firstSeen: row.created_at,
      lastSeen: Date.now(),
      reviewCount: 1,
      draftSource: row.source,
      draftContext: row.context,
    },
  })

  db.prepare('DELETE FROM draft_observations WHERE id = ?').run(draftId)
  logger.info(`Draft ${draftId} confirmed -> observation ${obs.id}`)
  return obs.id
}

/** 拒绝（删除）draft */
export function rejectDraft(draftId: string): boolean {
  const db = getDatabase()
  const result = db.prepare('DELETE FROM draft_observations WHERE id = ?').run(draftId)
  if (result.changes > 0) {
    logger.info(`Draft ${draftId} rejected and deleted`)
    return true
  }
  return false
}

/** 获取 draft 数量 */
export function countDrafts(spaceId?: string): number {
  const db = getDatabase()
  const sql = spaceId
    ? 'SELECT COUNT(*) as cnt FROM draft_observations WHERE space_id = ?'
    : 'SELECT COUNT(*) as cnt FROM draft_observations'
  const row = (spaceId ? db.prepare(sql).get(spaceId) : db.prepare(sql).get()) as { cnt: number }
  return row.cnt
}
