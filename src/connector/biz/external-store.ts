/**
 * CRUD for external_contacts + external_audit_log tables.
 * Used by identity resolution, admin binding tools, and event notifier.
 */

import { getDatabase } from '../../storage/database.js'
import { ulid } from 'ulid'
import { logger } from '../../shared/logger.js'

const TENANT = 'default'

// ── Types ────────────────────────────────────────────────────────────

export interface ExternalContact {
  id: string
  tenantId: string
  spaceId: string
  platform: 'wecom' | 'feishu'
  platformUserId: string
  counterpartyId: string
  permissionLevel: 'query' | 'query_confirm'
  enabled: number
  isActive: number
  boundBy: string | null
  boundAt: number | null
  createdAt: number
  updatedAt: number
}

export interface ExternalContactWithName extends ExternalContact {
  counterpartyName: string
  counterpartyType: string
}

// ── Lookup ───────────────────────────────────────────────────────────

export function findExternalContact(platform: string, platformUserId: string): ExternalContactWithName | undefined {
  const db = getDatabase()
  // Prefer active binding; fall back to first enabled (backward compat)
  const row = db.prepare(`
    SELECT ec.*, cp.name AS counterparty_name, cp.type AS counterparty_type
    FROM external_contacts ec
    JOIN biz_counterparties cp ON cp.id = ec.counterparty_id
    WHERE ec.platform = ? AND ec.platform_user_id = ? AND ec.enabled = 1
    ORDER BY ec.is_active DESC, ec.updated_at DESC
    LIMIT 1
  `).get(platform, platformUserId) as Record<string, unknown> | undefined

  if (!row) return undefined
  return toCamel(row)
}

export function findExternalContactsByCounterparty(counterpartyId: string): ExternalContact[] {
  const db = getDatabase()
  const rows = db.prepare(
    'SELECT * FROM external_contacts WHERE counterparty_id = ? AND enabled = 1',
  ).all(counterpartyId) as Array<Record<string, unknown>>
  return rows.map(r => toCamel(r))
}

export function listExternalContacts(spaceId: string): ExternalContactWithName[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT ec.*, cp.name AS counterparty_name, cp.type AS counterparty_type
    FROM external_contacts ec
    JOIN biz_counterparties cp ON cp.id = ec.counterparty_id
    WHERE ec.space_id = ? AND ec.tenant_id = ?
    ORDER BY ec.enabled DESC, ec.updated_at DESC
  `).all(spaceId, TENANT) as Array<Record<string, unknown>>
  return rows.map(r => toCamel(r))
}

// ── Bind / Unbind ────────────────────────────────────────────────────

export function bindExternalContact(input: {
  spaceId: string
  platform: 'wecom' | 'feishu'
  platformUserId: string
  counterpartyId: string
  permissionLevel?: 'query' | 'query_confirm'
  boundBy?: string
}): ExternalContact {
  const db = getDatabase()
  const ts = Date.now()
  const perm = input.permissionLevel ?? 'query'

  // Upsert: match on (tenant, platform, user, counterparty) — allows multi-binding
  const existing = db.prepare(
    'SELECT id FROM external_contacts WHERE tenant_id = ? AND platform = ? AND platform_user_id = ? AND counterparty_id = ?',
  ).get(TENANT, input.platform, input.platformUserId, input.counterpartyId) as { id: string } | undefined

  // Set this binding as active, deactivate others for same platform user
  db.prepare(
    'UPDATE external_contacts SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND platform = ? AND platform_user_id = ? AND is_active = 1',
  ).run(ts, TENANT, input.platform, input.platformUserId)

  if (existing) {
    db.prepare(`
      UPDATE external_contacts
      SET permission_level = ?, enabled = 1, is_active = 1,
          bound_by = ?, bound_at = ?, space_id = ?, updated_at = ?
      WHERE id = ?
    `).run(perm, input.boundBy ?? null, ts, input.spaceId, ts, existing.id)
    return { id: existing.id, tenantId: TENANT, spaceId: input.spaceId, platform: input.platform, platformUserId: input.platformUserId, counterpartyId: input.counterpartyId, permissionLevel: perm, enabled: 1, isActive: 1, boundBy: input.boundBy ?? null, boundAt: ts, createdAt: ts, updatedAt: ts }
  }

  const id = ulid()
  db.prepare(`
    INSERT INTO external_contacts (id, tenant_id, space_id, platform, platform_user_id, counterparty_id, permission_level, enabled, is_active, bound_by, bound_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)
  `).run(id, TENANT, input.spaceId, input.platform, input.platformUserId, input.counterpartyId, perm, input.boundBy ?? null, ts, ts, ts)
  return { id, tenantId: TENANT, spaceId: input.spaceId, platform: input.platform, platformUserId: input.platformUserId, counterpartyId: input.counterpartyId, permissionLevel: perm, enabled: 1, isActive: 1, boundBy: input.boundBy ?? null, boundAt: ts, createdAt: ts, updatedAt: ts }
}

export function unbindExternalContact(counterpartyId: string): number {
  const db = getDatabase()
  const result = db.prepare(
    'UPDATE external_contacts SET enabled = 0, is_active = 0, updated_at = ? WHERE counterparty_id = ? AND enabled = 1',
  ).run(Date.now(), counterpartyId)
  return result.changes
}

// ── Multi-binding: switch & list ─────────────────────────────────────

export function switchActiveBinding(platform: string, platformUserId: string, counterpartyId: string): boolean {
  const db = getDatabase()
  const ts = Date.now()

  // Verify target binding exists and is enabled
  const target = db.prepare(
    'SELECT id FROM external_contacts WHERE tenant_id = ? AND platform = ? AND platform_user_id = ? AND counterparty_id = ? AND enabled = 1',
  ).get(TENANT, platform, platformUserId, counterpartyId) as { id: string } | undefined
  if (!target) return false

  // Transaction: deactivate all, activate target
  db.prepare(
    'UPDATE external_contacts SET is_active = 0, updated_at = ? WHERE tenant_id = ? AND platform = ? AND platform_user_id = ?',
  ).run(ts, TENANT, platform, platformUserId)
  db.prepare(
    'UPDATE external_contacts SET is_active = 1, updated_at = ? WHERE id = ?',
  ).run(ts, target.id)
  return true
}

export function listUserBindings(platform: string, platformUserId: string): ExternalContactWithName[] {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT ec.*, cp.name AS counterparty_name, cp.type AS counterparty_type
    FROM external_contacts ec
    JOIN biz_counterparties cp ON cp.id = ec.counterparty_id
    WHERE ec.tenant_id = ? AND ec.platform = ? AND ec.platform_user_id = ? AND ec.enabled = 1
    ORDER BY ec.is_active DESC, ec.updated_at DESC
  `).all(TENANT, platform, platformUserId) as Array<Record<string, unknown>>
  return rows.map(r => toCamel(r))
}

// ── Audit Log ────────────────────────────────────────────────────────

export function logExternalAction(input: {
  externalContactId?: string
  counterpartyId?: string
  action: string
  inputText?: string
  outputText?: string
}): void {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO external_audit_log (id, external_contact_id, counterparty_id, action, input, output, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(ulid(), input.externalContactId ?? null, input.counterpartyId ?? null, input.action, input.inputText ?? null, input.outputText ?? null, Date.now())
  } catch (err) {
    logger.error('External audit log error:', err instanceof Error ? err.message : String(err))
  }
}

// ── Helper ───────────────────────────────────────────────────────────

function toCamel<T>(row: Record<string, unknown>): T {
  const result: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
    result[camel] = val
  }
  return result as T
}
