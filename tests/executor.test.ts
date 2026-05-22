import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ──────────────────────────────────────────────────

vi.mock('../src/workflow/planner.js', () => ({
  executeStep: vi.fn(),
  classifyFailure: vi.fn(),
}))

vi.mock('../src/temporal/task-ledger.js', () => ({
  updateLedgerStatus: vi.fn(),
  updatePlanSteps: vi.fn(),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { executePlan, formatExecutorReport } from '../src/workflow/executor.js'
import * as planner from '../src/workflow/planner.js'
import * as taskLedger from '../src/temporal/task-ledger.js'
import type { ExecutionPlan } from '../src/workflow/planner.js'

// ── Fixtures ────────────────────────────────────────────────────────────

function makePlan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    goal: '测试计划',
    steps: [
      { id: 's1', description: '查询数据', status: 'pending', dependsOn: [], tool: 'search', input: {}, strategy: 'normal' },
      { id: 's2', description: '分析结果', status: 'pending', dependsOn: ['s1'], tool: 'analyze', input: {}, strategy: 'normal' },
      { id: 's3', description: '生成报告', status: 'pending', dependsOn: ['s2'], tool: 'report', input: {}, strategy: 'normal' },
    ],
    execution: 'sequential',
    ...overrides,
  }
}

const defaultTools = {} as any
const defaultLLM = {} as any

/** Set up executeStep to return stepId=step.id for any step */
function mockStepSuccess() {
  vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
    return Promise.resolve({ stepId: step.id, success: true, output: 'ok' })
  })
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('executePlan', () => {
  beforeEach(() => {
    // Reset module mocks to clean state (clearAllMocks/restoreAllMocks don't
    // affect vi.fn() inside vi.mock() factories in vitest 4.x — they retain
    // mockReturnValue across tests, causing call count accumulation)
    vi.mocked(planner.executeStep).mockReset()
    vi.mocked(planner.classifyFailure).mockReset()
    vi.mocked(taskLedger.updateLedgerStatus).mockReset()
    vi.mocked(taskLedger.updatePlanSteps).mockReset()
  })

  it('completes all steps successfully', async () => {
    mockStepSuccess()
    vi.mocked(planner.classifyFailure).mockReturnValue('retry')

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan(),
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(true)
    expect(result.stepsExecuted).toBe(3)
    expect(result.results).toHaveLength(3)
    expect(taskLedger.updateLedgerStatus).toHaveBeenCalledWith('l-1', 'completed')
  })

  it('skips step with unmet dependency', async () => {
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      if (step.id === 's1') {
        return Promise.resolve({ stepId: step.id, success: false, output: '', error: '查询失败' })
      }
      // s2, s3 should never be called due to dependency skip
      return Promise.resolve({ stepId: step.id, success: true, output: 'unexpected' })
    })

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan(),
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(true) // skipped steps don't abort
    expect(result.results).toHaveLength(3)
    expect(result.results[0].success).toBe(false) // s1 failed
    expect(result.results[1].success).toBe(false) // s2 skipped (dep on s1)
    expect(result.results[2].success).toBe(false) // s3 skipped (dep on s2)
    expect(result.results[1].error).toContain('依赖未满足')
  })

  it('aborts when onBeforeStep returns false', async () => {
    mockStepSuccess()

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan(),
      tools: defaultTools,
      llm: defaultLLM,
      onBeforeStep: vi.fn().mockResolvedValue(false),
    })

    expect(result.completed).toBe(false)
    expect(result.stepsExecuted).toBe(0)
    expect(result.abortReason).toContain('用户中断')
  })

  it('retries on transient failure', async () => {
    const stepResults: Record<string, any> = {
      s1: { success: false, error: 'timeout' }, // first attempt fails
    }
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      if (stepResults[step.id]) {
        const r = stepResults[step.id]
        delete stepResults[step.id]
        return Promise.resolve({ stepId: step.id, ...r })
      }
      return Promise.resolve({ stepId: step.id, success: true, output: 'ok' })
    })
    vi.mocked(planner.classifyFailure).mockReturnValue('retry')

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan(),
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(true)
    expect(result.stepsExecuted).toBe(4) // 3 normal + 1 retry for s1
    expect(planner.executeStep).toHaveBeenCalledTimes(4)
  })

  it('retries then aborts when retry also fails', async () => {
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      return Promise.resolve({ stepId: step.id, success: false, output: '', error: 'timeout' })
    })
    vi.mocked(planner.classifyFailure).mockReturnValue('retry')

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan({ steps: [makePlan().steps[0]] }), // just 1 step
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(false)
    expect(result.stepsExecuted).toBe(2) // original + retry
    expect(result.abortReason).toContain('步骤失败')
    expect(taskLedger.updateLedgerStatus).toHaveBeenCalledWith('l-1', 'paused')
  })

  it('halts on halt_report strategy', async () => {
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      return Promise.resolve({ stepId: step.id, success: false, output: '', error: '数据异常' })
    })
    vi.mocked(planner.classifyFailure).mockReturnValue('halt_report')

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan({ steps: [makePlan().steps[0]] }),
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(false)
    expect(result.abortReason).toContain('数据异常')
    expect(taskLedger.updateLedgerStatus).toHaveBeenCalledWith('l-1', 'paused')
  })

  it('halts on halt_absolute strategy', async () => {
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      return Promise.resolve({ stepId: step.id, success: false, output: '', error: '不可逆错误' })
    })
    vi.mocked(planner.classifyFailure).mockReturnValue('halt_absolute')

    const result = await executePlan({
      ledgerId: 'l-1',
      plan: makePlan({ steps: [makePlan().steps[0]] }),
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.completed).toBe(false)
    expect(result.abortReason).toContain('不可逆操作')
    expect(taskLedger.updateLedgerStatus).toHaveBeenCalledWith('l-1', 'paused')
  })

  it('calls onStepComplete for each step', async () => {
    mockStepSuccess()
    const onStepComplete = vi.fn()

    await executePlan({
      ledgerId: 'l-1',
      plan: makePlan(),
      tools: defaultTools,
      llm: defaultLLM,
      onStepComplete,
    })

    expect(onStepComplete).toHaveBeenCalledTimes(3)
  })

  it('filters out already completed/skipped steps', async () => {
    vi.mocked(planner.executeStep).mockImplementation((_lid: string, step: any) => {
      return Promise.resolve({ stepId: step.id, success: true, output: 'ok' })
    })

    const plan = makePlan()
    plan.steps[0].status = 'completed' // s1 already done
    plan.steps[1].status = 'skipped'   // s2 already skipped
    plan.steps[2].dependsOn = []       // s3 independent

    const result = await executePlan({
      ledgerId: 'l-1',
      plan,
      tools: defaultTools,
      llm: defaultLLM,
    })

    expect(result.stepsExecuted).toBe(1) // only s3 executed
    expect(planner.executeStep).toHaveBeenCalledTimes(1)
  })
})

