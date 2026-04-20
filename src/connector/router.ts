import type { Brain } from '../kernel/brain.js'
import type { ToolRegistry } from './registry.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import type { BizEntryHandler } from './biz/handler.js'
import type { SkillRouter as SkillRouterType } from './skills/skill-router.js'
import type { UserContext, ThinkResult } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import { findRecentBySource, getBubble, updateBubble } from '../bubble/model.js'
import { logger } from '../shared/logger.js'

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
}

// ── MessageRouter ────────────────────────────────────────────────────

export class MessageRouter {
  private brain: Brain
  private tools: ToolRegistry | null
  private surpriseDetector: SurpriseDetector | null
  private bizHandler: BizEntryHandler | null
  private skillRouter: SkillRouterType | null

  constructor(deps: {
    brain: Brain
    tools?: ToolRegistry
    surpriseDetector?: SurpriseDetector
    bizHandler?: BizEntryHandler
    skillRouter?: SkillRouterType
  }) {
    this.brain = deps.brain
    this.tools = deps.tools ?? null
    this.surpriseDetector = deps.surpriseDetector ?? null
    this.bizHandler = deps.bizHandler ?? null
    this.skillRouter = deps.skillRouter ?? null
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
    options?: { onChunk?: (text: string) => void },
  ): Promise<RouterResult> {
    // ── Layer 0: Reflex ────────────────────────────────────────────
    const reflex = await this.runReflexLayer(text, ctx)

    // If Layer 0 fully handled the request (e.g. biz entry), skip Brain
    if (reflex.fullyHandled && reflex.directResponse) {
      // Layer 2 still runs (contradiction detection is valuable for biz data)
      this.runAnticipationLayer(text, ctx).catch(err =>
        logger.error('Router L2 anticipation error:', err instanceof Error ? err.message : String(err)),
      )
      return { response: reflex.directResponse, sources: [] }
    }

    // ── Layer 1: Deliberation ──────────────────────────────────────
    const finalInput = reflex.context ? `${text}${reflex.context}` : text
    const thinkResult = await this.brain.think(finalInput, ctx, options?.onChunk)

    // ── Layer 2: Anticipation (async, non-blocking) ────────────────
    this.runAnticipationLayer(text, ctx).catch(err =>
      logger.error('Router L2 anticipation error:', err instanceof Error ? err.message : String(err)),
    )

    return {
      response: thinkResult.response,
      sources: thinkResult.sources,
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
