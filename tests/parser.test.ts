import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TeachParser } from '../src/connector/teach/parser.js'

describe('TeachParser', () => {
  const mockChat = vi.fn()
  const mockLLM = { chat: mockChat }
  let parser: TeachParser

  beforeEach(() => {
    mockChat.mockReset()
    parser = new TeachParser(mockLLM as any)
  })

  it('creates instance with parse method', () => {
    expect(parser).toBeInstanceOf(TeachParser)
    expect(typeof parser.parse).toBe('function')
  })

  it('returns valid TeachRecord with all fields', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        entityName: '螺纹钢供应商',
        entityType: 'supplier',
        attribute: '联系人',
        value: '张三',
        factText: '螺纹钢供应商的联系人是张三',
        tags: ['螺纹钢', '供应商'],
      }),
    })

    const result = await parser.parse('螺纹钢供应商联系人是张三', 'remember', '泡泡记住: 螺纹钢供应商联系人是张三')
    expect(result).not.toBeNull()
    expect(result!.entityName).toBe('螺纹钢供应商')
    expect(result!.entityType).toBe('supplier')
    expect(result!.attribute).toBe('联系人')
    expect(result!.value).toBe('张三')
    expect(result!.factText).toBe('螺纹钢供应商的联系人是张三')
    expect(result!.tags).toEqual(['螺纹钢', '供应商'])
    expect(result!.action).toBe('remember')
    expect(result!.rawInput).toBe('泡泡记住: 螺纹钢供应商联系人是张三')
  })

  it('handles JSON wrapped in markdown code block', async () => {
    mockChat.mockResolvedValue({
      content: '```json\n{"entityName":"项目A","entityType":"project","factText":"项目A已完成","tags":["项目A"]}\n```',
    })

    const result = await parser.parse('项目A已完成', 'remember', 'raw')
    expect(result).not.toBeNull()
    expect(result!.entityName).toBe('项目A')
  })

  it('returns null when no JSON in response', async () => {
    mockChat.mockResolvedValue({ content: '我不确定怎么解析' })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result).toBeNull()
  })

  it('returns null when entityName is missing', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ entityType: 'supplier', factText: 'fact', tags: [] }),
    })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result).toBeNull()
  })

  it('returns null when factText is missing', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({ entityName: 'Entity', entityType: 'supplier', tags: [] }),
    })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result).toBeNull()
  })

  it('defaults invalid entityType to "other"', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        entityName: 'X', entityType: 'invalid_type', factText: 'fact', tags: [],
      }),
    })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result!.entityType).toBe('other')
  })

  it('filters non-string tags', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        entityName: 'X', entityType: 'supplier', factText: 'fact', tags: ['tag1', 'tag2', 123],
      }),
    })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result!.tags).toEqual(['tag1', 'tag2'])
  })

  it('uses empty tags when tags is not an array', async () => {
    mockChat.mockResolvedValue({
      content: JSON.stringify({
        entityName: 'X', entityType: 'supplier', factText: 'fact', tags: 'not-an-array',
      }),
    })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result!.tags).toEqual([])
  })

  it('returns null when LLM.chat throws', async () => {
    mockChat.mockRejectedValue(new Error('API error'))
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result).toBeNull()
  })

  it('returns null on JSON parse error', async () => {
    mockChat.mockResolvedValue({ content: '{ malformed json }' })
    const result = await parser.parse('test', 'remember', 'raw')
    expect(result).toBeNull()
  })
})
