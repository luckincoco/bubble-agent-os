import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockParserInstance, mockStoreInstance } = vi.hoisted(() => ({
  mockParserInstance: { parse: vi.fn() },
  mockStoreInstance: {
    store: vi.fn(),
    setEventNotifier: vi.fn(),
    setEventBus: vi.fn(),
    setEmbeddingProvider: vi.fn(),
  },
}))

vi.mock('../src/connector/biz/detector.js', () => ({
  detectBizIntent: vi.fn(),
}))
vi.mock('../src/connector/biz/parser.js', () => ({
  BizParser: vi.fn(function () {
    return mockParserInstance
  }),
}))
vi.mock('../src/connector/biz/store.js', () => ({
  BizStore: vi.fn(function () {
    return mockStoreInstance
  }),
}))

import { BizEntryHandler } from '../src/connector/biz/handler.js'
import { detectBizIntent } from '../src/connector/biz/detector.js'

describe('BizEntryHandler', () => {
  let handler: BizEntryHandler

  beforeEach(() => {
    vi.clearAllMocks()
    handler = new BizEntryHandler({ chat: vi.fn(), chatStream: vi.fn() } as any)
  })

  describe('tryHandle', () => {
    it('returns handled=true on successful full flow', async () => {
      vi.mocked(detectBizIntent).mockReturnValue({ detected: true, bizType: 'procurement' })
      mockParserInstance.parse.mockResolvedValue({
        bizType: 'procurement',
        supplier: '供应商A',
        product: '螺纹钢',
        quantity: 100,
        unitPrice: 3000,
        date: '2024-06-15',
        rawInput: '进了100吨螺纹钢',
      })
      mockStoreInstance.store.mockResolvedValue({
        bubbleId: 'bubble-1',
        duplicate: false,
        confirmation: '已记录：采购螺纹钢100吨',
      })

      const result = await handler.tryHandle('进了100吨螺纹钢')

      expect(result.handled).toBe(true)
      expect(result.response).toBe('已记录：采购螺纹钢100吨')
      expect(result.bubbleId).toBe('bubble-1')
    })

    it('returns handled=false when detectBizIntent returns not detected', async () => {
      vi.mocked(detectBizIntent).mockReturnValue({ detected: false })

      const result = await handler.tryHandle('今天天气不错')

      expect(result.handled).toBe(false)
      expect(mockParserInstance.parse).not.toHaveBeenCalled()
      expect(mockStoreInstance.store).not.toHaveBeenCalled()
    })

    it('returns handled=false when detectBizIntent returns detected=false even with bizType', async () => {
      // Edge case: detected=false with undefined bizType
      vi.mocked(detectBizIntent).mockReturnValue({ detected: false, bizType: undefined })

      const result = await handler.tryHandle('some text')

      expect(result.handled).toBe(false)
    })

    it('returns handled=false when parser returns null', async () => {
      vi.mocked(detectBizIntent).mockReturnValue({ detected: true, bizType: 'procurement' })
      mockParserInstance.parse.mockResolvedValue(null)

      const result = await handler.tryHandle('进了100吨螺纹钢')

      expect(result.handled).toBe(false)
      expect(mockStoreInstance.store).not.toHaveBeenCalled()
    })

    it('passes spaceId to store', async () => {
      vi.mocked(detectBizIntent).mockReturnValue({ detected: true, bizType: 'procurement' })
      mockParserInstance.parse.mockResolvedValue({
        bizType: 'procurement',
        supplier: '供应商A',
        product: '螺纹钢',
        quantity: 100,
        unitPrice: 3000,
        date: '2024-06-15',
        rawInput: '进了100吨螺纹钢',
      })
      mockStoreInstance.store.mockResolvedValue({
        bubbleId: 'b-1',
        duplicate: false,
        confirmation: 'OK',
      })

      await handler.tryHandle('进了100吨螺纹钢', 'space-42')

      expect(mockStoreInstance.store).toHaveBeenCalledWith(expect.anything(), 'space-42')
    })
  })

  describe('wiring', () => {
    it('setEventNotifier delegates to store', () => {
      const notifier = {} as any
      handler.setEventNotifier(notifier)
      expect(mockStoreInstance.setEventNotifier).toHaveBeenCalledWith(notifier)
    })

    it('setEventBus delegates to store', () => {
      const bus = {} as any
      handler.setEventBus(bus)
      expect(mockStoreInstance.setEventBus).toHaveBeenCalledWith(bus)
    })

    it('passes embeddings to store constructor', () => {
      const embeddings = { embed: vi.fn(), embedBatch: vi.fn() }
      // Create a new handler with embeddings
      const handlerWithEmb = new BizEntryHandler({ chat: vi.fn(), chatStream: vi.fn() } as any, embeddings)
      expect(handlerWithEmb).toBeInstanceOf(BizEntryHandler)
      expect(mockStoreInstance.setEmbeddingProvider).toHaveBeenCalledWith(embeddings)
    })
  })
})
