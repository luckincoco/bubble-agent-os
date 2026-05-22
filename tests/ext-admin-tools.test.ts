import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockFuzzyFind, mockGetCounterparties, mockBind, mockUnbind, mockList, mockClearCache } = vi.hoisted(() => ({
  mockFuzzyFind: vi.fn(),
  mockGetCounterparties: vi.fn(),
  mockBind: vi.fn(),
  mockUnbind: vi.fn(),
  mockList: vi.fn(),
  mockClearCache: vi.fn(),
}))

vi.mock('../src/connector/biz/structured-store.js', () => ({
  fuzzyFindCounterparty: mockFuzzyFind,
  getCounterparties: mockGetCounterparties,
}))
vi.mock('../src/connector/biz/external-store.js', () => ({
  bindExternalContact: mockBind,
  unbindExternalContact: mockUnbind,
  listExternalContacts: mockList,
}))
vi.mock('../src/connector/identity.js', () => ({
  clearIdentityCache: mockClearCache,
}))

import { createExtAdminTools } from '../src/connector/tools/ext-admin-tools.js'

const mockCtx = { userId: 'admin-1', activeSpaceId: 'space-1' } as any

describe('createExtAdminTools', () => {
  let tools: Record<string, any>

  beforeEach(() => {
    vi.clearAllMocks()
    const defs = createExtAdminTools()
    tools = {}
    for (const t of defs) tools[t.name] = t
  })

  // ── ext_bind_contact ─────────────────────────────────

  describe('ext_bind_contact', () => {
    it('rejects invalid platform', async () => {
      const result = await tools.ext_bind_contact.execute(
        { platform: 'dingtalk', platform_user_id: 'u1', counterparty_name: '钢铁' }, mockCtx,
      )
      expect(result).toContain('平台必须是 wecom 或 feishu')
    })

    it('requires platform_user_id', async () => {
      const result = await tools.ext_bind_contact.execute(
        { platform: 'wecom', platform_user_id: '', counterparty_name: '钢铁' }, mockCtx,
      )
      expect(result).toContain('请提供平台用户ID')
    })

    it('requires counterparty_name', async () => {
      const result = await tools.ext_bind_contact.execute(
        { platform: 'wecom', platform_user_id: 'u1', counterparty_name: '' }, mockCtx,
      )
      expect(result).toContain('请提供交易对手方名称')
    })

    it('shows available counterparties when name not found', async () => {
      mockFuzzyFind.mockReturnValue(null)
      mockGetCounterparties.mockReturnValue([{ name: '钢铁公司' }])

      const result = await tools.ext_bind_contact.execute(
        { platform: 'wecom', platform_user_id: 'u1', counterparty_name: '未知' }, mockCtx,
      )
      expect(result).toContain('找不到')
      expect(result).toContain('钢铁公司')
    })

    it('binds contact on success', async () => {
      mockFuzzyFind.mockReturnValue({ id: 'cp-1', name: '钢铁公司', type: 'supplier' })
      mockBind.mockReturnValue({})

      const result = await tools.ext_bind_contact.execute(
        { platform: 'wecom', platform_user_id: 'wx_user1', counterparty_name: '钢铁公司' }, mockCtx,
      )
      expect(result).toContain('绑定到')
      expect(result).toContain('wx_user1')
      expect(mockBind).toHaveBeenCalledWith(
        expect.objectContaining({
          platform: 'wecom', platformUserId: 'wx_user1', counterpartyId: 'cp-1',
        }),
      )
      expect(mockClearCache).toHaveBeenCalled()
    })

    it('parses wecom platform label', async () => {
      mockFuzzyFind.mockReturnValue({ id: 'cp-1', name: 'N', type: 'supplier' })
      mockBind.mockReturnValue({})
      const result = await tools.ext_bind_contact.execute(
        { platform: 'feishu', platform_user_id: 'u1', counterparty_name: 'N', permission_level: 'query_confirm' }, mockCtx,
      )
      expect(result).toContain('飞书')
      expect(result).toContain('查询+确认')
    })
  })

  // ── ext_unbind_contact ───────────────────────────────

  describe('ext_unbind_contact', () => {
    it('requires counterparty_name', async () => {
      const result = await tools.ext_unbind_contact.execute({ counterparty_name: '' }, mockCtx)
      expect(result).toContain('请提供交易对手方名称')
    })

    it('returns not found when counterparty missing', async () => {
      mockFuzzyFind.mockReturnValue(null)
      const result = await tools.ext_unbind_contact.execute({ counterparty_name: '未知' }, mockCtx)
      expect(result).toContain('找不到')
    })

    it('shows no active bindings message', async () => {
      mockFuzzyFind.mockReturnValue({ id: 'cp-1', name: '钢铁公司' })
      mockUnbind.mockReturnValue(0)

      const result = await tools.ext_unbind_contact.execute({ counterparty_name: '钢铁公司' }, mockCtx)
      expect(result).toContain('没有已启用的外部联系人绑定')
      expect(mockClearCache).toHaveBeenCalled()
    })

    it('unbinds successfully', async () => {
      mockFuzzyFind.mockReturnValue({ id: 'cp-1', name: '钢铁公司' })
      mockUnbind.mockReturnValue(2)

      const result = await tools.ext_unbind_contact.execute({ counterparty_name: '钢铁公司' }, mockCtx)
      expect(result).toContain('已停用')
      expect(result).toContain('2')
    })
  })

  // ── ext_list_contacts ────────────────────────────────

  describe('ext_list_contacts', () => {
    it('shows empty message when no contacts', async () => {
      mockList.mockReturnValue([])
      const result = await tools.ext_list_contacts.execute({}, mockCtx)
      expect(result).toContain('暂无已绑定的外部联系人')
    })

    it('lists contacts with formatting', async () => {
      mockList.mockReturnValue([
        { counterpartyName: '钢铁公司', counterpartyType: 'supplier', platform: 'wecom', platformUserId: 'u1', permissionLevel: 'query', enabled: true, isActive: true },
        { counterpartyName: '物流公司', counterpartyType: 'logistics', platform: 'feishu', platformUserId: 'u2', permissionLevel: 'query_confirm', enabled: true, isActive: false },
      ])

      const result = await tools.ext_list_contacts.execute({}, mockCtx)
      expect(result).toContain('钢铁公司')
      expect(result).toContain('供应商')
      expect(result).toContain('物流公司')
      expect(result).toContain('物流商')
      expect(result).toContain('企微')
      expect(result).toContain('飞书')
      expect(result).toContain('[当前]')
      expect(result).toContain('共2个')
    })
  })
})
