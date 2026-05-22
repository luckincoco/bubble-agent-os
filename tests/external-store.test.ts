import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

import {
  findExternalContact,
  findExternalContactsByCounterparty,
  bindExternalContact,
  unbindExternalContact,
  switchActiveBinding,
  listUserBindings,
  logExternalAction,
} from '../src/connector/biz/external-store.js'

let tmpDir: string

const TENANT = 'default'

function insertCounterparty(id: string, name: string, type: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, name, type, contact, phone, address, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, name, type, overrides.contact || null, overrides.phone || null, overrides.address || null, '{}', now, now)
}

function insertContact(
  id: string,
  platform: string,
  platformUserId: string,
  counterpartyId: string,
  overrides: Record<string, any> = {},
): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO external_contacts (id, tenant_id, space_id, platform, platform_user_id, counterparty_id, permission_level, enabled, is_active, bound_by, bound_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.spaceId || 'space-1', platform, platformUserId, counterpartyId,
    overrides.permissionLevel || 'query', overrides.enabled ?? 1, overrides.isActive ?? 1,
    overrides.boundBy || null, overrides.boundAt || now, now, now,
  )
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ext-store-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM external_audit_log').run()
  db.prepare('DELETE FROM external_contacts').run()
  db.prepare('DELETE FROM biz_counterparties').run()
})

// ── findExternalContact ───────────────────────────────────────

describe('findExternalContact', () => {
  it('finds contact by platform and userId', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1')

    const result = findExternalContact('wecom', 'wx_u1')
    expect(result).toBeDefined()
    expect(result!.counterpartyName).toBe('钢铁公司')
    expect(result!.counterpartyType).toBe('supplier')
    expect(result!.platformUserId).toBe('wx_u1')
  })

  it('returns undefined when no matching contact exists', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    const result = findExternalContact('wecom', 'nonexistent')
    expect(result).toBeUndefined()
  })

  it('prefers active binding over inactive ones', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertCounterparty('cp-2', '物流公司', 'logistics')
    // Insert inactive first, then active — function should return active
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1', { isActive: 0 })
    insertContact('ec-2', 'wecom', 'wx_u1', 'cp-2', { isActive: 1 })

    const result = findExternalContact('wecom', 'wx_u1')
    expect(result).toBeDefined()
    expect(result!.counterpartyName).toBe('物流公司')
  })
})

// ── findExternalContactsByCounterparty ─────────────────────────

describe('findExternalContactsByCounterparty', () => {
  it('returns all enabled contacts for a counterparty', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1')
    insertContact('ec-2', 'feishu', 'fs_u1', 'cp-1')

    const results = findExternalContactsByCounterparty('cp-1')
    expect(results).toHaveLength(2)
  })

  it('excludes disabled contacts', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1')
    insertContact('ec-2', 'feishu', 'fs_u1', 'cp-1', { enabled: 0 })

    const results = findExternalContactsByCounterparty('cp-1')
    expect(results).toHaveLength(1)
  })
})

// ── bindExternalContact ────────────────────────────────────────

describe('bindExternalContact', () => {
  it('creates a new binding', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')

    const result = bindExternalContact({
      spaceId: 'space-1', platform: 'wecom', platformUserId: 'wx_u1',
      counterpartyId: 'cp-1', permissionLevel: 'query',
    })

    expect(result).toBeDefined()
    expect(result.enabled).toBe(1)
    expect(result.isActive).toBe(1)
    expect(result.counterpartyId).toBe('cp-1')
  })

  it('deactivates old binding when binding to a new counterparty', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertCounterparty('cp-2', '物流公司', 'logistics')

    // First binding is active
    bindExternalContact({
      spaceId: 'space-1', platform: 'wecom', platformUserId: 'wx_u1',
      counterpartyId: 'cp-1',
    })

    // Second binding should make the first inactive
    bindExternalContact({
      spaceId: 'space-1', platform: 'wecom', platformUserId: 'wx_u1',
      counterpartyId: 'cp-2',
    })

    const db = getDatabase()
    const oldBinding = db.prepare(
      'SELECT is_active FROM external_contacts WHERE counterparty_id = ? AND platform_user_id = ?',
    ).get('cp-1', 'wx_u1') as { is_active: number }
    expect(oldBinding.is_active).toBe(0)

    const newBinding = db.prepare(
      'SELECT is_active FROM external_contacts WHERE counterparty_id = ? AND platform_user_id = ?',
    ).get('cp-2', 'wx_u1') as { is_active: number }
    expect(newBinding.is_active).toBe(1)
  })

  it('updates permission level on rebind', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')

    bindExternalContact({
      spaceId: 'space-1', platform: 'wecom', platformUserId: 'wx_u1',
      counterpartyId: 'cp-1', permissionLevel: 'query',
    })

    bindExternalContact({
      spaceId: 'space-1', platform: 'wecom', platformUserId: 'wx_u1',
      counterpartyId: 'cp-1', permissionLevel: 'query_confirm',
    })

    const db = getDatabase()
    const row = db.prepare(
      'SELECT permission_level FROM external_contacts WHERE counterparty_id = ? AND platform_user_id = ?',
    ).get('cp-1', 'wx_u1') as { permission_level: string }
    expect(row.permission_level).toBe('query_confirm')
  })
})

