import type { Brain } from '../kernel/brain.js'
import type { ToolRegistry } from './registry.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import type { BizEntryHandler } from './biz/handler.js'
import type { SkillRouter as SkillRouterType } from './skills/skill-router.js'
import type { EventBus } from '../event/event-bus.js'
import type { UserContext, ThinkResult, LLMProvider } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import { createEpisode, type EpisodeSource } from '../temporal/episode-store.js'
import { getActiveLedger, buildLedgerContext, detectResumption, updateEpisodeWindow, setPendingAction } from '../temporal/task-ledger.js'
import { findRecentBySource, getBubble, updateBubble } from '../bubble/model.js'
import { logger } from '../shared/logger.js'
import { shouldUsePlanMode, generatePlan, startPlan } from '../workflow/planner.js'
import type { ExecutionPlan } from '../workflow/planner.js'
import { executePlan, formatExecutorReport } from '../workflow/executor.js'
import { createStepObserver, emitPlanFinished } from '../wiring/action-feedback.js'

/**
 * MessageRouter — Layer 0 (Reflex) + Layer 1 (Deliberation) unified entry point.
 *
 * All connectors (Feishu, WeCom, future WeChat, etc.) call router.handle()
 * instead of duplicating intent detection and tool invocation logic.
 *
 * Architecture:
 *   Layer 0 (Reflex):  Rule-based intent matching → direct tool call → inject context
 *   Layer 1 (Deliberation): Brain.think() with enriched input
 *   Layer 2 (Anticipation): Async fire-and-forget surprise scan
 *
 * Layer 2 (question-generator) runs on its own schedule via TaskScheduler.
 */

// ── Intent rules ─────────────────────────────────────────────────────

/** Keywords for steel price queries — bypass web search, fetch steelx2 directly */
const STEEL_PRICE_RE = /钢[材筋]|螺纹|盘螺|高线|圆钢|工字钢|角钢|槽钢|H型钢|焊管|HRB\d|HPB\d|线材|\d+盘|[三四]级[钢抗]|抗震螺纹/

/** Keywords that indicate the user wants a web search or price lookup */
const SEARCH_INTENT_RE = /搜索|查一下|查询下|查询|搜一下|搜下|检索|今[天日].*价格|最新.*价格|实时|行情|现货|报价|新闻|帮我[查搜找]|价格.*多少|多少钱|什么价|啥价|涨了|跌了|走势/

/** Feedback detection for learning digest */
const POSITIVE_RE = /有意思|不错|很好|太好了|学到了|继续|多看看|关注|深入|赞|nice|cool|有启发/i
const NEGATIVE_RE = /不对|错了|不准|有问题|别看|不要|没用|无聊|跑偏|离谱|wrong/i
const FEEDBACK_WINDOW_MS = 12 * 60 * 60 * 1000

const STEEL_PRICE_URL = 'https://shanghai.steelx2.com/city/Quotation/quotation/1/index.html'

// ── Route result types ───────────────────────────────────────────────

interface ReflexResult {
  /** Whether Layer 0 intercepted and produced context */
  handled: boolean
  /** Extra context to prepend to the user message before sending to Brain */
  context: string
  /** If true, Layer 0 fully handled the request — skip Brain.think() entirely */
  fullyHandled?: boolean
  /** Direct response to return when fullyHandled is true */
  directResponse?: string
}

export interface RouterResult {
  response: string
  sources: import('../shared/types.js').SourceRef[]
  turnId?: string
}

// ── MessageRouter ────────────────────────────────────────────────────

export class MessageRouter {
  private brain: Brain
  private tools: ToolRegistry | null
  private surpriseDetector: SurpriseDetector | null
  private bizHandler: BizEntryHandler | null
  private skillRouter: SkillRouterType | null
  private eventBus: EventBus | null
  private llmProvider: LLMProvider | null

  constructor(deps: {
    brain: Brain
    tools?: ToolRegistry
    surpriseDetector?: SurpriseDetector
    bizHandler?: BizEntryHandler
    skillRouter?: SkillRouterType
    eventBus?: EventBus
    llmProvider?: LLMProvider
  }) {
    this.brain = deps.brain
    this.tools = deps.tools ?? null
    this.surpriseDetector = deps.surpriseDetector ?? null
    this.bizHandler = deps.bizHandler ?? null
    this.skillRouter = deps.skillRouter ?? null
    this.eventBus = deps.eventBus ?? null
    this.llmProvider = deps.llmProvider ?? null
  }

