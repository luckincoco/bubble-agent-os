import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mocks ─────────────────────────────────────────────────────

const mockRun = vi.fn()
const mockResume = vi.fn()
const mockVerify = vi.fn()
const mockSavePendingTool = vi.fn()

const mockSpecForgeInstance = { run: mockRun, resume: mockResume }
const mockSandboxInstance = { verify: mockVerify }
const mockDynamicLoaderInstance = { savePendingTool: mockSavePendingTool }

vi.mock('../src/connector/code-forge/index.js', () => ({
  SpecForge: vi.fn(function() { return mockSpecForgeInstance }),
  isSpecForgePaused: vi.fn(() => false),
  Sandbox: vi.fn(function() { return mockSandboxInstance }),
  DynamicLoader: vi.fn(function() { return mockDynamicLoaderInstance }),
}))

// We need to reset the module-level singleton between tests
beforeEach(() => {
  vi.clearAllMocks()
  // Reset the module-level specForgeInstance
  vi.resetModules()
})

// ── Import after mocks ────────────────────────────────────────

import { createSelfForgeTool } from '../src/connector/tools/self-forge-tool.js'
import { isSpecForgePaused } from '../src/connector/code-forge/index.js'

const mockLLM = { chat: vi.fn() } as any
const mockCtx = { userId: 'admin-1', activeSpaceId: 'space-1' } as any

function makeTool() {
  return createSelfForgeTool(mockLLM, '/tmp/test-project')
}

