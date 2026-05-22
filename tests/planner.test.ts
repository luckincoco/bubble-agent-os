import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('../src/temporal/task-ledger.js', () => ({
  createLedger: vi.fn(() => ({ id: 'ledger-1' })),
  addCheckpoint: vi.fn(),
  setPendingAction: vi.fn(),
  updateLedgerStatus: vi.fn(),
  updatePlanSteps: vi.fn(),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'ulid-mock'),
}))

import {
  generatePlan,
  startPlan,
  executeStep,
  classifyFailure,
  shouldUsePlanMode,
  type ExecutionPlan,
  type PlanStep,
} from '../src/workflow/planner.js'
import { createLedger, addCheckpoint, setPendingAction } from '../src/temporal/task-ledger.js'
import type { LLMProvider } from '../src/shared/types.js'
import type { UserContext } from '../src/shared/types.js'
import type { ToolRegistry } from '../src/connector/registry.js'

// ── Helpers ──────────────────────────────────────────────────────

function makeLLM(): LLMProvider {
  return { chat: vi.fn(), chatStream: vi.fn() } as LLMProvider
}

function makeTools(): ToolRegistry {
  return {
    get: vi.fn(),
    execute: vi.fn(),
    getToolDescriptions: vi.fn(() => 'search, calc, get_time'),
  } as unknown as ToolRegistry
}

function makeCtx(): UserContext {
  return { activeSpaceId: 'space-1', userId: 'user-1' } as UserContext
}

function makeStep(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: 'step_1',
    description: '搜索数据',
    status: 'pending',
    dependsOn: [],
    fallback: undefined,
    ...overrides,
  }
}

// ── shouldUsePlanMode ────────────────────────────────────────────

describe('shouldUsePlanMode', () => {
  it('returns true when user explicitly requests planning', () => {
    expect(shouldUsePlanMode('制定计划')).toBe(true)
    expect(shouldUsePlanMode('帮我分步完成')).toBe(true)
    expect(shouldUsePlanMode('逐步执行以下任务')).toBe(true)
    expect(shouldUsePlanMode('拆解这个需求')).toBe(true)
  })

  it('returns true when text contains >=3 action verbs', () => {
    expect(shouldUsePlanMode('查一下数据，创建一个报表，然后导出给客户')).toBe(true)
  })

  it('returns true when text has multi-step markers', () => {
    expect(shouldUsePlanMode('第一步查数据，然后分析，最后生成报告')).toBe(true)
    expect(shouldUsePlanMode('第二步进行汇总')).toBe(true)
  })

  it('returns false for simple queries', () => {
    expect(shouldUsePlanMode('你好')).toBe(false)
    expect(shouldUsePlanMode('现在几点')).toBe(false)
    expect(shouldUsePlanMode('查一下昨天的采购记录')).toBe(false)
  })

  it('returns false for single-action requests', () => {
    expect(shouldUsePlanMode('搜索螺纹钢的价格')).toBe(false)
  })
})

// ── classifyFailure ──────────────────────────────────────────────

describe('classifyFailure', () => {
  it('returns halt_absolute for irreversible operations', () => {
    const step = makeStep({ description: '删除用户数据' })
    expect(classifyFailure('any error', step)).toBe('halt_absolute')
  })

  it('returns halt_absolute for delete/drop/remove operations', () => {
    expect(classifyFailure('error', makeStep({ description: 'drop table' }))).toBe('halt_absolute')
    expect(classifyFailure('error', makeStep({ description: 'remove record' }))).toBe('halt_absolute')
  })

  it('returns halt_report for not-found errors', () => {
    const step = makeStep()
    expect(classifyFailure('not found', step)).toBe('halt_report')
    expect(classifyFailure('404', step)).toBe('halt_report')
    expect(classifyFailure('数据不存在', step)).toBe('halt_report')
  })

  it('returns retry for transient errors', () => {
    const step = makeStep()
    expect(classifyFailure('timeout', step)).toBe('retry')
    expect(classifyFailure('ECONNRESET', step)).toBe('retry')
    expect(classifyFailure('rate limit exceeded', step)).toBe('retry')
  })

  it('defaults to halt_report for unknown errors', () => {
    const step = makeStep()
    expect(classifyFailure('permission denied', step)).toBe('halt_report')
  })
})

// ── generatePlan ─────────────────────────────────────────────────

