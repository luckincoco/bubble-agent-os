/**
 * Document lifecycle engine (v0.6).
 * Handles status transitions, document linking, completion checks, and amendments.
 */

import { getDatabase } from '../../storage/database.js'
import { ulid } from 'ulid'
import { logger } from '../../shared/logger.js'
import type { DocStatus, DocLink } from './schema.js'

function now(): number { return Date.now() }

/** Convert snake_case DB row to camelCase */
function toCamel<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    if (key === 'metadata' || key === 'related_ids') {
      try { result[camel] = JSON.parse(val as string) } catch { result[camel] = val }
    } else {
      result[camel] = val
    }
  }
  return result as T
}

// Map docType shorthand to actual table name
const TABLE_MAP: Record<string, string> = {
  trade: 'biz_trades',
  purchase: 'biz_purchases',
  sale: 'biz_sales',
  logistics: 'biz_logistics',
  payment: 'biz_payments',
  invoice: 'biz_invoices',
}

function resolveTable(docType: string): string {
  const table = TABLE_MAP[docType]
  if (!table) throw new Error(`Unknown docType: ${docType}`)
  return table
}

// ── Status Transition ───────────────────────────────────────────────

const VALID_TRANSITIONS: Record<DocStatus, DocStatus[]> = {
  draft: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'cancelled'],
  completed: ['cancelled'],
  cancelled: [],
}

export interface TransitionResult {
  ok: boolean
  error?: string
}

