import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { BizParser } from '../src/connector/biz/parser.js'
import type { LLMProvider } from '../src/shared/types.js'

describe('BizParser', () => {
  const mockChat = vi.fn()
  const mockLLM: LLMProvider = { chat: mockChat, chatStream: vi.fn() }
  let parser: BizParser

  beforeEach(() => {
    mockChat.mockReset()
    parser = new BizParser(mockLLM)
  })

  describe('successful parse', () => {
    it('parses procurement record', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'procurement',
          date: '2024-06-15',
          supplier: '供应商A',
          product: '螺纹钢',
          spec: 'HRB400',
          quantity: 100,
          unitPrice: 3000,
          project: '项目X',
        }),
      })

      const result = await parser.parse('进了100吨螺纹钢,单价3000', 'procurement')
      expect(result).not.toBeNull()
      expect(result!.bizType).toBe('procurement')
      expect(result!.supplier).toBe('供应商A')
      expect(result!.product).toBe('螺纹钢')
      expect(result!.quantity).toBe(100)
      expect(result!.unitPrice).toBe(3000)
      expect(result!.rawInput).toBe('进了100吨螺纹钢,单价3000')
    })

    it('parses sales record', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'sales',
          date: '2024-06-20',
          customer: '客户B',
          product: '盘螺',
          spec: 'Ø8',
          quantity: 50,
          unitPrice: 4000,
        }),
      })

      const result = await parser.parse('卖了50吨盘螺', 'sales')
      expect(result).not.toBeNull()
      expect(result!.bizType).toBe('sales')
      expect(result!.customer).toBe('客户B')
      expect(result!.product).toBe('盘螺')
    })

    it('parses payment record', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'payment',
          date: '2024-06-25',
          counterparty: '供应商A',
          direction: '付',
          amount: 50000,
          method: '银行转账',
        }),
      })

      const result = await parser.parse('付了5万给供应商A', 'payment')
      expect(result).not.toBeNull()
      expect(result!.bizType).toBe('payment')
      expect(result!.counterparty).toBe('供应商A')
      expect(result!.direction).toBe('付')
      expect(result!.amount).toBe(50000)
    })

    it('parses logistics record', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'logistics',
          date: '2024-06-30',
          carrier: '物流C',
          destination: '上海',
          tonnage: 80,
          freight: 3000,
          liftingFee: 500,
        }),
      })

      const result = await parser.parse('装车80吨到上海', 'logistics')
      expect(result).not.toBeNull()
      expect(result!.bizType).toBe('logistics')
      expect(result!.destination).toBe('上海')
      expect(result!.tonnage).toBe(80)
    })
  })

  describe('JSON extraction', () => {
    it('handles JSON wrapped in markdown code block', async () => {
      mockChat.mockResolvedValue({
        content: '```json\n{"bizType":"procurement","supplier":"供应商A","product":"螺纹钢","quantity":100,"unitPrice":3000}\n```',
      })

      const result = await parser.parse('test', 'procurement')
      expect(result).not.toBeNull()
      expect(result!.supplier).toBe('供应商A')
    })
  })

  describe('validation', () => {
    it('returns null for invalid bizType', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'invalid_type',
          supplier: '供应商A',
          product: '螺纹钢',
        }),
      })

      const result = await parser.parse('test', 'procurement')
      expect(result).toBeNull()
    })

    it('returns null when required field is missing for procurement', async () => {
      // Missing 'supplier'
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'procurement',
          product: '螺纹钢',
          quantity: 100,
        }),
      })

      const result = await parser.parse('test', 'procurement')
      expect(result).toBeNull()
    })

    it('returns null when required field is missing for sales', async () => {
      // Missing 'customer'
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'sales',
          product: '螺纹钢',
          quantity: 50,
        }),
      })

      const result = await parser.parse('test', 'sales')
      expect(result).toBeNull()
    })

    it('returns null when required field is missing for payment', async () => {
      // Missing 'counterparty'
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'payment',
          amount: 50000,
        }),
      })

      const result = await parser.parse('test', 'payment')
      expect(result).toBeNull()
    })

    it('returns null when required field is missing for logistics', async () => {
      // Missing 'destination'
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'logistics',
          carrier: '物流C',
          tonnage: 80,
        }),
      })

      const result = await parser.parse('test', 'logistics')
      expect(result).toBeNull()
    })
  })

  describe('default values', () => {
    it('defaults date to today when not provided', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'procurement',
          supplier: '供应商A',
          product: '螺纹钢',
          quantity: 100,
          unitPrice: 3000,
        }),
      })

      const result = await parser.parse('test', 'procurement')
      expect(result).not.toBeNull()
      expect(result!.date).toBeDefined()
      // Should match YYYY-MM-DD format
      expect(result!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('auto-calculates totalAmount for procurement', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'procurement',
          supplier: '供应商A',
          product: '螺纹钢',
          quantity: 100,
          unitPrice: 3000,
        }),
      })

      const result = await parser.parse('test', 'procurement')
      expect(result).not.toBeNull()
      expect((result as any).totalAmount).toBe(300000) // 100 * 3000
    })

    it('auto-calculates totalAmount for sales', async () => {
      mockChat.mockResolvedValue({
        content: JSON.stringify({
          bizType: 'sales',
          customer: '客户B',
          product: '螺纹钢',
          quantity: 50,
          unitPrice: 4000,
        }),
      })

      const result = await parser.parse('test', 'sales')
      expect(result).not.toBeNull()
      expect((result as any).totalAmount).toBe(200000) // 50 * 4000
    })
  })

  describe('error handling', () => {
    it('returns null when LLM.chat throws', async () => {
      mockChat.mockRejectedValue(new Error('API error'))

      const result = await parser.parse('test', 'procurement')
      expect(result).toBeNull()
    })

    it('returns null when no JSON in response', async () => {
      mockChat.mockResolvedValue({ content: 'I cannot parse this' })

      const result = await parser.parse('test', 'procurement')
      expect(result).toBeNull()
    })

    it('returns null on JSON parse error', async () => {
      mockChat.mockResolvedValue({ content: '{ malformed json }' })

      const result = await parser.parse('test', 'procurement')
      expect(result).toBeNull()
    })
  })
})
