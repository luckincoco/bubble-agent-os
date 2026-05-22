import { describe, it, expect, vi } from 'vitest'
import { MemoryExtractor } from '../src/memory/extractor.js'
import type { LLMProvider } from '../src/shared/types.js'

function mockLLM(response: string): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ content: response }),
  } as unknown as LLMProvider
}

// ── 有效 JSON 解析 ─────────────────────────────────────────────────

describe('extract — JSON 解析', () => {
  it('LLM 返回有效 JSON 数组', async () => {
    const llm = mockLLM(`[{"title": "用户姓名", "content": "用户叫张三", "tags": ["identity"], "confidence": 1.0}]`)
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('你好', '你好张三')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('用户姓名')
    expect(result[0].content).toBe('用户叫张三')
    expect(result[0].tags).toEqual(['identity'])
    expect(result[0].confidence).toBe(1.0)
  })

  it('解析 ```json 代码块中的 JSON', async () => {
    const llm = mockLLM('```json\n[{"title": "偏好", "content": "喜欢喝茶", "tags": ["preference"], "confidence": 0.8}]\n```')
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('喝什么', '推荐绿茶')
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('偏好')
  })

  it('LLM 返回空数组', async () => {
    const llm = mockLLM('[]')
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('你好', '你好')
    expect(result).toEqual([])
  })

  it('多条记录同时返回', async () => {
    const llm = mockLLM(JSON.stringify([
      { title: 'A', content: '内容A', tags: ['t1'], confidence: 0.9 },
      { title: 'B', content: '内容B', tags: ['t2'], confidence: 0.7 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('a', 'b')
    expect(result).toHaveLength(2)
  })
})

// ── 错误处理 ──────────────────────────────────────────────────────

describe('extract — 错误处理', () => {
  it('无效 JSON 返回空数组', async () => {
    const llm = mockLLM('这不是 JSON')
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('hi', 'hello')
    expect(result).toEqual([])
  })

  it('LLM 抛出异常返回空数组', async () => {
    const llm = { chat: vi.fn().mockRejectedValue(new Error('API error')) } as unknown as LLMProvider
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('hi', 'hello')
    expect(result).toEqual([])
  })

  it('非数组 JSON 返回空数组', async () => {
    const llm = mockLLM('{"not": "array"}')
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('hi', 'hello')
    expect(result).toEqual([])
  })
})

// ── 验证与过滤 ────────────────────────────────────────────────────

describe('extract — 验证与过滤', () => {
  it('缺少 title 的条目被过滤', async () => {
    const llm = mockLLM(JSON.stringify([
      { content: '无标题', tags: ['x'], confidence: 0.5 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('x', 'y')
    expect(result).toEqual([])
  })

  it('缺少 content 的条目被过滤', async () => {
    const llm = mockLLM(JSON.stringify([
      { title: '无内容', tags: ['x'], confidence: 0.5 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('x', 'y')
    expect(result).toEqual([])
  })

  it('tags 不是数组时默认为空数组', async () => {
    const llm = mockLLM(JSON.stringify([
      { title: 'T', content: 'C', tags: 'invalid', confidence: 0.5 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('x', 'y')
    expect(result).toHaveLength(1)
    expect(result[0].tags).toEqual([])
  })

  it('confidence 被限制在 [0, 1] 范围内', async () => {
    const llm = mockLLM(JSON.stringify([
      { title: '太高', content: 'C', tags: [], confidence: 5.0 },
      { title: '正常', content: 'C', tags: [], confidence: 0.7 },
      { title: '负值', content: 'C', tags: [], confidence: -1.0 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('x', 'y')
    expect(result).toHaveLength(3)
    expect(result[0].confidence).toBe(1.0) // clamped
    expect(result[1].confidence).toBe(0.7) // unchanged
    expect(result[2].confidence).toBe(0.0) // clamped
  })
})

// ── 边界情况 ──────────────────────────────────────────────────────

describe('extract — 边界情况', () => {
  it('混合有效与无效条目 — 只保留有效', async () => {
    const llm = mockLLM(JSON.stringify([
      { title: '有效', content: '有效内容', tags: ['ok'], confidence: 0.9 },
      { content: '缺标题' },
      { title: '缺内容', tags: [] },
      { title: '有效2', content: '内容2', tags: ['ok2'], confidence: 0.8 },
    ]))
    const extractor = new MemoryExtractor(llm)

    const result = await extractor.extract('x', 'y')
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe('有效')
    expect(result[1].title).toBe('有效2')
  })
})