// ── unbindExternalContact ──────────────────────────────────────

describe('unbindExternalContact', () => {
  it('disables all contacts for a counterparty', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1')
    insertContact('ec-2', 'feishu', 'fs_u1', 'cp-1')

    const affected = unbindExternalContact('cp-1')
    expect(affected).toBe(2)

    const db = getDatabase()
    const rows = db.prepare(
      'SELECT enabled FROM external_contacts WHERE counterparty_id = ?',
    ).all('cp-1') as { enabled: number }[]
    expect(rows.every(r => r.enabled === 0)).toBe(true)
  })

  it('returns 0 when counterparty has no contacts', () => {
    const affected = unbindExternalContact('nonexistent')
    expect(affected).toBe(0)
  })
})

// ── switchActiveBinding ────────────────────────────────────────

describe('switchActiveBinding', () => {
  it('switches to an existing binding', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertCounterparty('cp-2', '物流公司', 'logistics')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1', { isActive: 1 })
    insertContact('ec-2', 'wecom', 'wx_u1', 'cp-2', { isActive: 0 })

    const ok = switchActiveBinding('wecom', 'wx_u1', 'cp-2')
    expect(ok).toBe(true)

    const db = getDatabase()
    const oldActive = db.prepare(
      'SELECT is_active FROM external_contacts WHERE id = ?',
    ).get('ec-1') as { is_active: number }
    expect(oldActive.is_active).toBe(0)

    const newActive = db.prepare(
      'SELECT is_active FROM external_contacts WHERE id = ?',
    ).get('ec-2') as { is_active: number }
    expect(newActive.is_active).toBe(1)
  })

  it('returns false when target binding does not exist', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1', { isActive: 1 })

    const ok = switchActiveBinding('wecom', 'wx_u1', 'nonexistent')
    expect(ok).toBe(false)
  })
})

// ── listUserBindings ──────────────────────────────────────────

describe('listUserBindings', () => {
  it('returns all enabled bindings for a user with counterparty info', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')
    insertCounterparty('cp-2', '物流公司', 'logistics')
    insertContact('ec-1', 'wecom', 'wx_u1', 'cp-1', { isActive: 0 })
    insertContact('ec-2', 'wecom', 'wx_u1', 'cp-2', { isActive: 1 })

    const results = listUserBindings('wecom', 'wx_u1')
    expect(results).toHaveLength(2)
    // Active should be first
    expect(results[0].isActive).toBe(1)
    expect(results[0].counterpartyName).toBe('物流公司')
    expect(results[1].counterpartyName).toBe('钢铁公司')
  })
})

// ── logExternalAction ─────────────────────────────────────────

describe('logExternalAction', () => {
  it('writes audit log entry', () => {
    insertCounterparty('cp-1', '钢铁公司', 'supplier')

    logExternalAction({
      counterpartyId: 'cp-1',
      action: 'query',
      inputText: '查采购记录',
      outputText: '返回结果',
    })

    const db = getDatabase()
    const rows = db.prepare(
      'SELECT action, input, output FROM external_audit_log WHERE counterparty_id = ?',
    ).all('cp-1') as { action: string; input: string; output: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('query')
    expect(rows[0].input).toBe('查采购记录')
    expect(rows[0].output).toBe('返回结果')
  })

  it('handles errors gracefully (does not throw)', () => {
    // Passing null action should not crash
    expect(() => {
      logExternalAction({ counterpartyId: 'cp-1', action: '' })
    }).not.toThrow()
  })
})
