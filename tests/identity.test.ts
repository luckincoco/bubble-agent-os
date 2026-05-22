import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveIdentity, clearIdentityCache } from '../src/connector/identity.js'

const { dbMock, findExternalContactMock } = vi.hoisted(() => {
  const dbRun = vi.fn()
  const dbGet = vi.fn()
  const dbAll = vi.fn()
  const dbPrepare = vi.fn((_sql: string) => ({ run: dbRun, get: dbGet, all: dbAll }))
  return {
    dbMock: { prepare: dbPrepare, run: dbRun, get: dbGet, all: dbAll },
    findExternalContactMock: vi.fn(),
  }
})

vi.mock('../src/storage/database.js', () => ({ getDatabase: () => dbMock }))
vi.mock('../src/connector/biz/external-store.js', () => ({
  findExternalContact: findExternalContactMock,
}))

function mockAdminUser() {
  dbMock.get.mockReturnValue({ id: 'admin-1' })
  dbMock.all.mockReturnValue([{ space_id: 'space-1' }, { space_id: 'space-2' }])
}

describe('resolveIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearIdentityCache()
    dbMock.prepare.mockReturnValue({ run: dbMock.run, get: dbMock.get, all: dbMock.all })
  })

  // ── admin fallback (no external contact) ───────────────

  it('returns admin context when no external contact found', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue(null)

    const ctx = resolveIdentity('wecom', 'user123')
    expect(ctx).not.toHaveProperty('isExternal')
    expect((ctx as any).userId).toBe('admin-1')
    expect((ctx as any).spaceIds).toEqual(['space-1', 'space-2'])
    expect((ctx as any).activeSpaceId).toBe('space-1')
  })

  it('returns external context when contact is found', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue({
      spaceId: 'ext-space',
      counterpartyId: 'cp-001',
      counterpartyName: '示例钢铁',
      counterpartyType: 'supplier',
      permissionLevel: 'standard',
    })

    const ctx = resolveIdentity('wecom', 'ext-user') as any
    expect(ctx.isExternal).toBe(true)
    expect(ctx.userId).toBe('ext-wecom-ext-user')
    expect(ctx.spaceIds).toEqual(['ext-space'])
    expect(ctx.counterpartyName).toBe('示例钢铁')
  })

  it('uses correct platform prefix in userId', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue({
      spaceId: 's1', counterpartyId: 'cp1', counterpartyName: 'N', counterpartyType: 'customer', permissionLevel: 'standard',
    })

    const wecom = resolveIdentity('wecom', 'u1') as any
    expect(wecom.userId).toBe('ext-wecom-u1')

    const feishu = resolveIdentity('feishu', 'u2') as any
    expect(feishu.userId).toBe('ext-feishu-u2')
  })

  // ── cache ──────────────────────────────────────────────

  it('caches external contact lookups', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue({
      spaceId: 's1', counterpartyId: 'cp1', counterpartyName: '钢铁', counterpartyType: 'supplier', permissionLevel: 'standard',
    })

    resolveIdentity('wecom', 'cached-user')
    resolveIdentity('wecom', 'cached-user')

    // Second call should use cache, not call findExternalContact again
    expect(findExternalContactMock).toHaveBeenCalledTimes(1)
  })

  it('caches null results to avoid repeated DB lookups for admin', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue(null)

    resolveIdentity('wecom', 'unknown')
    resolveIdentity('wecom', 'unknown')

    expect(findExternalContactMock).toHaveBeenCalledTimes(1)
  })

  // ── error handling ─────────────────────────────────────

  it('falls back to admin when findExternalContact throws', () => {
    mockAdminUser()
    findExternalContactMock.mockImplementation(() => { throw new Error('DB error') })

    const ctx = resolveIdentity('wecom', 'err-user')
    expect((ctx as any).userId).toBe('admin-1')
  })

  it('returns system fallback when DB query fails in admin resolution', () => {
    dbMock.get.mockImplementation(() => { throw new Error('DB locked') })

    const ctx = resolveIdentity('wecom', 'fail') as any
    expect(ctx.userId).toBe('system')
    expect(ctx.spaceIds).toEqual([])
  })

  // ── clearIdentityCache ─────────────────────────────────

  it('clearIdentityCache resets all caches', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue({
      spaceId: 's1', counterpartyId: 'cp1', counterpartyName: 'N', counterpartyType: 'customer', permissionLevel: 'standard',
    })

    resolveIdentity('wecom', 'u1')
    clearIdentityCache()

    findExternalContactMock.mockReturnValue(null)
    const ctx = resolveIdentity('wecom', 'u1')
    // After cache clear, re-fetches and finds no contact → admin
    expect((ctx as any).userId).toBe('admin-1')
  })

  // ── external context fields ────────────────────────────

  it('external context has correct counterpartyType mapping', () => {
    mockAdminUser()
    findExternalContactMock.mockReturnValue({
      spaceId: 's1', counterpartyId: 'cp1', counterpartyName: '物流', counterpartyType: 'logistics', permissionLevel: 'full',
    })

    const ctx = resolveIdentity('wecom', 'log-user') as any
    expect(ctx.counterpartyType).toBe('logistics')
    expect(ctx.permissionLevel).toBe('full')
    expect(ctx.platform).toBe('wecom')
  })
})
