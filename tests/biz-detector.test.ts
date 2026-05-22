import { describe, it, expect } from 'vitest'
import { detectBizIntent } from '../src/connector/biz/detector.js'

describe('detectBizIntent', () => {
  // ── procurement ───────────────────────────────────────

  it('detects procurement with quantity unit', () => {
    const r = detectBizIntent('进了30吨螺纹钢')
    expect(r.detected).toBe(true)
    expect(r.bizType).toBe('procurement')
  })

  it('detects sales', () => {
    const r = detectBizIntent('卖了50吨盘螺')
    expect(r.detected).toBe(true)
    expect(r.bizType).toBe('sales')
  })

  it('detects payment with money amount', () => {
    const r = detectBizIntent('收到货款30万')
    expect(r.detected).toBe(true)
    expect(r.bizType).toBe('payment')
  })

  it('detects logistics with quantity', () => {
    const r = detectBizIntent('到货60吨线材，运费5000元')
    expect(r.detected).toBe(true)
    expect(r.bizType).toBe('logistics')
  })

  it('detects procurement with price indicator', () => {
    const r = detectBizIntent('采购螺纹钢，单价3500元/吨')
    expect(r.detected).toBe(true)
    expect(r.bizType).toBe('procurement')
  })

  // ── rejection ─────────────────────────────────────────

  it('returns not detected when no number present', () => {
    expect(detectBizIntent('进了螺纹钢').detected).toBe(false)
    expect(detectBizIntent('今天天气不错').detected).toBe(false)
  })

  it('returns not detected for text shorter than 6', () => {
    expect(detectBizIntent('进30').detected).toBe(false)
    expect(detectBizIntent('').detected).toBe(false)
  })

  it('returns not detected for text longer than 500', () => {
    const long = '进了' + 'x'.repeat(500)
    expect(detectBizIntent(long).detected).toBe(false)
  })

  it('returns not detected when verb exists but lacks quantity/steel/price', () => {
    // Has verb "进了" + number, but no steel keyword / quantity unit / price indicator
    const r = detectBizIntent('进了3个')
    expect(r.detected).toBe(false)
  })

  it('returns not detected for casual conversation with numbers', () => {
    expect(detectBizIntent('我今年35岁').detected).toBe(false)
    expect(detectBizIntent('价格是100块').detected).toBe(false)
  })

  // ── alternative verbs ─────────────────────────────────

  it('handles alternative procurement verbs', () => {
    expect(detectBizIntent('订购了100吨钢板').bizType).toBe('procurement')
    expect(detectBizIntent('到了3车螺纹').bizType).toBe('procurement')
  })

  it('handles alternative payment verbs', () => {
    expect(detectBizIntent('结了50万货款').bizType).toBe('payment')
    expect(detectBizIntent('给他转了30万').bizType).toBe('payment')
  })
})
