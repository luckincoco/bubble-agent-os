import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LLMProvider } from '../src/shared/types.js'

// ── Mock crypto ───────────────────────────────────────────────────

vi.mock('node:crypto', () => ({
  randomUUID: vi.fn().mockReturnValue('mock-session-id'),
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { SpecForge, isSpecForgePaused, type SpecForgeOutput } from '../src/connector/code-forge/spec-forge.js'
import { resetConstitutionCache } from '../src/connector/code-forge/constitution.js'

// ── Helpers ───────────────────────────────────────────────────────

/** Short description (< 30 chars) → simple path (plan + implement, 2 phases) */
const SHORT_DESC = '查询今日采购'
/** Long description (>= 30 chars) → complex path (specify + plan + tasks + implement, 4 phases) */
const LONG_DESC = '请查询今天所有供应商的采购订单销售订单物流信息汇总统计报告表格'

function makeLLM(): LLMProvider {
  return {
    chat: vi.fn(),
    chatStream: vi.fn(),
  } as unknown as LLMProvider
}

function makeImplementResponse() {
  return {
    content: '```tool\nconst x = 1\n```\n\n```test\n// test code\n```\n\n```explanation\na simple tool\n```',
    usage: { promptTokens: 30, completionTokens: 20, totalTokens: 50 },
  }
}

function makeSpecResponse() {
  return {
    content: '```spec\nuser_stories:\n  - 作为用户查询数据\nrequirements:\n  - FR-01: 查询功能\nsuccess_criteria:\n  - 输入X返回Y\nedge_cases: []\nclarifications: []\n```',
    usage: { promptTokens: 40, completionTokens: 15, totalTokens: 55 },
  }
}

function makePlanResponse() {
  return {
    content: '```plan\napproach: 调用getPurchases查询\nparameters:\n  - name: date\n    type: string\n    required: true\ndependencies: none\n```',
    usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
  }
}

function makeTasksResponse() {
  return {
    content: '```tasks\n- T001: 实现查询逻辑 | 30\n- T002: 格式化输出 | 20\n```',
    usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 },
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('SpecForge', () => {
  let forge: SpecForge
  let llm: LLMProvider
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'spec-forge-test-'))
    resetConstitutionCache()
    llm = makeLLM()
    forge = new SpecForge(llm, tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  // ── isSpecForgePaused ───────────────────────────────────────────

  describe('isSpecForgePaused', () => {
    it('returns true for paused output', () => {
      const output = { status: 'paused' as const, sessionId: 's1', clarifications: [], session: {} as any }
      expect(isSpecForgePaused(output)).toBe(true)
    })

    it('returns false for completed output', () => {
      const output = { forge: {} as any, session: { status: 'completed' as const } } as SpecForgeOutput
      expect(isSpecForgePaused(output)).toBe(false)
    })
  })

  // ── Simple path (short desc) ────────────────────────────────────

  describe('simple path', () => {
    beforeEach(() => {
      llm.chat = vi.fn()
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeImplementResponse())
    })

    it('returns forge result with isSimple=true', async () => {
      const result = await forge.run({ description: SHORT_DESC })
      expect('forge' in result).toBe(true)
      if ('forge' in result) {
        expect(result.session.isSimple).toBe(true)
        expect(result.forge.code).toContain('const x = 1')
        expect(llm.chat).toHaveBeenCalledTimes(2) // plan + implement
      }
    })

    it('accumulates token usage across phases', async () => {
      const result = await forge.run({ description: SHORT_DESC })
      if ('forge' in result) {
        expect(result.session.tokenUsage.total).toBe(90) // 40 + 50
        expect(result.forge.tokenUsage?.total).toBe(90)
      }
    })
  })

  // ── Complex path (long desc) ────────────────────────────────────

  describe('complex path', () => {
    beforeEach(() => {
      llm.chat = vi.fn()
        .mockResolvedValueOnce(makeSpecResponse())
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeTasksResponse())
        .mockResolvedValueOnce(makeImplementResponse())
    })

    it('runs all 4 phases and returns forge result', async () => {
      const result = await forge.run({ description: LONG_DESC })
      expect('forge' in result).toBe(true)
      if ('forge' in result) {
        expect(result.session.isSimple).toBe(false)
        expect(llm.chat).toHaveBeenCalledTimes(4)
      }
    })
  })

  // ── Pause on clarification ──────────────────────────────────────

  describe('pause on clarification', () => {
    beforeEach(() => {
      llm.chat = vi.fn().mockResolvedValueOnce({
        content: '[NEEDS CLARIFICATION]\n- 请确认查询的时间范围\n\n```spec\nclarifications:\n  - 请确认查询的时间范围\n```',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      })
    })

    it('pauses when specify phase needs clarification', async () => {
      const result = await forge.run({ description: LONG_DESC })
      expect(isSpecForgePaused(result)).toBe(true)
      if (isSpecForgePaused(result)) {
        expect(result.clarifications).toContain('请确认查询的时间范围')
        expect(result.session.status).toBe('paused')
        expect(llm.chat).toHaveBeenCalledTimes(1) // only specify phase
      }
    })
  })

  // ── Resume ──────────────────────────────────────────────────────

  describe('resume', () => {
    it('resumes paused session and completes pipeline', async () => {
      // First run — pauses on specify
      llm.chat = vi.fn().mockResolvedValueOnce({
        content: '[NEEDS CLARIFICATION]\n- 请确认时间范围\n\n```spec\nclarifications:\n  - 请确认时间范围\n```',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      })
      const paused = await forge.run({ description: LONG_DESC })
      expect(isSpecForgePaused(paused)).toBe(true)

      // Resume — 4 phases
      llm.chat = vi.fn()
        .mockResolvedValueOnce(makeSpecResponse())
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeTasksResponse())
        .mockResolvedValueOnce(makeImplementResponse())

      const resumed = await forge.resume((paused as any).sessionId, '查询本周数据')
      expect('forge' in resumed).toBe(true)
      if ('forge' in resumed) {
        expect(resumed.session.status).toBe('completed')
        expect(llm.chat).toHaveBeenCalledTimes(4)
      }
    })

    it('throws when session not found', async () => {
      await expect(forge.resume('nonexistent', 'clarify')).rejects.toThrow('Session not found')
    })

    it('throws when session is not paused', async () => {
      llm.chat = vi.fn()
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeImplementResponse())
      const result = await forge.run({ description: SHORT_DESC })
      if ('forge' in result) {
        await expect(forge.resume(result.session.id, 'clarify')).rejects.toThrow('not paused')
      }
    })
  })

  // ── getSession / listSessions ───────────────────────────────────

  describe('getSession / listSessions', () => {
    beforeEach(() => {
      llm.chat = vi.fn()
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeImplementResponse())
    })

    it('getSession returns undefined for unknown session', () => {
      expect(forge.getSession('unknown')).toBeUndefined()
    })

    it('getSession returns session after run', async () => {
      await forge.run({ description: SHORT_DESC })
      const session = forge.getSession('mock-session-id')
      expect(session).toBeDefined()
      expect(session!.request.description).toBe(SHORT_DESC)
    })

    it('listSessions returns all sessions sorted recent-first', async () => {
      // Mock unique UUIDs per session
      const crypto = await import('node:crypto')
      vi.mocked(crypto.randomUUID)
        .mockReturnValueOnce('session-1')
        .mockReturnValueOnce('session-2')

      llm.chat = vi.fn()
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeImplementResponse())
        .mockResolvedValueOnce(makePlanResponse())
        .mockResolvedValueOnce(makeImplementResponse())

      await forge.run({ description: '第一个请求' })
      // Small delay to ensure different startedAt timestamps
      await new Promise(r => setTimeout(r, 5))
      await forge.run({ description: '第二个请求' })

      const sessions = forge.listSessions()
      expect(sessions).toHaveLength(2)
      // Recent first: second request started after the delay
      expect(sessions[0].request.description).toBe('第二个请求')
      expect(sessions[1].request.description).toBe('第一个请求')
    })
  })

  // ── Private helpers ─────────────────────────────────────────────

  describe('extractClarifications', () => {
    it('extracts from spec YAML clarifications field', () => {
      const content = '```spec\nclarifications:\n  - 请确认时间范围\n  - 请确认供应商\n```'
      const result = (forge as any).extractClarifications(content)
      expect(result).toHaveLength(2)
      expect(result[0]).toBe('请确认时间范围')
    })

    it('falls back to lines after [NEEDS CLARIFICATION]', () => {
      const content = 'some text\n[NEEDS CLARIFICATION]\n- 请补充细节\n- 确认数据范围'
      const result = (forge as any).extractClarifications(content)
      expect(result).toContain('请补充细节')
      expect(result).toContain('确认数据范围')
    })

    it('returns default when nothing found', () => {
      const result = (forge as any).extractClarifications('plain text')
      expect(result).toEqual(['需求描述不够明确，请补充更多细节。'])
    })
  })

  describe('parseImplementOutput', () => {
    it('extracts tool/test/explanation from standard blocks', () => {
      const session = {
        request: {},
        artifacts: {
          implement: '```tool\nconst a = 1\n```\n\n```test\n// test\n```\n\n```explanation\na tool\n```',
        },
        tokenUsage: { prompt: 100, completion: 50, total: 150 },
      } as any
      const result = (forge as any).parseImplementOutput(session)
      expect(result.toolName).toBe('unnamed_tool')
      expect(result.code).toBe('const a = 1')
      expect(result.testCode).toBe('// test')
      expect(result.explanation).toBe('a tool')
      expect(result.tokenUsage.total).toBe(150)
    })

    it('falls back to suggestedName when no name match in code', () => {
      const session = {
        request: { suggestedName: 'myQueryTool' },
        artifacts: { implement: '```tool\n// no name\n```' },
        tokenUsage: { prompt: 0, completion: 0, total: 0 },
      } as any
      const result = (forge as any).parseImplementOutput(session)
      expect(result.toolName).toBe('myQueryTool')
    })
  })

  describe('buildPhaseUserMessage', () => {
    it('specify phase includes description, suggestedName, category', () => {
      const session = { request: { description: '查询', suggestedName: 'q', category: 'biz-query' }, artifacts: {} } as any
      const msg = (forge as any).buildPhaseUserMessage(session, 'specify')
      expect(msg).toContain('查询')
      expect(msg).toContain('q')
      expect(msg).toContain('biz-query')
    })

    it('plan phase includes spec artifact', () => {
      const session = { request: { description: '查询' }, artifacts: { specify: '用户需要查询今日采购数据' } } as any
      const msg = (forge as any).buildPhaseUserMessage(session, 'plan')
      expect(msg).toContain('查询')
      expect(msg).toContain('用户需要查询今日采购数据')
    })
  })
})
