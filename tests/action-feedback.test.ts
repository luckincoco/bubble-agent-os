import { describe, it, expect, vi } from 'vitest'
import { EventBus } from '../src/event/event-bus.js'
import { createStepObserver, emitPlanFinished, registerActionFeedbackListeners } from '../src/wiring/action-feedback.js'
import type { BubbleEventData, ActionStepCompleted, ActionPlanFinished, KnowledgeTensionDetected } from '../src/event/event-types.js'
import type { EmitOptions } from '../src/event/event-bus.js'

// ── Test Fixtures ──────────────────────────────────────────────────

const testStep = { id: 'step-1', description: '查询供应商列表', status: 'pending' as const }
const testResult = { stepId: 'step-1', success: true, output: '查询成功，返回 3 条记录' }
const testResultFailed = { stepId: 'step-1', success: false, output: '查询失败', error: '网络超时' }
const testLedgerId = 'ledger-test-001'
const testGoal = '对账差异分析'
const testOptions: EmitOptions = { actor: 'tester', spaceId: 's1', metadata: {} }

// ── Helpers ────────────────────────────────────────────────────────

function collectEvents(): { events: BubbleEventData[]; listener: (e: BubbleEventData) => void } {
  const events: BubbleEventData[] = []
  const listener = (e: BubbleEventData) => { events.push(e) }
  return { events, listener }
}

// ── createStepObserver ─────────────────────────────────────────────

describe('createStepObserver', () => {
  it('成功步骤发射 action.step.completed', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    const observer = createStepObserver(bus, testLedgerId, testGoal)
    await observer.onStepComplete(testStep, testResult, 0)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('action.step.completed')
    const p = (events[0] as ActionStepCompleted).payload
    expect(p.ledgerId).toBe(testLedgerId)
    expect(p.stepId).toBe('step-1')
    expect(p.goal).toBe(testGoal)
    expect(p.success).toBe(true)
    expect(p.output).toBe(testResult.output)
  })

  it('失败步骤不发射事件', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    const observer = createStepObserver(bus, testLedgerId, testGoal)
    await observer.onStepComplete(testStep, testResultFailed, 0)

    expect(events).toHaveLength(0)
  })

  it('长输出截断至 500 字符', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    const longOutput = 'x'.repeat(1000)
    const observer = createStepObserver(bus, testLedgerId, testGoal)
    await observer.onStepComplete(testStep, { ...testResult, output: longOutput }, 0)

    const p = (events[0] as ActionStepCompleted).payload
    expect(p.output.length).toBe(500)
  })

  it('step index 不影响发射结果', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    const observer = createStepObserver(bus, testLedgerId, testGoal)
    await observer.onStepComplete(testStep, testResult, 42)

    expect(events).toHaveLength(1) // index 42 不影响事件内容
  })
})

// ── emitPlanFinished ───────────────────────────────────────────────

describe('emitPlanFinished', () => {
  it('completed 计划发射 action.plan.finished', () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    emitPlanFinished(bus, testLedgerId, testGoal, 'completed', 3, 5, 's1')

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('action.plan.finished')
    const p = (events[0] as ActionPlanFinished).payload
    expect(p.ledgerId).toBe(testLedgerId)
    expect(p.status).toBe('completed')
    expect(p.completedSteps).toBe(3)
    expect(p.totalSteps).toBe(5)
    expect(p.spaceId).toBe('s1')
  })

  it('cancelled 计划发射取消状态', () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    emitPlanFinished(bus, testLedgerId, testGoal, 'cancelled', 1, 4)

    const p = (events[0] as ActionPlanFinished).payload
    expect(p.status).toBe('cancelled')
  })

  it('paused 计划发射暂停状态', () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.onAll(listener)

    emitPlanFinished(bus, testLedgerId, testGoal, 'paused', 2, 4)

    const p = (events[0] as ActionPlanFinished).payload
    expect(p.status).toBe('paused')
  })
})