  /**
   * Main entry point — all connectors call this.
   *
   * Flow:
   *  1. Layer 0 (Reflex): fast rule matching, tool calls without LLM
   *  2. Layer 1 (Deliberation): Brain.think() with any injected context
   *  3. Layer 2 (Anticipation): async surprise scan (fire-and-forget)
   */
  async handle(
    text: string,
    ctx: UserContext,
    options?: { onChunk?: (text: string) => void; source?: EpisodeSource },
  ): Promise<RouterResult> {
    // ── Create Episode for this conversation turn ────────────────
    let episodeId: string | undefined
    if (this.eventBus) {
      try {
        const source: EpisodeSource = options?.source ?? 'api'
        const episode = createEpisode({
          type: 'conversation',
          source,
          actorId: ctx.userId,
          spaceId: ctx.activeSpaceId,
          content: text,
        })
        episodeId = episode.id
        this.eventBus.emitFireAndForget(
          { type: 'conversation.episode.created', payload: { episodeId: episode.id, episodeType: episode.type, source, actorId: ctx.userId } },
          { actor: ctx.userId, spaceId: ctx.activeSpaceId, metadata: { episodeId: episode.id } },
        )
      } catch (err) {
        logger.debug('Router: episode creation failed:', err instanceof Error ? err.message : String(err))
      }
    }

    // ── Layer 0: Reflex ────────────────────────────────────────────
    const reflex = await this.runReflexLayer(text, ctx)

    // If Layer 0 fully handled the request (e.g. biz entry), skip Brain
    if (reflex.fullyHandled && reflex.directResponse) {
      // Layer 2 still runs (contradiction detection is valuable for biz data)
      this.runAnticipationLayer(text, ctx).catch(err =>
        logger.error('Router L2 anticipation error:', err instanceof Error ? err.message : String(err)),
      )
      // Emit response event
      if (this.eventBus && episodeId) {
        this.eventBus.emitFireAndForget(
          { type: 'conversation.response.sent', payload: { episodeId, toolsUsed: [], tokenUsage: undefined } },
          { actor: 'system', spaceId: ctx.activeSpaceId, metadata: { episodeId } },
        )
      }
      return { response: reflex.directResponse, sources: [] }
    }

    // ── Layer 1: Deliberation ──────────────────────────────────────
    // TaskLedger: detect resumption and inject context if active ledger exists
    let ledgerContext = ''
    if (ctx && !isExternalContext(ctx) && detectResumption(text)) {
      try {
        const ledger = getActiveLedger(ctx.activeSpaceId, ctx.userId)
        if (ledger) {
          ledgerContext = `\n\n${buildLedgerContext(ledger)}\n`
          if (episodeId) {
            updateEpisodeWindow(ledger.id, episodeId)
          }
          logger.info(`Router: injected TaskLedger context for "${ledger.goal}"`)
        }
      } catch (err) {
        logger.debug('Router: TaskLedger lookup failed:', err instanceof Error ? err.message : String(err))
      }
    }

    // ── Plan Mode: user confirms pending plan → execute ──────────
    if (ctx && !isExternalContext(ctx) && this.tools && this.llmProvider && this.eventBus) {
      const pendingLedger = getActiveLedger(ctx.activeSpaceId, ctx.userId)
      if (pendingLedger?.pendingAction?.requiresConfirmation && /^(好|嗯|行|可|ok|OK|yes|Yes|搞)$|^确认|^确定|^开始|^可以|^是的|^好的|^嗯嗯|^好啊|^行啊|^可以啊|^没问题|^来吧/.test(text.trim())) {
        logger.info(`Router: user confirmed plan "${pendingLedger.goal}", starting execution`)
        const stepObserver = createStepObserver(this.eventBus, pendingLedger.id, pendingLedger.goal, ctx.activeSpaceId)
        const plan: ExecutionPlan = {
          goal: pendingLedger.goal,
          steps: pendingLedger.planSteps,
          execution: 'sequential',
        }
        const result = await executePlan({
          ledgerId: pendingLedger.id,
          plan,
          tools: this.tools,
          llm: this.llmProvider,
          ctx,
          onStepComplete: stepObserver.onStepComplete,
        })
        emitPlanFinished(this.eventBus, pendingLedger.id, pendingLedger.goal,
          result.completed ? 'completed' : 'paused',
          result.stepsExecuted, plan.steps.length, ctx.activeSpaceId)
        return {
          response: formatExecutorReport(result, plan),
          sources: [],
        }
      }
    }

    // ── Plan Mode: detect multi-step requests → generate plan → ask confirmation ──
    if (ctx && !isExternalContext(ctx) && this.llmProvider && shouldUsePlanMode(text)) {
      try {
        const plan = await generatePlan(text, this.llmProvider)
        const { ledgerId } = await startPlan(plan, ctx)
        const stepsSummary = plan.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join('\n')
        logger.info(`Router: generated plan for "${plan.goal}" (${plan.steps.length} steps), awaiting confirmation`)
        setPendingAction(ledgerId, {
          stepId: '__confirm_plan__',
          description: '执行完整计划',
          requiresConfirmation: true,
          createdAt: Date.now(),
        })
        if (this.eventBus) {
          this.eventBus.emitFireAndForget(
            { type: 'conversation.response.sent', payload: { episodeId: episodeId!, toolsUsed: [], tokenUsage: undefined } },
            { actor: 'system', spaceId: ctx.activeSpaceId, metadata: { episodeId } },
          )
        }
        return {
          response: `我计划分 ${plan.steps.length} 步完成：\n${stepsSummary}\n\n确认开始吗？`,
          sources: [],
        }
      } catch (err) {
        logger.error('Router: plan generation failed, falling through to brain.think()')
        // Fall through to brain.think()
      }
    }

    const finalInput = reflex.context
      ? `${text}${reflex.context}${ledgerContext}`
      : ledgerContext ? `${text}${ledgerContext}` : text
    const thinkResult = await this.brain.think(finalInput, ctx, options?.onChunk)

    // ── Layer 2: Anticipation (async, non-blocking) ────────────────
    this.runAnticipationLayer(text, ctx).catch(err =>
      logger.error('Router L2 anticipation error:', err instanceof Error ? err.message : String(err)),
    )

    // Emit response event
    if (this.eventBus && episodeId) {
      this.eventBus.emitFireAndForget(
        { type: 'conversation.response.sent', payload: { episodeId, toolsUsed: [], tokenUsage: undefined } },
        { actor: 'system', spaceId: ctx.activeSpaceId, metadata: { episodeId } },
      )
    }

    return {
      response: thinkResult.response,
      sources: thinkResult.sources,
      turnId: thinkResult.turnId,
    }
  }

