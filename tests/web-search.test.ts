import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWebSearchTool } from '../src/connector/tools/web-search.js'

async function withEnv<T>(env: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) saved[k] = process.env[k]
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('createWebSearchTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env.TAVILY_API_KEY
  })

  function mockSearchResponse(data: any) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(data), { status: 200 })
  }

  it('returns a ToolDefinition with name web_search', () => {
    const tool = createWebSearchTool()
    expect(tool.name).toBe('web_search')
    expect(tool.parameters).toHaveProperty('query')
    expect(typeof tool.execute).toBe('function')
  })

  it('execute returns error when query is empty', async () => {
    const tool = createWebSearchTool()
    const result = await tool.execute({ query: '' })
    expect(result).toContain('搜索关键词')
  })

  it('execute returns error when TAVILY_API_KEY is missing', async () => {
    const tool = createWebSearchTool()
    const result = await tool.execute({ query: 'test' })
    expect(result).toContain('未配置搜索 API Key')
  })

  it('execute parses search results correctly', async () => {
    mockSearchResponse({
      results: [
        { title: 'Result 1', url: 'https://example.com/1', content: 'Content 1' },
        { title: 'Result 2', url: 'https://example.com/2', content: 'Content 2' },
      ],
      answer: 'Summary text',
    })

    withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
      const tool = createWebSearchTool()
      const result = await tool.execute({ query: 'steel price' })
      expect(result).toContain('steel price')
      expect(result).toContain('Result 1')
      expect(result).toContain('Result 2')
      expect(result).toContain('Summary')
      expect(result).toContain('2 条结果')
    })
  })

  it('execute handles no results', async () => {
    mockSearchResponse({ results: [] })

    withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
      const tool = createWebSearchTool()
      const result = await tool.execute({ query: 'zzzznonexistent' })
      expect(result).toContain('未找到')
    })
  })

  it('execute handles API error', async () => {
    globalThis.fetch = async () => new Response('Rate limit', { status: 429 })

    withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
      const tool = createWebSearchTool()
      const result = await tool.execute({ query: 'test' })
      expect(result).toContain('搜索失败')
      expect(result).toContain('429')
    })
  })

  it('execute handles network error gracefully', async () => {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }

    withEnv({ TAVILY_API_KEY: 'test-key' }, async () => {
      const tool = createWebSearchTool()
      const result = await tool.execute({ query: 'test' })
      expect(result).toContain('搜索出错')
    })
  })
})