export function transitionStatus(
  docType: string,
  id: string,
  newStatus: DocStatus,
  cancelReason?: string,
): TransitionResult {
  const table = resolveTable(docType)
  const db = getDatabase()

  const row = db.prepare(`SELECT doc_status FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as { doc_status: string } | undefined
  if (!row) return { ok: false, error: '单据不存在' }

  const current = row.doc_status as DocStatus
  const allowed = VALID_TRANSITIONS[current]
  if (!allowed || !allowed.includes(newStatus)) {
    return { ok: false, error: `不允许从「${current}」转为「${newStatus}」` }
  }

  if (newStatus === 'cancelled' && !cancelReason) {
    return { ok: false, error: '取消操作需要填写原因' }
  }

  const fields = ['doc_status = ?', 'updated_at = ?']
  const values: unknown[] = [newStatus, now()]
  if (cancelReason) {
    fields.push('cancel_reason = ?')
    values.push(cancelReason)
  }
  values.push(id)

  db.prepare(`UPDATE ${table} SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  logger.info(`DocEngine: ${docType}/${id} transitioned ${current} → ${newStatus}`)

  // Auto-check parent completion when a child is confirmed/completed
  if ((newStatus === 'confirmed' || newStatus === 'completed')) {
    autoCheckParentCompletion(docType, id)
  }

  return { ok: true }
}

// ── Document Linking ────────────────────────────────────────────────

export function createDocLink(
  sourceType: string,
  sourceId: string,
  targetType: string,
  targetId: string,
): DocLink {
  const db = getDatabase()
  const id = ulid()
  const ts = now()
  db.prepare(`
    INSERT INTO biz_doc_links (id, source_type, source_id, target_type, target_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sourceType, sourceId, targetType, targetId, ts)
  return { id, sourceType, sourceId, targetType, targetId, createdAt: ts }
}

export function getLinkedDocs(docType: string, docId: string): { children: DocLink[]; parents: DocLink[] } {
  const db = getDatabase()
  const children = (db.prepare(
    'SELECT * FROM biz_doc_links WHERE source_type = ? AND source_id = ?',
  ).all(docType, docId) as Record<string, unknown>[]).map(r => toCamel<DocLink>(r))

  const parents = (db.prepare(
    'SELECT * FROM biz_doc_links WHERE target_type = ? AND target_id = ?',
  ).all(docType, docId) as Record<string, unknown>[]).map(r => toCamel<DocLink>(r))

  return { children, parents }
}

// ── Completion Check ────────────────────────────────────────────────

/**
 * After a child document transitions, check if the parent is fully fulfilled.
 * If all children are confirmed/completed, auto-promote parent to completed.
 */
function autoCheckParentCompletion(childDocType: string, childDocId: string) {
  const db = getDatabase()
  // Find parent links where this child is the target
  const parentLinks = db.prepare(
    'SELECT source_type, source_id FROM biz_doc_links WHERE target_type = ? AND target_id = ?',
  ).all(childDocType, childDocId) as Array<{ source_type: string; source_id: string }>

  for (const link of parentLinks) {
    const parentTable = TABLE_MAP[link.source_type]
    if (!parentTable) continue

    // Check parent status — only auto-complete if it's confirmed
    const parent = db.prepare(`SELECT doc_status FROM ${parentTable} WHERE id = ?`).get(link.source_id) as { doc_status: string } | undefined
    if (!parent || parent.doc_status !== 'confirmed') continue

    // Get all children of this parent
    const allChildren = db.prepare(
      'SELECT target_type, target_id FROM biz_doc_links WHERE source_type = ? AND source_id = ?',
    ).all(link.source_type, link.source_id) as Array<{ target_type: string; target_id: string }>

    if (allChildren.length === 0) continue

    // Check if all children are confirmed or completed
    let allDone = true
    for (const child of allChildren) {
      const childTable = TABLE_MAP[child.target_type]
      if (!childTable) { allDone = false; break }
      const childRow = db.prepare(`SELECT doc_status FROM ${childTable} WHERE id = ?`).get(child.target_id) as { doc_status: string } | undefined
      if (!childRow || (childRow.doc_status !== 'confirmed' && childRow.doc_status !== 'completed')) {
        allDone = false
        break
      }
    }

    if (allDone) {
      db.prepare(`UPDATE ${parentTable} SET doc_status = 'completed', updated_at = ? WHERE id = ?`).run(now(), link.source_id)
      logger.info(`DocEngine: auto-completed ${link.source_type}/${link.source_id} (all children done)`)
    }
  }
}

// ── Amendment ───────────────────────────────────────────────────────

export interface AmendResult {
  ok: boolean
  newId?: string
  error?: string
}

export function amendDocument(docType: string, id: string): AmendResult {
  const table = resolveTable(docType)
  const db = getDatabase()

  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as Record<string, unknown> | undefined
  if (!row) return { ok: false, error: '单据不存在' }

  if (row.doc_status !== 'confirmed') {
    return { ok: false, error: '只有已确认的单据可以修正' }
  }

  const newId = ulid()
  const ts = now()

  // Copy all columns except id, doc_status, cancel_reason, amended_from, timestamps
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  const colNames = cols.map(c => c.name).filter(n => n !== 'id' && n !== 'doc_status' && n !== 'cancel_reason' && n !== 'amended_from' && n !== 'created_at' && n !== 'updated_at' && n !== 'deleted_at')

  const selectCols = colNames.map(c => `"${c}"`).join(', ')
  const insertCols = ['id', ...colNames, 'doc_status', 'amended_from', 'created_at', 'updated_at'].map(c => `"${c}"`).join(', ')

  // Use INSERT...SELECT to copy the row
  const sourceValues = db.prepare(`SELECT ${selectCols} FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>
  if (!sourceValues) return { ok: false, error: '读取原单据失败' }

  const vals = colNames.map(c => sourceValues[c])
  const insertPlaceholders = ['id', ...colNames, 'doc_status', 'amended_from', 'created_at', 'updated_at'].map(() => '?').join(', ')

  db.prepare(`INSERT INTO ${table} (${insertCols}) VALUES (${insertPlaceholders})`).run(
    newId, ...vals, 'draft', id, ts, ts,
  )

  // Cancel the original
  db.prepare(`UPDATE ${table} SET doc_status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`).run(
    `已修正，见修正单 ${newId}`, ts, id,
  )

  logger.info(`DocEngine: amended ${docType}/${id} → new draft ${newId}`)
  return { ok: true, newId }
}

// ── Enforce draft-only edits ────────────────────────────────────────

export function assertDraft(docType: string, id: string): { ok: boolean; error?: string } {
  const table = resolveTable(docType)
  const db = getDatabase()
  const row = db.prepare(`SELECT doc_status FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as { doc_status: string } | undefined
  if (!row) return { ok: false, error: '单据不存在' }
  if (row.doc_status !== 'draft') {
    return { ok: false, error: '只有草稿状态的单据可以编辑' }
  }
  return { ok: true }
}

export function assertDraftForDelete(docType: string, id: string): { ok: boolean; error?: string } {
  const table = resolveTable(docType)
  const db = getDatabase()
  const row = db.prepare(`SELECT doc_status FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(id) as { doc_status: string } | undefined
  if (!row) return { ok: false, error: '单据不存在' }
  if (row.doc_status !== 'draft') {
    return { ok: false, error: '只有草稿状态的单据可以删除，已确认单据请使用取消操作' }
  }
  return { ok: true }
}