describe('createSelfForgeTool', () => {
  describe('tool definition', () => {
    it('returns a ToolDefinition with correct name and parameters', () => {
      const tool = makeTool()
      expect(tool.name).toBe('self_forge')
      expect(tool.description).toContain('自编码')
      expect(tool.parameters).toHaveProperty('description')
      expect(tool.parameters).toHaveProperty('tool_name')
      expect(tool.parameters).toHaveProperty('resume_session')
      expect(tool.parameters).toHaveProperty('clarification')
      expect(tool.timeout).toBe(180_000)
    })
  })

  describe('execute validation', () => {
    it('returns error when description is empty and no resume_session', async () => {
      const tool = makeTool()
      const result = await tool.execute({ description: '' }, mockCtx)
      expect(result).toContain('需要提供功能需求描述')
    })

    it('handles whitespace-only description', async () => {
      const tool = makeTool()
      const result = await tool.execute({ description: '   ' }, mockCtx)
      expect(result).toContain('需要提供功能需求描述')
    })
  })

  describe('execute new pipeline', () => {
    it('starts a new SpecForge pipeline with description', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'testTool', code: '// code', explanation: '测试工具', tokenUsage: { total: 500 } },
        session: { isSimple: true, id: 'sess-1', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      const result = await tool.execute({ description: '生成一个查询供应商的工具' }, mockCtx)

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({ description: '生成一个查询供应商的工具' }),
      )
      expect(result).toContain('测试工具')
      expect(result).toContain('testTool')
      expect(result).toContain('安全检查')
      expect(result).toContain('通过')
    })

    it('passes suggestedName when provided', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'query_supplier', code: '// code', explanation: '', tokenUsage: {} },
        session: { isSimple: true, id: 'sess-2', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      await tool.execute({ description: '查供应商', tool_name: 'query_supplier' }, mockCtx)

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({ suggestedName: 'query_supplier' }),
      )
    })

    it('passes category as biz-query', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 't', code: '', explanation: '', tokenUsage: {} },
        session: { isSimple: true, id: 'sess-3', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      await tool.execute({ description: 'test' }, mockCtx)

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'biz-query' }),
      )
    })
  })

  describe('execute paused / clarification', () => {
    it('returns clarification questions when pipeline is paused', async () => {
      vi.mocked(isSpecForgePaused).mockReturnValue(true)
      mockRun.mockResolvedValue({
        clarifications: ['查询条件是什么？', '数据来源是哪个表？'],
        sessionId: 'sess-pause-1',
        forge: null,
        session: {},
      })

      const tool = makeTool()
      const result = await tool.execute({ description: '查供应商' }, mockCtx)

      expect(result).toContain('需要确认')
      expect(result).toContain('查询条件是什么？')
      expect(result).toContain('数据来源是哪个表？')
      expect(result).toContain('sess-pause-1')
      expect(result).toContain('resume_session')
    })
  })

  describe('execute resume', () => {
    it('calls specForge.resume when resume_session and clarification provided', async () => {
      mockResume.mockResolvedValue({
        forge: { toolName: 'resumedTool', code: '// code', explanation: '恢复生成', tokenUsage: {} },
        session: { isSimple: true, id: 'sess-resume', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })
      vi.mocked(isSpecForgePaused).mockReturnValue(false)

      const tool = makeTool()
      const result = await tool.execute({
        description: '',
        resume_session: 'sess-resume',
        clarification: '查询供应商名称和联系方式',
      }, mockCtx)

      expect(mockResume).toHaveBeenCalledWith('sess-resume', '查询供应商名称和联系方式')
      expect(result).toContain('resumedTool')
      expect(result).toContain('恢复生成')
    })
  })

  describe('execute static analysis results', () => {
    it('saves pending tool when static analysis passes', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'safeTool', code: '// safe code', explanation: '安全工具', tokenUsage: { total: 100 } },
        session: { isSimple: true, id: 'sess-ok', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      await tool.execute({ description: '安全的工具' }, mockCtx)

      expect(mockSavePendingTool).toHaveBeenCalledWith(
        'safeTool', '// safe code', '安全工具', expect.any(Object),
      )
    })

    it('shows compilation warnings when analysis passes but compilation has warnings', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'warnTool', code: '// code', explanation: '', tokenUsage: {} },
        session: { isSimple: true, id: 'sess-warn', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: false, errors: ['TS1234: unused variable'] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      const result = await tool.execute({ description: '带警告的工具' }, mockCtx)

      expect(result).toContain('编译有警告')
      expect(result).toContain('TS1234')
    })

    it('returns failure message when static analysis fails', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'badTool', code: '// bad code', explanation: '', tokenUsage: {} },
        session: { isSimple: true, id: 'sess-bad', artifacts: {} },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: false, violations: ['检测到 eval 调用', '检测到 exec'] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'high',
      })

      const tool = makeTool()
      const result = await tool.execute({ description: '不安全的工具' }, mockCtx)

      expect(result).toContain('未通过')
      expect(result).toContain('检测到 eval 调用')
      expect(result).toContain('风险等级')
      // Should NOT save pending tool
      expect(mockSavePendingTool).not.toHaveBeenCalled()
    })
  })

  describe('execute error handling', () => {
    it('catches errors and returns user-friendly message', async () => {
      mockRun.mockRejectedValue(new Error('LLM API 调用失败'))

      const tool = makeTool()
      const result = await tool.execute({ description: '会失败的工具' }, mockCtx)

      expect(result).toContain('代码生成失败')
      expect(result).toContain('LLM API 调用失败')
    })
  })

  describe('execute full pipeline artifacts', () => {
    it('includes spec artifacts when full pipeline used', async () => {
      mockRun.mockResolvedValue({
        forge: { toolName: 'fullTool', code: '// code', explanation: '完整管线', tokenUsage: {} },
        session: { isSimple: false, id: 'sess-full', artifacts: { specify: '# 需求规格\n查询接口' } },
      })
      mockVerify.mockResolvedValue({
        staticAnalysis: { passed: true, violations: [] },
        compilation: { passed: true, errors: [] },
        riskLevel: 'low',
      })

      const tool = makeTool()
      const result = await tool.execute({ description: '完整管线' }, mockCtx)

      expect(result).toContain('完整')
      expect(result).toContain('需求规格')
      expect(result).toContain('查询接口')
    })
  })
})