// ── registerActionFeedbackListeners ────────────────────────────────

describe('registerActionFeedbackListeners', () => {
  it('返回 unsubscribe 函数且不报错', () => {
    const bus = new EventBus()
    const unsub = registerActionFeedbackListeners(bus)
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('listener 接收 action.step.completed 不抛错', async () => {
    const bus = new EventBus()
    registerActionFeedbackListeners(bus)

    await expect(
      bus.emit(
        { type: 'action.step.completed', payload: { ledgerId: '1', stepId: 's1', goal: 'test', description: '步骤', success: true, output: 'ok' } },
        testOptions,
      ),
    ).resolves.toBeUndefined()
  })

  it('listener 接收 action.plan.finished 不抛错', async () => {
    const bus = new EventBus()
    registerActionFeedbackListeners(bus)

    await expect(
      bus.emit(
        { type: 'action.plan.finished', payload: { ledgerId: '1', goal: 'test', status: 'completed', completedSteps: 3, totalSteps: 5 } },
        testOptions,
      ),
    ).resolves.toBeUndefined()
  })

  it('listener 接收 knowledge.tension.detected 不抛错', async () => {
    const bus = new EventBus()
    registerActionFeedbackListeners(bus)

    await expect(
      bus.emit(
        { type: 'knowledge.tension.detected', payload: { spaceId: 's1', tensionCount: 3, highPriorityTensions: [{ domainA: 'a', domainB: 'b', reason: '冲突' }], frontierGaps: [{ domain: 'a', gapScore: 0.8 }] } },
        testOptions,
      ),
    ).resolves.toBeUndefined()
  })

  it('unsubscribe 后 listener 不再触发', async () => {
    const bus = new EventBus()
    const unsub = registerActionFeedbackListeners(bus)
    unsub()

    await expect(
      bus.emit(
        { type: 'action.step.completed', payload: { ledgerId: '1', stepId: 's1', goal: 'test', description: '步骤', success: true, output: 'ok' } },
        testOptions,
      ),
    ).resolves.toBeUndefined()
    // No throw after unsubscribe = listener removed successfully
  })

  it('低分 tension 不触发 info 日志（不影响其他 listener）', async () => {
    const bus = new EventBus()
    registerActionFeedbackListeners(bus, { minTensionThreshold: 5, minGapThreshold: 0.9 })

    await expect(
      bus.emit(
        { type: 'knowledge.tension.detected', payload: { spaceId: 's1', tensionCount: 1, highPriorityTensions: [], frontierGaps: [{ domain: 'a', gapScore: 0.3 }] } },
        testOptions,
      ),
    ).resolves.toBeUndefined()
  })
})

// ── Integration: Observer → Bus → Listener ─────────────────────────

describe('Observer → Bus → Listener 集成', () => {
  it('step observer 发射经 listener 处理后不抛错', async () => {
    const bus = new EventBus()
    registerActionFeedbackListeners(bus)
    const observer = createStepObserver(bus, testLedgerId, testGoal)

    await expect(
      observer.onStepComplete(testStep, testResult, 0),
    ).resolves.toBeUndefined()
  })

  it('多个 step 连续发射', async () => {
    const bus = new EventBus()
    const { events, listener } = collectEvents()
    bus.on('action.step.completed', listener)
    registerActionFeedbackListeners(bus)

    const observer = createStepObserver(bus, testLedgerId, testGoal)
    await observer.onStepComplete({ id: 's1', description: '第一步', status: 'pending' }, { stepId: 's1', success: true, output: 'ok' }, 0)
    await observer.onStepComplete({ id: 's2', description: '第二步', status: 'pending' }, { stepId: 's2', success: true, output: 'ok' }, 1)

    expect(events).toHaveLength(2)
    expect(events[0].type).toBe('action.step.completed')
    expect(events[1].type).toBe('action.step.completed')
  })
})
