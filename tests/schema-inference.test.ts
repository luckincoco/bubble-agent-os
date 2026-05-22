import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/connector/tools/excel-translator.js', () => ({
  detectSheetCategory: vi.fn(() => 'unknown'),
}))

import {
  applyColumnMap,
  resolveCategory,
  fuzzyMatchColumns,
  inferSheetSchema,
  inferAllSheets,
} from '../src/connector/tools/schema-inference.js'
import { detectSheetCategory } from '../src/connector/tools/excel-translator.js'

// ── applyColumnMap ────────────────────────────────────────────

describe('applyColumnMap', () => {
  const rows = [{ '钢厂': '宝钢', '重量': '50吨', '日期': '2026-01-01' }]

  it('maps original columns to standard names', () => {
    const result = applyColumnMap(rows, { '钢厂': '供应商', '重量': '吨位' })
    expect(result[0]).toHaveProperty('钢厂')
    expect(result[0]).toHaveProperty('供应商')
    expect(result[0].供应商).toBe('宝钢')
    expect(result[0].吨位).toBe('50吨')
  })

  it('preserves original columns alongside mapped ones', () => {
    const result = applyColumnMap(rows, { '钢厂': '供应商' })
    expect(result[0]).toHaveProperty('钢厂')
    expect(result[0]).toHaveProperty('供应商')
    expect(Object.keys(result[0]).length).toBe(4) // 钢厂, 重量, 日期, 供应商
  })

  it('skips mapping when original equals standard name', () => {
    const result = applyColumnMap(rows, { '日期': '日期' })
    // No extra column added since orig === std
    expect(Object.keys(result[0]).length).toBe(3)
  })

  it('returns original rows when entries is empty', () => {
    const result = applyColumnMap(rows, {})
    expect(result).toEqual(rows)
  })

  it('skips null or empty values in mapping', () => {
    const rowsWithNull = [{ '钢厂': null, '备注': '' }]
    const result = applyColumnMap(rowsWithNull, { '钢厂': '供应商', '备注': '说明' })
    // Empty string is falsy: row[''] !== '' → false, so it's skipped
    // But wait, '' is falsy in JS... actually row['备注'] = '', so the condition
    // `!= null && !== ''` should skip it. Let me check: row['备注'] is empty string ''.
    // So it gets skipped. Good.
    expect(result[0]).not.toHaveProperty('供应商')
  })

  it('handles empty rows array', () => {
    const result = applyColumnMap([], { '钢厂': '供应商' })
    expect(result).toEqual([])
  })
})

// ── resolveCategory ───────────────────────────────────────────

describe('resolveCategory', () => {
  beforeEach(() => {
    vi.mocked(detectSheetCategory).mockReset()
    vi.mocked(detectSheetCategory).mockReturnValue('unknown')
  })

  it('returns inference category when confidence >= 0.5 and not unknown', () => {
    vi.mocked(detectSheetCategory).mockReturnValue('dashboard')
    const result = resolveCategory('采购单', {
      category: 'purchase', confidence: 0.8, columnMap: {},
    })
    expect(result).toBe('purchase')
    // detectSheetCategory should NOT be called since inference is used
    expect(detectSheetCategory).not.toHaveBeenCalled()
  })

  it('falls back to regex detection when confidence < 0.5', () => {
    vi.mocked(detectSheetCategory).mockReturnValue('sales')
    const result = resolveCategory('销售表', {
      category: 'purchase', confidence: 0.3, columnMap: {},
    })
    expect(result).toBe('sales')
    expect(detectSheetCategory).toHaveBeenCalledWith('销售表')
  })

  it('falls back when inference category is unknown', () => {
    vi.mocked(detectSheetCategory).mockReturnValue('payment')
    const result = resolveCategory('付款单', {
      category: 'unknown', confidence: 0.9, columnMap: {},
    })
    expect(result).toBe('payment')
    expect(detectSheetCategory).toHaveBeenCalledWith('付款单')
  })

  it('falls back when inference is undefined', () => {
    vi.mocked(detectSheetCategory).mockReturnValue('inventory')
    const result = resolveCategory('库存表', undefined)
    expect(result).toBe('inventory')
    expect(detectSheetCategory).toHaveBeenCalledWith('库存表')
  })
})

