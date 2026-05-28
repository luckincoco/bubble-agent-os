import { describe, it, expect } from 'vitest'
import { generateValuePropositions, buildValueStatement } from '../src/cognition/data-valuation.js'

describe('generateValuePropositions', () => {
  it('returns empty array for no DATA blocks', () => {
    const result = generateValuePropositions([{ name: 'biz_test', result: 'no data block' }], '')
    expect(result).toHaveLength(0)
  })

  it('generates inventory proposition with brand and stock', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_inventory',
      result: `markdown\n\n[DATA]\n{"tool":"biz_inventory","computedAt":${now},"data":{"items":[{"brand":"沙钢","name":"螺纹钢","spec":"Φ25","stockTons":50}],"totals":{"stockTons":50}}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '螺纹钢')
    expect(result).toHaveLength(1)
    expect(result[0].label).toContain('沙钢')
    expect(result[0].label).toContain('螺纹钢')
    expect(result[0].label).toContain('50')
    expect(result[0].relevance).toContain('螺纹钢')
    expect(result[0].source).toBe('库存查询')
    expect(result[0].confidence).toBeGreaterThan(0)
  })

  it('generates receivable proposition with amount', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_receivables',
      result: `[DATA]\n{"tool":"biz_receivables","computedAt":${now},"data":{"items":[],"totals":{"outstanding":200000}}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '')
    expect(result).toHaveLength(1)
    expect(result[0].label).toContain('应收')
    expect(result[0].label).toContain('200,000')
  })

  it('generates payable proposition', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_payables',
      result: `[DATA]\n{"tool":"biz_payables","computedAt":${now},"data":{"items":[],"totals":{"amount":150000}}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '')
    expect(result).toHaveLength(1)
    expect(result[0].label).toContain('应付')
    expect(result[0].label).toContain('150,000')
  })

  it('generates dashboard proposition with multi-metric summary', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_dashboard',
      result: `[DATA]\n{"tool":"biz_dashboard","computedAt":${now},"data":{"totalStockTons":500,"totalReceivable":200000,"totalPayable":150000}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '概览')
    expect(result).toHaveLength(1)
    expect(result[0].label).toContain('库存 500 吨')
    expect(result[0].label).toContain('应收')
    expect(result[0].label).toContain('应付')
  })

  it('highlights relevance when query matches item name', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_inventory',
      result: `[DATA]\n{"tool":"biz_inventory","computedAt":${now},"data":{"items":[{"brand":"日照","name":"热轧卷板","spec":"5.75mm","stockTons":120}],"totals":{"stockTons":120}}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '热轧卷板价格')
    expect(result[0].relevance).toContain('热轧卷板')
    expect(result[0].relevance).toContain('120')
  })

  it('skips unparseable DATA blocks silently', () => {
    const toolCalls = [{ name: 'biz_test', result: '[DATA]\n{invalid json\n[/DATA]' }]
    const result = generateValuePropositions(toolCalls, '')
    expect(result).toHaveLength(0)
  })

  it('handles multiple tool calls', () => {
    const now = Date.now()
    const toolCalls = [
      {
        name: 'biz_inventory',
        result: `[DATA]\n{"tool":"biz_inventory","computedAt":${now},"data":{"items":[],"totals":{"stockTons":50}}}\n[/DATA]`,
      },
      {
        name: 'biz_receivables',
        result: `[DATA]\n{"tool":"biz_receivables","computedAt":${now},"data":{"items":[],"totals":{"outstanding":200000}}}\n[/DATA]`,
      },
    ]
    const result = generateValuePropositions(toolCalls, '应收和库存')
    expect(result).toHaveLength(2)
    expect(result[0].source).toBe('库存查询')
    expect(result[1].source).toBe('应收报表')
  })

  it('handles exposure data', () => {
    const now = Date.now()
    const toolCalls = [{
      name: 'biz_exposure',
      result: `[DATA]\n{"tool":"biz_exposure","computedAt":${now},"data":{"items":[{"counterparty_name":"华瑞龙","exposure":500000}],"totals":{"totalExposure":500000}}}\n[/DATA]`,
    }]
    const result = generateValuePropositions(toolCalls, '华瑞龙')
    expect(result).toHaveLength(1)
    expect(result[0].label).toContain('华瑞龙')
    expect(result[0].label).toContain('500,000')
  })
})

describe('buildValueStatement', () => {
  it('returns empty string for empty array', () => {
    expect(buildValueStatement([])).toBe('')
  })

  it('formats propositions with label and relevance', () => {
    const result = buildValueStatement([
      { label: '螺纹钢 50 吨', relevance: '与你库存 50 吨相关', source: '库存查询', confidence: 0.8 },
    ])
    expect(result).toContain('与你相关的')
    expect(result).toContain('1 条信息')
    expect(result).toContain('螺纹钢 50 吨')
    expect(result).toContain('与你库存 50 吨相关')
  })

  it('handles multiple propositions', () => {
    const result = buildValueStatement([
      { label: '螺纹钢 50 吨', relevance: '库存', source: '库存查询', confidence: 0.8 },
      { label: '应收 ¥200,000', relevance: '应收报表', source: '应收报表', confidence: 0.8 },
    ])
    expect(result).toContain('2 条信息')
  })
})
