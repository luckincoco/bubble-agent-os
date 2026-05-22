import { describe, it, expect } from 'vitest'
import { BIZ_TYPE_LABELS } from '../src/connector/biz/schema.js'

describe('BIZ_TYPE_LABELS', () => {
  it('has all 4 biz types', () => {
    expect(Object.keys(BIZ_TYPE_LABELS)).toEqual(['procurement', 'sales', 'payment', 'logistics'])
  })

  it('has correct Chinese labels', () => {
    expect(BIZ_TYPE_LABELS.procurement).toBe('采购')
    expect(BIZ_TYPE_LABELS.sales).toBe('销售')
    expect(BIZ_TYPE_LABELS.payment).toBe('收付款')
    expect(BIZ_TYPE_LABELS.logistics).toBe('物流')
  })
})