// ── formatExecutorReport ───────────────────────────────────────────────

describe('formatExecutorReport', () => {
  it('formats completed plan report', () => {
    const plan = makePlan()
    plan.steps.forEach(s => (s.status = 'completed'))

    const report = formatExecutorReport(
      {
        completed: true, stepsExecuted: 3,
        results: [
          { stepId: 's1', success: true, output: '' },
          { stepId: 's2', success: true, output: '' },
          { stepId: 's3', success: true, output: '' },
        ],
      },
      plan,
    )

    expect(report).toContain('已完成')
    expect(report).toContain('[done]')
  })

  it('formats aborted plan report with abort reason', () => {
    const plan = makePlan()
    plan.steps[0].status = 'failed'
    plan.steps.forEach((s, i) => { if (i > 0) s.status = 'pending' })

    const report = formatExecutorReport(
      {
        completed: false, stepsExecuted: 1,
        results: [{ stepId: 's1', success: false, output: '', error: 'timeout' }],
        abortReason: '用户中断',
      },
      plan,
    )

    expect(report).toContain('已暂停')
    expect(report).toContain('中止原因')
    expect(report).toContain('[FAIL]')
  })

  it('shows [skip] for skipped steps', () => {
    const plan = makePlan()
    plan.steps[0].status = 'completed'
    plan.steps[1].status = 'skipped'
    plan.steps[2].status = 'pending'

    const report = formatExecutorReport(
      {
        completed: false, stepsExecuted: 1,
        results: [
          { stepId: 's1', success: true, output: '' },
          { stepId: 's2', success: false, output: '', error: 'skip' },
        ],
      },
      plan,
    )

    expect(report).toContain('[skip]')
  })
})