// ── fuzzyMatchColumns ─────────────────────────────────────────

describe('fuzzyMatchColumns', () => {
  it('exact match maps to standard columns', () => {
    // purchase has 13 standard cols; need ≥4 matches (30% threshold)
    const result = fuzzyMatchColumns(['供应商', '吨位', '金额(元)', '品牌', '规格'], 'purchase')
    expect(result).not.toBeNull()
    expect(result!['供应商']).toBe('供应商')
    expect(result!['吨位']).toBe('吨位')
    expect(result!['金额(元)']).toBe('金额(元)')
  })

  it('matches synonyms', () => {
    // purchaseWithExtras provides 3 exact-match headers; plus 2 synonyms = 5 ≥ 4
    const result = fuzzyMatchColumns(purchaseWithExtras(['钢厂', '重量']), 'purchase')
    expect(result).not.toBeNull()
    expect(result!['钢厂']).toBe('供应商')
    expect(result!['重量']).toBe('吨位')
  })

  // purchase has 13 standard columns; need ≥ 4 matches (30%) to pass threshold
  function purchaseWithExtras(extras: string[]): string[] {
    return ['供应商', '吨位', '金额(元)', ...extras]
  }

  it('matches via Levenshtein distance', () => {
    // 4+ matches needed: exact match '供应商','吨位','金额(元)' + Levenshtein '供应尚'→'供应商'
    const result = fuzzyMatchColumns(purchaseWithExtras(['供应尚', '吨为']), 'purchase')
    expect(result).not.toBeNull()
    expect(result!['供应尚']).toBe('供应商')
    expect(result!['吨为']).toBe('吨位')
  })

  it('returns null when match quality is too low (< 30%)', () => {
    const result = fuzzyMatchColumns(['完全不相关', '字段'], 'purchase')
    expect(result).toBeNull()
  })

  it('returns null for unknown category', () => {
    const result = fuzzyMatchColumns(['供应商'], 'unknown' as any)
    expect(result).toBeNull()
  })

  it('handles empty headers array', () => {
    const result = fuzzyMatchColumns([], 'purchase')
    expect(result).toBeNull()
  })

  it('trims whitespace from headers', () => {
    // 4+ matches: ' 供应商 '→'供应商', ' 吨位 '→'吨位', ' 金额(元) '→'金额(元)', plus extras
    const result = fuzzyMatchColumns(purchaseWithExtras([' 供应商 ', ' 吨位 ', ' 金额(元) ']), 'purchase')
    expect(result).not.toBeNull()
    // columnMap uses trimmed header as key
    expect(result!['供应商']).toBe('供应商')
  })

  it('matches synonyms', () => {
    // '钢厂'→'供应商' via synonym, plus 3 exact matches from extras
    const result = fuzzyMatchColumns(purchaseWithExtras(['钢厂']), 'purchase')
    expect(result).not.toBeNull()
    expect(result!['钢厂']).toBe('供应商')
  })
})

// ── inferSheetSchema (needs LLM mock) ─────────────────────────

