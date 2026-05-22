import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LLMProvider } from '../src/shared/types.js'

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { CodeForge } from '../src/connector/code-forge/forge.js'

// ── Helpers ────────────────────────────────────────────────────────

function makeLLM(overrides: Partial<LLMProvider> = {}): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      content: '```tool\nconst code = "hello"\n```\n\n```test\n// test code\n```\n\n```explanation\n测试工具\n```',
      usage: { promptTokens: 50, completionTokens: 30, totalTokens: 80 },
    }),
    chatStream: vi.fn(),
    ...overrides,
  } as unknown as LLMProvider
}

// ── Tests ─────────────────────────────────────────────────────────

describe('CodeForge', () => {
  let forge: CodeForge
  let llm: LLMProvider

  beforeEach(() => {
    llm = makeLLM()
    forge = new CodeForge(llm)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('buildUserPrompt', () => {
    it('includes description', () => {
      const prompt = (forge as any).buildUserPrompt({ description: '查询今日采购' })
      expect(prompt).toContain('查询今日采购')
    })

    it('includes suggested name when provided', () => {
      const prompt = (forge as any).buildUserPrompt({
        description: '查询今日采购',
        suggestedName: 'queryPurchase',
      })
      expect(prompt).toContain('queryPurchase')
    })

    it('includes category when provided', () => {
      const prompt = (forge as any).buildUserPrompt({
        description: '查询今日采购',
        category: 'biz-query',
      })
      expect(prompt).toContain('biz-query')
    })
  })

  describe('parseResponse', () => {
    it('extracts tool, test, and explanation from code blocks', () => {
      const result = (forge as any).parseResponse(
        '```tool\nconst x = 1\n```\n\n```test\n// test\n```\n\n```explanation\ndoes x\n```',
      )
      expect(result.toolName).toBe('unnamed_tool')
      expect(result.code).toBe('const x = 1')
      expect(result.testCode).toBe('// test')
      expect(result.explanation).toBe('does x')
    })

    it('extracts tool name from code', () => {
      const result = (forge as any).parseResponse(
        '```tool\nname: "myTool"\n```\n\n```test\n// test\n```\n\n```explanation\ntool\n```',
      )
      expect(result.toolName).toBe('myTool')
    })

    it('falls back to typescript block when tool block missing', () => {
      const result = (forge as any).parseResponse(
        '```typescript\nconst fallback = true\n```',
      )
      expect(result.code).toBe('const fallback = true')
    })

    it('returns empty code and unnamed_tool when no blocks found', () => {
      const result = (forge as any).parseResponse('plain text response')
      expect(result.code).toBe('')
      expect(result.toolName).toBe('unnamed_tool')
      expect(result.testCode).toBe('')
    })

    it('uses default explanation when explanation block missing', () => {
      const result = (forge as any).parseResponse('```tool\nconst x = 1\n```')
      expect(result.explanation).toBe('（未提供解释）')
    })
  })

  describe('generate', () => {
    it('returns forge result with token usage', async () => {
      const result = await forge.generate({ description: '测试工具' })
      expect(result.toolName).toBe('unnamed_tool')
      expect(result.code).toBe('const code = "hello"')
      expect(result.testCode).toBe('// test code')
      expect(result.explanation).toBe('测试工具')
      expect(result.tokenUsage).toEqual({ prompt: 50, completion: 30, total: 80 })
    })

    it('passes suggested name and category to LLM', async () => {
      await forge.generate({
        description: '查询工具',
        suggestedName: 'queryTool',
        category: 'biz-query',
      })
      const messages = (llm.chat as any).mock.calls[0][0]
      const userMsg = messages.find((m: any) => m.role === 'user')
      expect(userMsg.content).toContain('queryTool')
      expect(userMsg.content).toContain('biz-query')
    })

    it('returns partial result when LLM returns no code blocks', async () => {
      llm = makeLLM({
        chat: vi.fn().mockResolvedValue({
          content: '这里没有代码块',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        }),
      })
      forge = new CodeForge(llm)
      const result = await forge.generate({ description: '测试' })
      expect(result.code).toBe('')
      expect(result.toolName).toBe('unnamed_tool')
      expect(result.tokenUsage?.total).toBe(15)
    })

    it('propagates LLM errors', async () => {
      llm = makeLLM({
        chat: vi.fn().mockRejectedValue(new Error('API timeout')),
      })
      forge = new CodeForge(llm)
      await expect(forge.generate({ description: '测试' })).rejects.toThrow('API timeout')
    })

    it('handles LLM response without usage', async () => {
      llm = makeLLM({
        chat: vi.fn().mockResolvedValue({
          content: '```tool\nconst a = 1\n```\n\n```test\n// t\n```\n\n```explanation\ne\n```',
          usage: undefined,
        }),
      })
      forge = new CodeForge(llm)
      const result = await forge.generate({ description: '测试' })
      expect(result.tokenUsage).toBeUndefined()
    })
  })
})