describe('generatePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('parses LLM response as plan', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: JSON.stringify({
        steps: [
          { id: 'step_1', description: '搜索数据', dependsOn: [] },
          { id: 'step_2', description: '分析结果', dependsOn: ['step_1'] },
        ],
        execution: 'sequential',
      }),
      usage: { promptTokens: 60, completionTokens: 80 },
    })

    const plan = await generatePlan('分析销售数据', llm)

    expect(plan.goal).toBe('分析销售数据')
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0].description).toBe('搜索数据')
    expect(plan.steps[1].dependsOn).toEqual(['step_1'])
    expect(plan.execution).toBe('sequential')
  })

  it('handles markdown code blocks in LLM response', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '```json\n{"steps":[{"id":"step_1","description":"搜索"}],"execution":"sequential"}\n```',
      usage: { promptTokens: 60, completionTokens: 40 },
    })

    const plan = await generatePlan('搜索数据', llm)

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].description).toBe('搜索')
  })

  it('falls back to single-step plan on parse failure', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '这不是有效的 JSON',
      usage: { promptTokens: 60, completionTokens: 30 },
    })

    const plan = await generatePlan('简单任务', llm)

    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].description).toBe('简单任务')
    expect(plan.steps[0].status).toBe('pending')
    expect(plan.execution).toBe('sequential')
  })

  it('includes context when provided', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: JSON.stringify({
        steps: [{ id: 'step_1', description: '执行' }],
        execution: 'sequential',
      }),
      usage: { promptTokens: 80, completionTokens: 30 },
    })

    await generatePlan('完成任务', llm, '已有部分数据')

    expect(llm.chat).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'system' }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('背景信息'),
        }),
      ]),
    )
  })

  it('generates ID with ulid when step has no id', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: JSON.stringify({
        steps: [{ description: '搜索' }],
        execution: 'sequential',
      }),
      usage: { promptTokens: 60, completionTokens: 30 },
    })

    const plan = await generatePlan('搜索', llm)

    expect(plan.steps[0].id).toBe('ulid-mock')
  })
})

// ── startPlan ────────────────────────────────────────────────────

describe('startPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a TaskLedger and returns plan + ledgerId', async () => {
    const plan: ExecutionPlan = {
      goal: '测试',
      steps: [makeStep()],
      execution: 'sequential',
    }
    const ctx = makeCtx()

    const result = await startPlan(plan, ctx)

    expect(createLedger).toHaveBeenCalledWith({
      spaceId: 'space-1',
      actorId: 'user-1',
      goal: '测试',
      planSteps: plan.steps,
    })
    expect(result.plan).toBe(plan)
    expect(result.ledgerId).toBe('ledger-1')
  })
})

// ── executeStep ──────────────────────────────────────────────────

describe('executeStep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('executes a step that produces a tool call', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '[TOOL_CALL: search] {"q":"sales data"}',
      usage: { promptTokens: 100, completionTokens: 20 },
    })
    const tools = makeTools()
    vi.mocked(tools.execute).mockResolvedValue('{"found": 42}')

    const result = await executeStep('ledger-1', makeStep(), tools, llm, makeCtx())

    expect(setPendingAction).toHaveBeenCalledWith('ledger-1', expect.objectContaining({
      stepId: 'step_1',
    }))
    expect(tools.execute).toHaveBeenCalledWith('search', { q: 'sales data' }, expect.anything())
    expect(addCheckpoint).toHaveBeenCalledWith('ledger-1', expect.objectContaining({
      stepId: 'step_1',
    }))
    expect(result.success).toBe(true)
    expect(result.output).toBe('{"found": 42}')
  })

  it('returns LLM response as output when no tool call is produced', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '这个步骤不需要工具，直接回复',
      usage: { promptTokens: 100, completionTokens: 30 },
    })
    const tools = makeTools()

    const result = await executeStep('ledger-1', makeStep(), tools, llm)

    expect(tools.execute).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    expect(result.output).toBe('这个步骤不需要工具，直接回复')
  })

  it('returns error when tool execution fails', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '[TOOL_CALL: search] {"q":"test"}',
      usage: { promptTokens: 100, completionTokens: 20 },
    })
    const tools = makeTools()
    vi.mocked(tools.execute).mockRejectedValue(new Error('API unavailable'))

    const result = await executeStep('ledger-1', makeStep(), tools, llm)

    expect(result.success).toBe(false)
    expect(result.error).toBe('API unavailable')
  })

  it('clears pending action on both success and failure', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '直接回复',
      usage: { promptTokens: 100, completionTokens: 20 },
    })
    const tools = makeTools()

    await executeStep('ledger-1', makeStep(), tools, llm)

    // setPendingAction called twice: once to set, once to clear with null
    expect(setPendingAction).toHaveBeenCalledWith('ledger-1', null)
  })
})
