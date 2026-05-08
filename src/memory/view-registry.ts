/**
 * ViewRegistry — CRUD for memory_views and view_bindings tables.
 * Manages role-based data projection configurations.
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { MemoryView, ViewFilter } from '../shared/types.js'

interface ViewRow {
  id: string
  name: string
  description: string | null
  role_pattern: string
  filters: string
  priority: number
  created_at: number
}

function rowToView(row: ViewRow): MemoryView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rolePattern: row.role_pattern,
    filters: JSON.parse(row.filters) as ViewFilter,
    priority: row.priority,
    createdAt: row.created_at,
  }
}

// ── View CRUD ───────────────────────────────────────────────────

export function getViewById(viewId: string): MemoryView | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM memory_views WHERE id = ?').get(viewId) as ViewRow | undefined
  return row ? rowToView(row) : null
}

export function getViewByName(name: string): MemoryView | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM memory_views WHERE name = ?').get(name) as ViewRow | undefined
  return row ? rowToView(row) : null
}

export function getViewByRole(rolePattern: string): MemoryView | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM memory_views WHERE role_pattern = ? ORDER BY priority DESC LIMIT 1').get(rolePattern) as ViewRow | undefined
  return row ? rowToView(row) : null
}

export function getAllViews(): MemoryView[] {
  const db = getDatabase()
  const rows = db.prepare('SELECT * FROM memory_views ORDER BY priority DESC').all() as ViewRow[]
  return rows.map(rowToView)
}

export function createView(input: { name: string; description?: string; rolePattern: string; filters: ViewFilter; priority?: number }): MemoryView {
  const db = getDatabase()
  const id = ulid()
  const now = Date.now()

  db.prepare(`
    INSERT INTO memory_views (id, name, description, role_pattern, filters, priority, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.name, input.description ?? null, input.rolePattern, JSON.stringify(input.filters), input.priority ?? 0, now)

  return { id, name: input.name, description: input.description ?? null, rolePattern: input.rolePattern, filters: input.filters, priority: input.priority ?? 0, createdAt: now }
}

export function updateView(viewId: string, updates: Partial<{ name: string; description: string; filters: ViewFilter; priority: number }>): void {
  const db = getDatabase()
  const sets: string[] = []
  const params: unknown[] = []

  if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name) }
  if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description) }
  if (updates.filters !== undefined) { sets.push('filters = ?'); params.push(JSON.stringify(updates.filters)) }
  if (updates.priority !== undefined) { sets.push('priority = ?'); params.push(updates.priority) }

  if (sets.length === 0) return
  params.push(viewId)
  db.prepare(`UPDATE memory_views SET ${sets.join(', ')} WHERE id = ?`).run(...params)
}

// ── View Bindings ───────────────────────────────────────────────

export function bindEntityToView(entityType: 'user' | 'external_contact', entityId: string, viewId: string): void {
  const db = getDatabase()
  const id = ulid()
  db.prepare(`
    INSERT OR IGNORE INTO view_bindings (id, entity_type, entity_id, view_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, entityType, entityId, viewId, Date.now())
}

export function unbindEntityFromView(entityType: 'user' | 'external_contact', entityId: string, viewId: string): void {
  const db = getDatabase()
  db.prepare('DELETE FROM view_bindings WHERE entity_type = ? AND entity_id = ? AND view_id = ?').run(entityType, entityId, viewId)
}

export function getViewsForEntity(entityType: 'user' | 'external_contact', entityId: string): MemoryView[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT mv.* FROM memory_views mv
    JOIN view_bindings vb ON vb.view_id = mv.id
    WHERE vb.entity_type = ? AND vb.entity_id = ?
    ORDER BY mv.priority DESC
  `).all(entityType, entityId) as ViewRow[]
  return rows.map(rowToView)
}

/**
 * Resolve the effective view for an entity.
 * Returns the highest-priority bound view, or the role-based default.
 */
export function resolveEffectiveView(entityType: 'user' | 'external_contact', entityId: string, roleHint?: string): MemoryView | null {
  // First try explicit bindings
  const bound = getViewsForEntity(entityType, entityId)
  if (bound.length > 0) return bound[0]

  // Fallback to role-based default
  if (roleHint) return getViewByRole(roleHint)

  // Admin fallback
  return getViewByName('admin')
}
