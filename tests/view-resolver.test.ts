import { describe, it, expect, vi } from 'vitest'
import { resolveProjectionContext, hasAdminAccess } from '../src/memory/view-resolver.js'
import type { UserContext, ExternalUserContext } from '../src/shared/types.js'

const mockResolveEffectiveView = vi.fn()
vi.mock('../src/memory/view-registry.js', () => ({
  resolveEffectiveView: (...args: unknown[]) => mockResolveEffectiveView(...args),
}))

beforeEach(() => {
  vi.clearAllMocks()
})

const adminView = { id: 'v1', name: 'admin', rolePattern: 'admin', filters: { allowedTypes: '*', maxAbstractionLevel: 10, tagFilter: [], counterpartyFilter: undefined, timeWindow: undefined }, priority: 100, createdAt: 1000, updatedAt: 1000 }
const supplierView = { id: 'v2', name: '供应商视图', rolePattern: 'supplier', filters: { allowedTypes: ['observation'], maxAbstractionLevel: 5, tagFilter: [], counterpartyFilter: 'bound', timeWindow: undefined }, priority: 10, createdAt: 1000, updatedAt: 1000 }

describe('resolveProjectionContext', () => {
  it('外部用户通过 entityType 解析视图', () => {
    mockResolveEffectiveView.mockReturnValue(supplierView)
    const ctx: ExternalUserContext = {
      userId: 'ext-u1',
      platformUserId: 'ec1',
      counterpartyType: 'supplier',
      counterpartyId: 'cp-123',
      userDisplayName: '供应商A',
      isExternal: true,
    }

    const result = resolveProjectionContext(ctx)
    expect(result).not.toBeNull()
    expect(result!.view.id).toBe('v2')
    expect(result!.counterpartyId).toBe('cp-123')
    expect(mockResolveEffectiveView).toHaveBeenCalledWith('external_contact', 'ec1', 'supplier')
  })

  it('内部用户通过 admin 回退解析', () => {
    mockResolveEffectiveView.mockReturnValue(adminView)
    const ctx: UserContext = { userId: 'u1', userDisplayName: '管理员' }

    const result = resolveProjectionContext(ctx)
    expect(result).not.toBeNull()
    expect(result!.view.id).toBe('v1')
    expect(result!.counterpartyId).toBeUndefined()
    expect(mockResolveEffectiveView).toHaveBeenCalledWith('user', 'u1', 'admin')
  })

  it('无匹配视图返回 null', () => {
    mockResolveEffectiveView.mockReturnValue(null)
    const ctx: UserContext = { userId: 'u1', userDisplayName: '用户' }

    expect(resolveProjectionContext(ctx)).toBeNull()
  })

  it('asOfTimestamp 透传', () => {
    mockResolveEffectiveView.mockReturnValue(supplierView)
    const ctx: ExternalUserContext = {
      userId: 'ext-u1',
      platformUserId: 'ec1',
      counterpartyType: 'supplier',
      counterpartyId: 'cp-123',
      userDisplayName: '供应商',
      isExternal: true,
    }

    const result = resolveProjectionContext(ctx, { asOfTimestamp: 9999 })
    expect(result!.asOfTimestamp).toBe(9999)
  })
})

describe('hasAdminAccess', () => {
  it('外部用户无 admin 权限', () => {
    const ctx: ExternalUserContext = { userId: 'ext-u1', platformUserId: 'ec1', counterpartyType: 'supplier', counterpartyId: 'cp-1', userDisplayName: '供应商', isExternal: true }
    expect(hasAdminAccess(ctx)).toBe(false)
  })

  it('内部用户有 admin 权限', () => {
    expect(hasAdminAccess({ userId: 'u1', userDisplayName: '用户' })).toBe(true)
  })
})
