import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Module-level mocks ──────────────────────────────────────────────────

vi.mock('../src/shared/types.js', () => ({
  isExternalContext: vi.fn((ctx: any) => ctx?.isExternal === true),
}))

vi.mock('../src/temporal/episode-store.js', () => ({
  createEpisode: vi.fn(),
}))

vi.mock('../src/temporal/task-ledger.js', () => ({
  getActiveLedger: vi.fn(),
  buildLedgerContext: vi.fn(),
  detectResumption: vi.fn(),
  updateEpisodeWindow: vi.fn(),
  setPendingAction: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  findRecentBySource: vi.fn(),
  getBubble: vi.fn(),
  updateBubble: vi.fn(),
}))

vi.mock('../src/workflow/planner.js', () => ({
  shouldUsePlanMode: vi.fn(),
  generatePlan: vi.fn(),
  startPlan: vi.fn(),
}))

vi.mock('../src/workflow/executor.js', () => ({
  executePlan: vi.fn(),
  formatExecutorReport: vi.fn(),
}))

vi.mock('../src/wiring/action-feedback.js', () => ({
  createStepObserver: vi.fn(() => ({ onStepComplete: vi.fn() })),
  emitPlanFinished: vi.fn(),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { MessageRouter } from '../src/connector/router.js'
import * as episodeStore from '../src/temporal/episode-store.js'
import * as taskLedger from '../src/temporal/task-ledger.js'
import * as model from '../src/bubble/model.js'
import * as planner from '../src/workflow/planner.js'
import * as executor from '../src/workflow/executor.js'
import * as actionFeedback from '../src/wiring/action-feedback.js'

// ── Mock dependency objects ────────────────────────────────────────────

function createMockDeps() {
  return {
    brain: { think: vi.fn(), getSelfState: vi.fn().mockReturnValue(null) } as any,
    tools: { execute: vi.fn() } as any,
    surpriseDetector: { scanMessage: vi.fn() } as any,
    bizHandler: { tryHandle: vi.fn() } as any,
    skillRouter: { tryHandle: vi.fn() } as any,
    eventBus: { emitFireAndForget: vi.fn() } as any,
    llmProvider: { chat: vi.fn() } as any,
  }
}

describe('MessageRouter', () => {
  let deps: ReturnType<typeof createMockDeps>
  let router: MessageRouter

  beforeEach(() => {
    vi.clearAllMocks()
    deps = createMockDeps()
    router = new MessageRouter(deps)
    // Default: no plan mode, no resumption (tests that need them override)
    vi.mocked(planner.shouldUsePlanMode).mockReturnValue(false)
    vi.mocked(taskLedger.detectResumption).mockReturnValue(false)
  })

  // ── runReflexLayer ─────────────────────────────────────────────

  describe('runReflexLayer', () => {
    it('bypasses all rules for external users', async () => {
      const result = await (router as any).runReflexLayer('螺纹钢价格多少', {
        activeSpaceId: 'ext-1',
        isExternal: true,
      })
      expect(result).toEqual({ handled: false, context: '' })
      expect(deps.tools.execute).not.toHaveBeenCalled()
    })

    it('steel price intent fetches steelx2 page', async () => {
      deps.tools.execute.mockResolvedValue('品名 螺纹钢 价格 3800 元/吨')

      const result = await (router as any).runReflexLayer('螺纹钢价格多少', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(true)
      expect(result.context).toContain('西本新干线')
      expect(result.context).toContain('螺纹钢 价格 3800')
      expect(deps.tools.execute).toHaveBeenCalledWith(
        'fetch_page',
        expect.objectContaining({ url: expect.stringContaining('steelx2') }),
      )
    })

    it('steel price: failed fetch falls through', async () => {
      deps.tools.execute.mockResolvedValue('抓取失败: timeout')

      const result = await (router as any).runReflexLayer('钢材价格多少', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(false)
    })

    it('general search intent calls web_search', async () => {
      deps.tools.execute.mockResolvedValue('搜索结果: 钢材市场新闻...')

      const result = await (router as any).runReflexLayer('搜索新闻', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(true)
      expect(result.context).toContain('网络搜索结果')
      expect(deps.tools.execute).toHaveBeenCalledWith('web_search', { query: '搜索新闻' })
    })

    it('general search: error result falls through', async () => {
      deps.tools.execute.mockResolvedValue('Error: API unavailable')

      const result = await (router as any).runReflexLayer('今日铜价', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(false)
    })

    it('no search intent does not trigger tools.execute', async () => {
      const result = await (router as any).runReflexLayer('你好', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(false)
      expect(deps.tools.execute).not.toHaveBeenCalled()
    })

    it('biz entry fully handles the request', async () => {
      deps.bizHandler.tryHandle.mockResolvedValue({
        handled: true,
        response: '已记录：采购螺纹钢100吨',
      })

      const result = await (router as any).runReflexLayer('进了100吨螺纹钢', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(true)
      expect(result.fullyHandled).toBe(true)
      expect(result.directResponse).toBe('已记录：采购螺纹钢100吨')
    })

    it('biz entry not handled falls through', async () => {
      deps.bizHandler.tryHandle.mockResolvedValue({
        handled: false,
        response: undefined,
      })

      const result = await (router as any).runReflexLayer('进了100吨螺纹钢', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(false)
    })

    it('skill router fully handles', async () => {
      deps.skillRouter.tryHandle.mockResolvedValue({
        matched: true,
        handled: true,
        response: '技能路由响应',
      })

      const result = await (router as any).runReflexLayer('画一个流程图', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(true)
      expect(result.fullyHandled).toBe(true)
      expect(result.directResponse).toBe('技能路由响应')
    })

    it('skill router injects context without fully handling', async () => {
      deps.skillRouter.tryHandle.mockResolvedValue({
        matched: true,
        handled: false,
        contextInjection: '\n[技能上下文]',
      })

      const result = await (router as any).runReflexLayer('帮我分析', {
        activeSpaceId: 's-1',
      })

      expect(result.handled).toBe(true)
      expect(result.context).toBe('\n[技能上下文]')
      expect(result.fullyHandled).toBeUndefined()
    })

    it('returns handled:false when no reflex rules match', async () => {
      const result = await (router as any).runReflexLayer('你好', {
        activeSpaceId: 's-1',
      })

      expect(result).toEqual({ handled: false, context: '' })
    })
  })

  // ── processDigestFeedback ──────────────────────────────────────

  describe('processDigestFeedback', () => {
    it('positive feedback increases confidence and adds user-endorsed tag', async () => {
      vi.mocked(model.findRecentBySource).mockReturnValue([
        { metadata: { sourceBubbleIds: ['b-1'] } },
      ] as any)
      vi.mocked(model.getBubble).mockReturnValue(
        { id: 'b-1', title: '钢材知识', tags: ['steel'], confidence: 0.5 } as any,
      )

      await (router as any).processDigestFeedback('有意思，继续')

      expect(model.updateBubble).toHaveBeenCalledWith('b-1', {
        confidence: 0.6,
        tags: ['steel', 'user-endorsed'],
      })
    })

    it('negative feedback decreases confidence and adds user-questioned tag', async () => {
      vi.mocked(model.findRecentBySource).mockReturnValue([
        { metadata: { sourceBubbleIds: ['b-1'] } },
      ] as any)
      vi.mocked(model.getBubble).mockReturnValue(
        { id: 'b-1', title: '钢材知识', tags: ['steel'], confidence: 0.8 } as any,
      )

      await (router as any).processDigestFeedback('不对，错了')

      expect(model.updateBubble).toHaveBeenCalledWith('b-1', {
        confidence: 0.4,
        tags: ['steel', 'user-questioned'],
      })
    })

    it('skips when no feedback keywords detected', async () => {
      // "现在几点了" does NOT match any POSITIVE_RE or NEGATIVE_RE pattern
      await (router as any).processDigestFeedback('现在几点了')

      expect(model.findRecentBySource).not.toHaveBeenCalled()
      expect(model.updateBubble).not.toHaveBeenCalled()
    })

    it('skips when no recent digest found', async () => {
      vi.mocked(model.findRecentBySource).mockReturnValue([])

      await (router as any).processDigestFeedback('有意思')

      expect(model.updateBubble).not.toHaveBeenCalled()
    })

    it('only updates bubbles matching user keywords', async () => {
      vi.mocked(model.findRecentBySource).mockReturnValue([
        { metadata: { sourceBubbleIds: ['b-1', 'b-2'] } },
      ] as any)
      vi.mocked(model.getBubble).mockImplementation((id: string) => {
        if (id === 'b-1') return { id: 'b-1', title: '螺纹钢知识', tags: ['steel'], confidence: 0.5 } as any
        if (id === 'b-2') return { id: 'b-2', title: '混凝土配比', tags: ['cement'], confidence: 0.5 } as any
        return null
      })

      await (router as any).processDigestFeedback('有意思 螺纹钢')

      expect(model.updateBubble).toHaveBeenCalledTimes(1)
      expect(model.updateBubble).toHaveBeenCalledWith('b-1', expect.any(Object))
    })

    it('updates all source bubbles as fallback when no keyword match', async () => {
      vi.mocked(model.findRecentBySource).mockReturnValue([
        { metadata: { sourceBubbleIds: ['b-1', 'b-2', 'b-3'] } },
      ] as any)
      vi.mocked(model.getBubble).mockReturnValue(
        { id: 'b-1', title: 'Topic', tags: [], confidence: 0.5 } as any,
      )

      await (router as any).processDigestFeedback('有意思 无匹配')

      expect(model.updateBubble).toHaveBeenCalledTimes(3)
    })
  })

  // ── handle (integration) ───────────────────────────────────────

  describe('handle', () => {
    it('returns direct response when reflex fully handles', async () => {
      deps.bizHandler.tryHandle.mockResolvedValue({
        handled: true,
        response: '已记录',
      })

      const result = await router.handle('进了100吨螺纹钢', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      expect(result.response).toBe('已记录')
      expect(result.sources).toEqual([])
    })

    it('calls brain.think when no reflex rules match', async () => {
      deps.brain.think.mockResolvedValue({
        response: '你好！',
        sources: [],
        turnId: 't-1',
      })

      const result = await router.handle('你好', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      expect(result.response).toBe('你好！')
      expect(deps.brain.think).toHaveBeenCalled()
    })

    it('injects steel price reflex context into brain.think', async () => {
      deps.tools.execute.mockResolvedValue('品名 螺纹钢 价格 3800 元/吨')
      deps.brain.think.mockResolvedValue({
        response: '螺纹钢3800',
        sources: [],
      })

      const result = await router.handle('螺纹钢价格多少', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      expect(deps.brain.think).toHaveBeenCalledWith(
        expect.stringContaining('西本新干线'),
        expect.any(Object),
        undefined,
      )
      expect(result.response).toBe('螺纹钢3800')
    })

    it('creates episode when eventBus is available', async () => {
      vi.mocked(episodeStore.createEpisode).mockReturnValue({ id: 'ep-1' } as any)
      deps.brain.think.mockResolvedValue({
        response: 'OK',
        sources: [],
      })

      await router.handle('hello', { activeSpaceId: 's-1', userId: 'u-1' })

      expect(episodeStore.createEpisode).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'conversation', content: 'hello' }),
      )
      expect(deps.eventBus.emitFireAndForget).toHaveBeenCalled()
    })

    it('injects ledger context when resumption detected', async () => {
      vi.mocked(taskLedger.detectResumption).mockReturnValue(true)
      vi.mocked(taskLedger.getActiveLedger).mockReturnValue({
        id: 'ledger-1', goal: '分析数据',
      } as any)
      vi.mocked(taskLedger.buildLedgerContext).mockReturnValue('\n[TaskLedger: 分析数据]')
      deps.brain.think.mockResolvedValue({
        response: '继续分析',
        sources: [],
      })

      await router.handle('继续任务', { activeSpaceId: 's-1', userId: 'u-1' })

      expect(deps.brain.think).toHaveBeenCalledWith(
        expect.stringContaining('TaskLedger'),
        expect.any(Object),
        undefined,
      )
    })

    it('generates plan for multi-step request', async () => {
      vi.mocked(planner.shouldUsePlanMode).mockReturnValue(true)
      vi.mocked(planner.generatePlan).mockResolvedValue({
        goal: '分析数据',
        steps: [{ description: '查询数据' }, { description: '生成报告' }],
        execution: 'sequential',
      } as any)
      vi.mocked(planner.startPlan).mockResolvedValue({ ledgerId: 'ledger-1' })
      vi.mocked(episodeStore.createEpisode).mockReturnValue({ id: 'ep-1' } as any)

      const result = await router.handle('帮我分析数据并生成报告', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      expect(result.response).toContain('2 步')
      expect(result.response).toContain('确认开始')
    })

    it('executes plan on user confirmation', async () => {
      vi.mocked(taskLedger.getActiveLedger).mockReturnValue({
        id: 'ledger-1',
        goal: '分析数据',
        planSteps: [{ description: '查询数据' }],
        pendingAction: { requiresConfirmation: true, createdAt: Date.now() },
      } as any)
      vi.mocked(executor.executePlan).mockResolvedValue({
        completed: true,
        stepsExecuted: 1,
      } as any)
      vi.mocked(executor.formatExecutorReport).mockReturnValue('执行完成')

      const result = await router.handle('好', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      expect(result.response).toBe('执行完成')
      expect(executor.executePlan).toHaveBeenCalled()
    })

    it('does not confirm plan when no pending action', async () => {
      vi.mocked(taskLedger.getActiveLedger).mockReturnValue({
        id: 'ledger-1',
        goal: '分析数据',
        planSteps: [{ description: '查询数据' }],
        pendingAction: undefined,
      } as any)

      deps.brain.think.mockResolvedValue({
        response: '好的',
        sources: [],
      })

      const result = await router.handle('好', {
        activeSpaceId: 's-1',
        userId: 'u-1',
      })

      // No pending action → falls through to brain.think
      expect(deps.brain.think).toHaveBeenCalled()
      expect(result.response).toBe('好的')
    })

    it('handles episode creation failure gracefully', async () => {
      vi.mocked(episodeStore.createEpisode).mockImplementation(() => {
        throw new Error('DB error')
      })
      deps.brain.think.mockResolvedValue({
        response: 'OK',
        sources: [],
      })

      const result = await router.handle('hello', { activeSpaceId: 's-1', userId: 'u-1' })

      expect(result.response).toBe('OK')
      // Should still call brain.think despite episode failure
      expect(deps.brain.think).toHaveBeenCalled()
    })

    it('runs anticipation layer (fire-and-forget) after response', async () => {
      deps.brain.think.mockResolvedValue({
        response: 'OK',
        sources: [],
      })

      await router.handle('hello', { activeSpaceId: 's-1', userId: 'u-1' })
      // Let microtasks flush so the fire-and-forget anticipation runs
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(deps.surpriseDetector.scanMessage).toHaveBeenCalledWith(
        'hello',
        's-1',
      )
    })
  })
})
