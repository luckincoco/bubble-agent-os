import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TeachHandler } from '../src/connector/teach/handler.js'

const { mockParserInstance, mockStoreInstance } = vi.hoisted(() => ({
  mockParserInstance: { parse: vi.fn() },
  mockStoreInstance: { store: vi.fn(), setEmbeddingProvider: vi.fn() },
}))

vi.mock('../src/connector/teach/detector.js', () => ({
  detectTeachIntent: vi.fn(),
}))
vi.mock('../src/connector/teach/parser.js', () => ({
  TeachParser: vi.fn(function() { return mockParserInstance }),
}))
vi.mock('../src/connector/teach/store.js', () => ({
  TeachStore: vi.fn(function() { return mockStoreInstance }),
}))

import { detectTeachIntent } from '../src/connector/teach/detector.js'

describe('TeachHandler', () => {
  let handler: TeachHandler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new TeachHandler({} as any)
  })

  it('returns handled=false when not detected', async () => {
    vi.mocked(detectTeachIntent).mockReturnValue({
      detected: false, action: undefined, bodyText: undefined,
    })
    const result = await handler.tryHandle('hello')
    expect(result.handled).toBe(false)
  })

  it('returns handled=false when detected but no bodyText', async () => {
    vi.mocked(detectTeachIntent).mockReturnValue({
      detected: true, action: 'remember', bodyText: undefined,
    })
    const result = await handler.tryHandle('泡泡记住')
    expect(result.handled).toBe(false)
  })

  it('returns handled=false when LLM parse fails', async () => {
    vi.mocked(detectTeachIntent).mockReturnValue({
      detected: true, action: 'remember', bodyText: 'some knowledge',
    })
    mockParserInstance.parse.mockResolvedValue(null)

    const result = await handler.tryHandle('泡泡记住: some knowledge')
    expect(result.handled).toBe(false)
  })

  it('returns handled=true with response and bubbleId on success', async () => {
    vi.mocked(detectTeachIntent).mockReturnValue({
      detected: true, action: 'remember', bodyText: 'some knowledge',
    })
    mockParserInstance.parse.mockResolvedValue({
      action: 'remember', entityName: 'E', entityType: 'other' as const,
      factText: 'fact', tags: [], rawInput: 'raw',
    })
    mockStoreInstance.store.mockResolvedValue({
      bubbleId: 'bubble-1', action: 'remember', expired: [], confirmation: '已记住：fact',
    })

    const result = await handler.tryHandle('泡泡记住: some knowledge')
    expect(result.handled).toBe(true)
    expect(result.response).toBe('已记住：fact')
    expect(result.bubbleId).toBe('bubble-1')
  })

  it('passes spaceId to store', async () => {
    vi.mocked(detectTeachIntent).mockReturnValue({
      detected: true, action: 'remember', bodyText: 'knowledge',
    })
    mockParserInstance.parse.mockResolvedValue({
      action: 'remember', entityName: 'E', entityType: 'other' as const,
      factText: 'fact', tags: [], rawInput: 'raw',
    })
    mockStoreInstance.store.mockResolvedValue({
      bubbleId: 'b1', action: 'remember', expired: [], confirmation: 'OK',
    })

    await handler.tryHandle('泡泡记住: knowledge', 'space-42')
    expect(mockStoreInstance.store).toHaveBeenCalledWith(expect.anything(), 'space-42')
  })
})
