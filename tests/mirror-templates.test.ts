import { describe, it, expect } from 'vitest'
import { renderMirror, getMirrorEventType } from '../src/connector/biz/mirror-templates.js'

describe('renderMirror', () => {
  it('renders purchase from our perspective', () => {
    const result = renderMirror('purchase', {
      date: '2026-01-15', counterparty: '钢铁公司',
      product: '螺纹钢', tonnage: 50, unitPrice: 3800, totalAmount: 190000,
    }, 'our')
    expect(result).toContain('采购')
    expect(result).toContain('螺纹钢')
    expect(result).toContain('50吨')
    expect(result).toContain('190000')
  })

  it('renders purchase from their perspective', () => {
    const result = renderMirror('purchase', {
      date: '2026-01-15', counterparty: '钢铁公司',
      product: '螺纹钢', tonnage: 50, unitPrice: 3800, totalAmount: 190000,
    }, 'their')
    expect(result).toContain('销售')
    expect(result).toContain('螺纹钢')
    expect(result).toContain('贵方向我方')
  })

  it('renders payment_in from our perspective', () => {
    const result = renderMirror('payment_in', {
      date: '2026-02-01', counterparty: '客户A', amount: 50000,
    }, 'our')
    expect(result).toContain('收到')
    expect(result).toContain('客户A')
    expect(result).toContain('50000')
  })

  it('renders payment_in from their perspective', () => {
    const result = renderMirror('payment_in', {
      date: '2026-02-01', counterparty: '客户A', amount: 50000,
    }, 'their')
    expect(result).toContain('支付')
    expect(result).toContain('50000')
  })

  it('renders logistics from their perspective', () => {
    const result = renderMirror('logistics', {
      date: '2026-03-10', counterparty: '物流公司', tonnage: 30, destination: '上海仓库',
    }, 'their')
    expect(result).toContain('收到我方发货')
    expect(result).toContain('上海仓库')
  })

  it('returns unknown event type message for missing template', () => {
    const result = renderMirror('nonexistent', {}, 'our')
    expect(result).toBe('未知事件类型: nonexistent')
  })

  it('replaces missing data fields with empty string', () => {
    const result = renderMirror('purchase', { date: '2026-01-15' }, 'our')
    // counterparty, product, tonnage, unitPrice, totalAmount all missing → empty
    expect(result).not.toContain('undefined')
    expect(result).not.toContain('null')
  })

  it('ignores extra data fields not in template', () => {
    const result = renderMirror('purchase', {
      date: '2026-01-15', counterparty: '钢铁公司',
      product: '螺纹钢', tonnage: 50, unitPrice: 3800, totalAmount: 190000,
      extraField: 'should be ignored',
    }, 'our')
    // Should still render normally, extra fields don't cause issues
    expect(result).toContain('采购')
    expect(result).toContain('螺纹钢')
  })
})

describe('getMirrorEventType', () => {
  it('maps purchase to sale', () => {
    expect(getMirrorEventType('purchase')).toBe('sale')
  })

  it('maps sale to purchase', () => {
    expect(getMirrorEventType('sale')).toBe('purchase')
  })

  it('maps payment_in to payment_out', () => {
    expect(getMirrorEventType('payment_in')).toBe('payment_out')
  })

  it('returns unknown event type unchanged', () => {
    expect(getMirrorEventType('unknown_event')).toBe('unknown_event')
  })

  it('returns logistics unchanged (self-mirror)', () => {
    expect(getMirrorEventType('logistics')).toBe('logistics')
  })
})
