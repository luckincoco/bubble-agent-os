import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('../src/connector/biz/external-store.js', () => ({
  findExternalContactsByCounterparty: vi.fn(),
  logExternalAction: vi.fn(),
}))

vi.mock('../src/connector/biz/mirror-enhancer.js', () => ({
  enhanceMirrorText: vi.fn(),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { EventNotifier, type MirrorPushContext } from '../src/connector/event-notifier.js'
import { findExternalContactsByCounterparty, logExternalAction } from '../src/connector/biz/external-store.js'
import { enhanceMirrorText } from '../src/connector/biz/mirror-enhancer.js'
import type { WeComConnector } from '../src/connector/wecom.js'
import type { LLMProvider } from '../src/shared/types.js'

// ── Helpers ──────────────────────────────────────────────────────

function makeWecom(): WeComConnector {
  return { pushMessage: vi.fn() } as unknown as WeComConnector
}

function makeLLM(): LLMProvider {
  return { chat: vi.fn(), chatStream: vi.fn() } as LLMProvider
}

function makeContext(overrides: Partial<MirrorPushContext> = {}): MirrorPushContext {
  return {
    counterpartyId: 'cp-1',
    counterpartyName: '钢铁公司',
    counterpartyType: 'supplier',
    spaceId: 'space-1',
    mirrorText: '贵方向我方采购了螺纹钢 50 吨，金额 190,000 元。',
    eventType: 'purchase',
    ...overrides,
  }
}

// ── Constructor ──────────────────────────────────────────────────

describe('EventNotifier constructor', () => {
  it('stores wecom and llm', () => {
    const wecom = makeWecom()
    const llm = makeLLM()
    const notifier = new EventNotifier(wecom, llm)
    expect(notifier).toBeInstanceOf(EventNotifier)
  })

  it('accepts null wecom and null llm', () => {
    const notifier = new EventNotifier(null, null)
    expect(notifier).toBeInstanceOf(EventNotifier)
  })
})

// ── notifyCounterparty ───────────────────────────────────────────

describe('notifyCounterparty', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns early when no contacts found', async () => {
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([])
    const notifier = new EventNotifier(null, null)

    await notifier.notifyCounterparty(makeContext())

    expect(findExternalContactsByCounterparty).toHaveBeenCalledWith('cp-1')
    // No push, no log, no enhance
    expect(logExternalAction).not.toHaveBeenCalled()
  })

  it('pushes template text to WeCom contacts when no LLM', async () => {
    const wecom = makeWecom()
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
    ])
    const notifier = new EventNotifier(wecom, null)

    await notifier.notifyCounterparty(makeContext())

    expect(wecom.pushMessage).toHaveBeenCalledWith(
      'wx_u1',
      '贵方向我方采购了螺纹钢 50 吨，金额 190,000 元。',
    )
    expect(logExternalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        externalContactId: 'c1',
        counterpartyId: 'cp-1',
        action: 'event_push',
      }),
    )
  })

  it('enhances text with LLM when available', async () => {
    const wecom = makeWecom()
    const llm = makeLLM()
    vi.mocked(enhanceMirrorText).mockResolvedValue('增强后的通知文本')
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
    ])
    const notifier = new EventNotifier(wecom, llm)

    await notifier.notifyCounterparty(makeContext())

    expect(enhanceMirrorText).toHaveBeenCalledWith(
      llm,
      expect.objectContaining({
        templateText: '贵方向我方采购了螺纹钢 50 吨，金额 190,000 元。',
        counterpartyId: 'cp-1',
      }),
    )
    expect(wecom.pushMessage).toHaveBeenCalledWith('wx_u1', '增强后的通知文本')
    expect(logExternalAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'event_push_enhanced' }),
    )
  })

  it('falls back to template when LLM enhancement fails', async () => {
    const wecom = makeWecom()
    const llm = makeLLM()
    vi.mocked(enhanceMirrorText).mockRejectedValue(new Error('LLM unavailable'))
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
    ])
    const notifier = new EventNotifier(wecom, llm)

    await notifier.notifyCounterparty(makeContext())

    // Should still push with original template text
    expect(wecom.pushMessage).toHaveBeenCalledWith(
      'wx_u1',
      '贵方向我方采购了螺纹钢 50 吨，金额 190,000 元。',
    )
    expect(logExternalAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'event_push' }),
    )
  })

  it('handles WeCom push failure gracefully', async () => {
    const wecom = makeWecom()
    vi.mocked(wecom.pushMessage).mockRejectedValue(new Error('API error'))
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
    ])
    const notifier = new EventNotifier(wecom, null)

    // Should not throw
    await expect(
      notifier.notifyCounterparty(makeContext()),
    ).resolves.toBeUndefined()
  })

  it('skips WeCom push when wecom is null', async () => {
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
    ])
    const notifier = new EventNotifier(null, null)

    await notifier.notifyCounterparty(makeContext())

    // No push, but action should still be logged
    expect(logExternalAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'event_push' }),
    )
  })

  it('pushes to multiple contacts', async () => {
    const wecom = makeWecom()
    vi.mocked(findExternalContactsByCounterparty).mockReturnValue([
      { id: 'c1', platform: 'wecom', platformUserId: 'wx_u1' } as any,
      { id: 'c2', platform: 'wecom', platformUserId: 'wx_u2' } as any,
    ])
    const notifier = new EventNotifier(wecom, null)

    await notifier.notifyCounterparty(makeContext())

    expect(wecom.pushMessage).toHaveBeenCalledTimes(2)
    expect(logExternalAction).toHaveBeenCalledTimes(2)
  })
})