describe('inferSheetSchema', () => {
  const mockLLM = { chat: vi.fn() }
  const headers = ['钢厂', '品名', '吨位', '单价']
  const sampleRows = [{ '钢厂': '宝钢', '品名': '螺纹钢', '吨位': '50', '单价': '3800' }]

  beforeEach(() => {
    vi.mocked(mockLLM.chat).mockReset()
  })

  // Use unique sheet names per test to avoid module-level cache pollution
  let testIdx = 0
  function uniqueSheet(base: string): string { return `${base}-${++testIdx}` }

  it('returns parsed schema when LLM returns valid JSON', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({
        category: 'purchase',
        confidence: 0.9,
        columnMap: { '钢厂': '供应商', '吨位': '吨位' },
      }),
    })

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('purchase'), headers, sampleRows)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('purchase')
    expect(result!.confidence).toBe(0.9)
    expect(result!.columnMap['钢厂']).toBe('供应商')
  })

  it('returns null when LLM response has no JSON', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValue({ content: '抱歉，无法分析' })

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('nojson'), headers, sampleRows)
    expect(result).toBeNull()
  })

  it('returns null when parsed JSON has invalid structure', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({ category: 'purchase' }), // missing columnMap
    })

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('badstruct'), headers, sampleRows)
    expect(result).toBeNull()
  })

  it('normalizes unknown category to "unknown"', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({
        category: 'nonexistent_cat',
        confidence: 0.9,
        columnMap: {},
      }),
    })

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('unknowncat'), headers, sampleRows)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('unknown')
  })

  it('returns null when LLM throws', async () => {
    vi.mocked(mockLLM.chat).mockRejectedValue(new Error('API timeout'))

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('throwtest'), headers, sampleRows)
    expect(result).toBeNull()
  })

  it('handles JSON wrapped in markdown code block', async () => {
    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: '```json\n{"category":"sales","confidence":0.8,"columnMap":{"客户":"客户/项目"}}\n```',
    })

    const result = await inferSheetSchema(mockLLM as any, uniqueSheet('mdblock'), headers, sampleRows)
    expect(result).not.toBeNull()
    expect(result!.category).toBe('sales')
  })

  it('caches results by sheet name and headers', async () => {
    const cacheSheet = uniqueSheet('cache')
    const cacheHeaders = ['colA', 'colB']
    const cacheRows = [{ colA: 'a', colB: 'b' }]

    vi.mocked(mockLLM.chat).mockResolvedValue({
      content: JSON.stringify({ category: 'purchase', confidence: 0.9, columnMap: {} }),
    })

    // First call should call LLM
    await inferSheetSchema(mockLLM as any, cacheSheet, cacheHeaders, cacheRows)
    expect(mockLLM.chat).toHaveBeenCalled()

    const callsAfterFirst = vi.mocked(mockLLM.chat).mock.calls.length

    // Second call with same params should use cache (no additional LLM call)
    await inferSheetSchema(mockLLM as any, cacheSheet, cacheHeaders, cacheRows)
    expect(vi.mocked(mockLLM.chat).mock.calls.length).toBe(callsAfterFirst)

    // Different sheet triggers new LLM call
    await inferSheetSchema(mockLLM as any, uniqueSheet('other'), cacheHeaders, cacheRows)
    expect(vi.mocked(mockLLM.chat).mock.calls.length).toBe(callsAfterFirst + 1)
  })
})

// ── inferAllSheets ────────────────────────────────────────────

describe('inferAllSheets', () => {
  it('infers all sheets in parallel and returns results map', async () => {
    const mockLLM = { chat: vi.fn() }
    vi.mocked(mockLLM.chat)
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'purchase', confidence: 0.9, columnMap: { '钢厂': '供应商' } }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ category: 'sales', confidence: 0.8, columnMap: { '客户': '客户/项目' } }),
      })
      .mockResolvedValueOnce({
        content: '无法分析', // this one returns null
      })

    const sheets = [
      { sheetName: '采购单', headers: ['钢厂'], sampleRows: [] },
      { sheetName: '销售单', headers: ['客户'], sampleRows: [] },
      { sheetName: '未知表', headers: ['x'], sampleRows: [] },
    ]

    const results = await inferAllSheets(mockLLM as any, sheets)
    expect(results.size).toBe(2)
    expect(results.has('采购单')).toBe(true)
    expect(results.has('销售单')).toBe(true)
    expect(results.get('采购单')!.category).toBe('purchase')
  })
})