  // ── Layer 0: Reflex ──────────────────────────────────────────────

  /**
   * Fast rule-based intent detection.
   * Price/search (real-time data) → skill routing → legacy biz fallback.
   */
  private async runReflexLayer(text: string, ctx?: UserContext): Promise<ReflexResult> {
    // External users bypass all L0 rules — go straight to L1 Brain.think()
    if (ctx && isExternalContext(ctx)) {
      return { handled: false, context: '' }
    }

    // ── Real-time data fetch (highest priority — user needs live prices) ─
    if (this.tools && SEARCH_INTENT_RE.test(text)) {
      try {
        if (STEEL_PRICE_RE.test(text)) {
          // Steel price: fetch steelx2 directly (fastest path, domestic)
          logger.info('Router L0: steel price intent → fetch_page')
          let result = await this.tools.execute('fetch_page', { url: STEEL_PRICE_URL })
          if (result && !result.startsWith('抓取失败') && !result.startsWith('抓取出错')) {
            // Strip navigation/contact noise — price table starts at "品名"
            const tableStart = result.indexOf('品名')
            if (tableStart > 0) result = result.slice(tableStart)
            return {
              handled: true,
              context: `\n\n[以下是西本新干线今日上海钢材价格数据，请基于这些数据回答用户]\n${result}\n`,
            }
          }
        } else {
          // General search: Tavily web search
          logger.info('Router L0: search intent → web_search')
          const result = await this.tools.execute('web_search', { query: text })
          if (result && !result.startsWith('Error') && !result.startsWith('未配置')) {
            return {
              handled: true,
              context: `\n\n[以下是实时网络搜索结果，请基于这些数据回答用户]\n${result}\n`,
            }
          }
        }
      } catch (err) {
        logger.error('Router L0 search error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ── Business entry detection (highest priority after real-time data) ─
    // Must run BEFORE skill routing so that business records are auto-persisted
    if (this.bizHandler) {
      try {
        const bizResult = await this.bizHandler.tryHandle(text, ctx?.activeSpaceId)
        if (bizResult.handled && bizResult.response) {
          return {
            handled: true,
            context: '',
            fullyHandled: true,
            directResponse: bizResult.response,
          }
        }
      } catch (err) {
        logger.error('Router L0 biz entry error:', err instanceof Error ? err.message : String(err))
      }
    }

    // ── Skill-based routing ──────────────────────────────────────────
    if (this.skillRouter) {
      try {
        const skillResult = await this.skillRouter.tryHandle(text, ctx?.activeSpaceId)
        if (skillResult.matched && skillResult.handled && skillResult.response) {
          return {
            handled: true,
            context: '',
            fullyHandled: true,
            directResponse: skillResult.response,
          }
        }
        // Context injection: skill matched but delegates to Brain with enriched context
        if (skillResult.matched && skillResult.contextInjection) {
          return {
            handled: true,
            context: skillResult.contextInjection,
          }
        }
      } catch (err) {
        logger.error('Router L0 skill error:', err instanceof Error ? err.message : String(err))
      }
    }

    return { handled: false, context: '' }
  }

  // ── Layer 2: Anticipation ────────────────────────────────────────

  /**
   * Async background processing after response is sent.
   * - Contradiction detection via SurpriseDetector
   * - Learning digest feedback processing
   */
  private async runAnticipationLayer(text: string, ctx: UserContext): Promise<void> {
    // Skip anticipation for external users
    if (isExternalContext(ctx)) return

    if (this.surpriseDetector) {
      await this.surpriseDetector.scanMessage(text, ctx.activeSpaceId)
    }
    await this.processDigestFeedback(text)
  }

  // ── Digest feedback processing ──────────────────────────────────

  /**
   * Detect user feedback on learning digest and adjust bubble confidence.
   * Runs async in L2 — does not block user response.
   */
  private async processDigestFeedback(text: string): Promise<void> {
    try {
      const isPositive = POSITIVE_RE.test(text)
      const isNegative = NEGATIVE_RE.test(text)
      if (!isPositive && !isNegative) return

      const recentDigests = findRecentBySource('learning-digest', Date.now() - FEEDBACK_WINDOW_MS, 1)
      if (recentDigests.length === 0) return

      const digest = recentDigests[0]
      const sourceIds: string[] = (digest.metadata as Record<string, unknown>)?.sourceBubbleIds as string[] ?? []
      if (sourceIds.length === 0) return

      // Match user message keywords against source bubble titles/tags
      const textLower = text.toLowerCase()
      const words = textLower.split(/[\s,，。？！、]+/).filter(w => w.length >= 2)
      const matchedIds: string[] = []

      for (const id of sourceIds) {
        const b = getBubble(id)
        if (!b) continue
        const titleLower = b.title.toLowerCase()
        const tagsStr = b.tags.join(' ').toLowerCase()
        const hasMatch = words.some(w => titleLower.includes(w) || tagsStr.includes(w))
        if (hasMatch) matchedIds.push(id)
      }

      // Fallback: apply to top 5 source bubbles if no specific match
      const targetIds = matchedIds.length > 0 ? matchedIds : sourceIds.slice(0, 5)

      for (const id of targetIds) {
        const b = getBubble(id)
        if (!b) continue

        if (isPositive) {
          const newConfidence = Math.min(1.0, b.confidence * 1.2)
          const newTags = [...new Set([...b.tags, 'user-endorsed'])]
          updateBubble(id, { confidence: newConfidence, tags: newTags })
        } else {
          const newConfidence = Math.max(0.1, b.confidence * 0.5)
          const newTags = [...new Set([...b.tags, 'user-questioned'])]
          updateBubble(id, { confidence: newConfidence, tags: newTags })
        }
      }

      const feedbackType = isPositive ? '正面' : '负面'
      logger.info(`Router L2: digest feedback (${feedbackType}), updated ${targetIds.length} bubbles`)
    } catch (err) {
      logger.error('Router L2 digest feedback error:', err instanceof Error ? err.message : String(err))
    }
  }
}
