import { describe, it, expect } from 'vitest'
import { buildExternalSystemPrompt, TONE_PROFILES } from '../src/kernel/external-prompts.js'
import type { ExternalUserContext } from '../src/shared/types.js'

function makeCtx(overrides: Partial<ExternalUserContext> = {}): ExternalUserContext {
  return {
    userId: 'ext-wecom-user123',
    spaceIds: ['space-1'],
    activeSpaceId: 'space-1',
    isExternal: true,
    counterpartyId: 'cp-001',
    counterpartyName: '示例钢铁',
    counterpartyType: 'supplier',
    permissionLevel: 'standard',
    platformUserId: 'user123',
    platform: 'wecom' as const,
    ...overrides,
  }
}

describe('TONE_PROFILES', () => {
  it('has all three counterparty types', () => {
    expect(TONE_PROFILES).toHaveProperty('supplier')
    expect(TONE_PROFILES).toHaveProperty('customer')
    expect(TONE_PROFILES).toHaveProperty('logistics')
  })

  it('each profile has address, posture, and style', () => {
    for (const [type, profile] of Object.entries(TONE_PROFILES)) {
      expect(profile.address).toBeTruthy()
      expect(profile.posture).toBeTruthy()
      expect(profile.style).toBeTruthy()
    }
  })

  it('supplier address uses 贵司', () => {
    expect(TONE_PROFILES.supplier.address).toBe('贵司/贵方')
  })

  it('customer address uses 您', () => {
    expect(TONE_PROFILES.customer.address).toContain('您')
  })

  it('logistics address uses 您', () => {
    expect(TONE_PROFILES.logistics.address).toBe('您')
  })
})

describe('buildExternalSystemPrompt', () => {
  it('returns a string containing the counterparty name', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyName: '宝钢集团' }))
    expect(prompt).toContain('宝钢集团')
  })

  it('uses supplier type label for supplier', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyType: 'supplier' }))
    expect(prompt).toContain('供应商')
  })

  it('uses customer type label for customer', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyType: 'customer' }))
    expect(prompt).toContain('客户')
  })

  it('uses logistics type label for logistics', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyType: 'logistics' }))
    expect(prompt).toContain('物流合作伙伴')
  })

  it('falls back to 合作伙伴 for unknown type', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyType: 'unknown' as any }))
    expect(prompt).toContain('合作伙伴')
  })

  it('includes 严格边界 section', () => {
    const prompt = buildExternalSystemPrompt(makeCtx())
    expect(prompt).toContain('严格边界')
    expect(prompt).toContain('只回答')
    expect(prompt).toContain('不透露')
  })

  it('includes 你的能力 section', () => {
    const prompt = buildExternalSystemPrompt(makeCtx())
    expect(prompt).toContain('你的能力')
    expect(prompt).toContain('查询与')
  })

  it('includes the correct tone style for the counterparty type', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyType: 'customer' }))
    expect(prompt).toContain('热情专业')
  })

  it('includes the counterparty name in boundary section', () => {
    const prompt = buildExternalSystemPrompt(makeCtx({ counterpartyName: '首钢' }))
    expect(prompt).toContain('「首钢」')
  })

  it('includes current time in zh-CN format', () => {
    const prompt = buildExternalSystemPrompt(makeCtx())
    // Should contain something like "2026年" or the current year
    expect(prompt).toContain(`${new Date().getFullYear()}年`)
  })
})
