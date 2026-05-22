import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LLMProvider, LLMMessage, UserContext, ThinkResult, CustomAgent, SelfState } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ConversationInsightEvaluator } from '../memory/conversation-insight-evaluator.js'
import type { ObservationRecorder } from '../memory/observation-recorder.js'
import type { AssertionIdentifier } from '../memory/assertion-identifier.js'
import type { ResonanceIntegration } from '../memory/resonance/index.js'
import type { MetricsCollector } from '../memory/resonance/index.js'
import { getDatabase } from '../storage/database.js'
import { ulid } from 'ulid'
import type { ToolRegistry } from '../connector/registry.js'
import type { WorkingMemory } from '../memory/working-memory.js'
import type { ContextBudget } from '../memory/context-budget.js'
import type { Tracer } from '../observability/tracer.js'
import { runToolLoop } from './tool-loop.js'
import { AnswerCache } from './answer-cache.js'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../shared/tokens.js'
import { EXT_TOOL_NAMES } from '../connector/tools/ext-query-tools.js'
import { countDrafts } from '../memory/draft-observations.js'
import { getConfig } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import {
  BASE_SYSTEM_PROMPT,
  CRITIQUE_PROMPT,
  CRITIQUE_MIN_LENGTH,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_RECENT,
  COMPACTION_PROMPT,
  buildSystemPrompt,
} from './prompts.js'

/** Estimate total tokens for an array of LLM messages */
function estimateMessages(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) {
    total += estimateTokens(m.content) + 4 // 4 tokens overhead per message (role, delimiters)
  }
  return total
}

/**
 * Trim history from the oldest end until total token count fits within budget.
 * Always keeps at least the last 2 messages (current user turn).
 */
function trimHistoryByTokens(history: LLMMessage[], budget: number): LLMMessage[] {
  let total = estimateMessages(history)
  if (total <= budget) return history

  // Drop from the front (oldest) until within budget, keep at least last 2
  let start = 0
  while (total > budget && start < history.length - 2) {
    total -= estimateTokens(history[start].content) + 4
    start++
  }
  return history.slice(start)
}

export class Brain {
  private llm: LLMProvider
  private historyMap: Map<string, LLMMessage[]> = new Map()
  private lastActivityMap: Map<string, number> = new Map()
  private memory: MemoryManager | null = null
  private tools: ToolRegistry | null = null
  private agentConfigs: Map<string, CustomAgent> = new Map()
  private insightEvaluator: ConversationInsightEvaluator | null = null
  private observationRecorder: ObservationRecorder | null = null
  private assertionIdentifier: AssertionIdentifier | null = null
  private resonance: ResonanceIntegration | null = null
  private metricsCollector: MetricsCollector | null = null
  private workingMemory: WorkingMemory | null = null
  private contextBudget: ContextBudget | null = null
  private tracer: Tracer | null = null

  /** Handoff 1: loaded cross-session self-state */
  private currentSelfState: SelfState | null = null

  /** Handoff 3: in-memory answer cache for similar queries */
  private answerCache = new AnswerCache()

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  setMemory(memory: MemoryManager) {
    this.memory = memory
    logger.info('Brain: memory system connected')
  }

  setTools(tools: ToolRegistry) {
    this.tools = tools
    logger.info('Brain: tool system connected')
  }

  setInsightEvaluator(evaluator: ConversationInsightEvaluator) {
    this.insightEvaluator = evaluator
    logger.info('Brain: conversation insight evaluator connected')
  }

  setObservationRecorder(recorder: ObservationRecorder) {
    this.observationRecorder = recorder
    logger.info('Brain: observation recorder connected')
  }

  setAssertionIdentifier(identifier: AssertionIdentifier) {
    this.assertionIdentifier = identifier
    logger.info('Brain: assertion identifier connected')
  }

  getAssertionIdentifier(): AssertionIdentifier | null {
    return this.assertionIdentifier
  }

  setResonance(resonance: ResonanceIntegration) {
    this.resonance = resonance
    logger.info('Brain: resonance layer connected (anti-double-emit active)')
  }

  setMetricsCollector(collector: MetricsCollector) {
    this.metricsCollector = collector
    logger.info('Brain: metrics collector connected (5 signal detection)')
  }

  setWorkingMemory(wm: WorkingMemory, budget: ContextBudget) {
    this.workingMemory = wm
    this.contextBudget = budget
    logger.info('Brain: working memory connected')
  }

  setTracer(tracer: Tracer) {
    this.tracer = tracer
    logger.info('Brain: observability tracer connected')
  }

  /** Set or clear the active agent for a user */
  setActiveAgent(userId: string, agent: CustomAgent | null) {
    if (agent) {
      this.agentConfigs.set(userId, agent)
      logger.info(`Brain: agent "${agent.name}" activated for user ${userId}`)
    } else {
      this.agentConfigs.delete(userId)
      logger.info(`Brain: agent deactivated for user ${userId}`)
    }
  }

  private getHistory(userId: string): LLMMessage[] {
    let h = this.historyMap.get(userId)
    if (!h) {
      h = []
      this.historyMap.set(userId, h)
      // 首次访问：尝试加载跨 session SelfState
      this.loadSelfState(userId)
    }
    return h
  }

  /** Clear conversation history for a user */
  clearHistory(userId: string) {
    this.historyMap.delete(userId)
    this.lastActivityMap.delete(userId)
    this.currentSelfState = null
    logger.info(`Brain: history cleared for user ${userId}`)
  }

  /** Handoff 1: load SelfState from disk for cross-session continuity */
  private loadSelfState(userId: string) {
    try {
      const config = getConfig()
      const path = resolve(config.storage.dataDir, 'self-state', `${userId}.json`)
      if (!existsSync(path)) {
        this.currentSelfState = null
        return
      }
      const raw = readFileSync(path, 'utf-8')
      this.currentSelfState = JSON.parse(raw) as SelfState
      const count = this.currentSelfState.unresolvedTensions?.length ?? 0
      if (count > 0) {
        logger.info(`Brain: loaded SelfState for ${userId} (${count} unresolved tensions)`)
      }
    } catch {
      this.currentSelfState = null
    }
  }

  /** Handoff 2: public accessor for router to read SelfState and detect tensions */
  getSelfState(userId: string): SelfState | null {
    if (!this.currentSelfState) {
      this.loadSelfState(userId)
    }
    return this.currentSelfState
  }

  /** Handoff 1: persist SelfState to disk after each think() completes */
  private writeSelfState(userId: string) {
    try {
      const state: SelfState = {
        userId,
        sessionId: ulid(),
        unresolvedTensions: [],
        lastActiveAt: Date.now(),
      }
      const config = getConfig()
      const dir = resolve(config.storage.dataDir, 'self-state')
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, `${userId}.json`), JSON.stringify(state, null, 2), 'utf-8')
    } catch { /* best-effort */ }
  }

  /**
   * Drain sessions that have been idle for at least `maxIdleMs`.
   * Returns the history of idle sessions and clears them from memory.
   * Used by session-compression task to persist structured summaries.
   */
  drainStaleSessions(maxIdleMs: number): Array<{ userId: string; history: LLMMessage[] }> {
    const now = Date.now()
    const drained: Array<{ userId: string; history: LLMMessage[] }> = []
    for (const [userId, lastActive] of this.lastActivityMap) {
      if (now - lastActive > maxIdleMs) {
        const history = this.historyMap.get(userId)
        if (history && history.length > 0) {
          drained.push({ userId, history })
        }
        this.historyMap.delete(userId)
        this.lastActivityMap.delete(userId)
      }
    }
    return drained
  }

  async think(userInput: string, ctx?: UserContext, onChunk?: (text: string) => void): Promise<ThinkResult> {
    const userId = ctx?.userId ?? '_default'

    // Update activity timestamp
    this.lastActivityMap.set(userId, Date.now())

    // Handle "clear conversation" command
    if (/^(清空对话|清空历史|重新开始|reset)$/i.test(userInput.trim())) {
      this.clearHistory(userId)
      const msg = '对话已清空，我们重新开始吧。'
      if (onChunk) onChunk(msg)
      return { response: msg, sources: [] }
    }

    const history = this.getHistory(userId)

    // Truncate overly long user input to prevent blowing context window
    let effectiveInput = userInput
    const inputTokens = estimateTokens(userInput)
    if (inputTokens > TOKEN_LIMITS.SINGLE_MESSAGE_MAX) {
      effectiveInput = truncateToTokenBudget(userInput, TOKEN_LIMITS.SINGLE_MESSAGE_MAX)
      logger.info(`Brain: user input truncated from ~${inputTokens} to ~${TOKEN_LIMITS.SINGLE_MESSAGE_MAX} tokens`)
    }

    history.push({ role: 'user', content: effectiveInput })
    // Hard cap at 40 messages first, then token-trim below
    if (history.length > 40) {
      const trimmed = history.slice(-40)
      this.historyMap.set(userId, trimmed)
    }

    // Context compaction: compress old messages when history is long
    await this.maybeCompactHistory(userId)

    // Track conversation focus for dynamic search weights
    this.memory?.recordFocus(userId, userInput)

    // --- Resolve active agent ---
    const activeAgent = this.agentConfigs.get(userId)
    const isExt = ctx ? isExternalContext(ctx) : false
    const toolFilter = isExt
      ? EXT_TOOL_NAMES
      : activeAgent?.tools?.length ? activeAgent.tools : undefined

    // --- Token budget management ---
    const maxPrompt = TOKEN_LIMITS.MAX_PROMPT_TOKENS
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long', hour: '2-digit', minute: '2-digit' })

    const toolDesc = this.tools ? this.tools.getToolDescriptions(toolFilter) : ''
    const basePrompt = activeAgent?.systemPrompt ?? BASE_SYSTEM_PROMPT
    const memoryBudget = Math.min(
      TOKEN_LIMITS.MEMORY_BUDGET,
      maxPrompt - estimateTokens(basePrompt) - estimateTokens(toolDesc) - TOKEN_LIMITS.COMPLETION_RESERVE - 4000,
    )
    const searchSpaceIds = activeAgent?.spaceIds?.length ? activeAgent.spaceIds : ctx?.spaceIds

    const promptResult = await buildSystemPrompt({
      isExt,
      ctx,
      activeAgent: activeAgent ?? null,
      toolDesc,
      memory: this.memory,
      userInput,
      userId,
      memoryBudget,
      workingMemory: this.workingMemory,
      contextBudget: this.contextBudget,
      now,
      searchSpaceIds,
    })
    let systemContent = promptResult.systemContent
    const sources = promptResult.sources

    // Inject Obsidian notes summary for self-awareness (feature: obsidian-ingest)
    if (!isExt) {
      const notesSummary = this.getObsidianNotesSummary()
      if (notesSummary) {
        systemContent += `\n\n${notesSummary}`
      }
    }

    // Inject draft observations reminder (feature: draft-observations)
    if (!isExt) {
      const config = getConfig()
      if (config.features.draftObservations) {
        const draftCount = countDrafts(ctx?.activeSpaceId)
        if (draftCount > 0) {
          systemContent += `\n\n[待审草稿提醒]\n你有 ${draftCount} 条自主思考草稿等待审核。在对话自然时机提醒用户，可以说"我最近有 ${draftCount} 条新想法等你审阅，要看看吗？"`
        }
      }
    }

    // Inject SelfState context for cross-session awareness (Handoff 1)
    if (!isExt && this.currentSelfState && this.currentSelfState.unresolvedTensions.length > 0) {
      const openTensions = this.currentSelfState.unresolvedTensions
        .filter(t => t.resolutionStatus === 'open')
      if (openTensions.length > 0) {
        const lines = openTensions.map(t =>
          `  - ${t.concepts[0]} ↔ ${t.concepts[1]}（证据比 ${t.evidenceRatio.toFixed(2)}）`
        )
        systemContent += `\n\n[上次会话遗留]\n上次结束时有 ${openTensions.length} 个未解决的认知张力：\n${lines.join('\n')}`
      }
    }

    const systemMessage: LLMMessage = { role: 'system', content: systemContent }
    const systemTokens = estimateTokens(systemContent) + 4

    // History gets whatever remains
    const historyBudget = maxPrompt - systemTokens - TOKEN_LIMITS.COMPLETION_RESERVE
    const currentHistory = this.getHistory(userId)
    const trimmedHistory = trimHistoryByTokens(currentHistory, historyBudget)

    // If we had to trim, update the stored history
    if (trimmedHistory.length < currentHistory.length) {
      this.historyMap.set(userId, trimmedHistory)
    }

    const messages: LLMMessage[] = [systemMessage, ...trimmedHistory]

    const totalEst = estimateMessages(messages)
    logger.debug(`Prompt budget: ~${totalEst} tokens (system ~${systemTokens}, history ${trimmedHistory.length} msgs, limit ${maxPrompt})`)

    try {
      let response: string
      let cognitionLayer: CognitionLayer | undefined
      let panel: ThinkResult['panel'] | undefined
      let toolCalls: ThinkResult['toolCalls']
      let contextSummary: string | undefined

      // ── Handoff 3: answer cache check — skip LLM + tool loop on hit ──
      if (!isExt && !onChunk) {
        const cached = this.answerCache.get(effectiveInput, ctx?.activeSpaceId)
        if (cached) {
          logger.info(`Brain: answer cache HIT for "${effectiveInput.slice(0, 60)}"`)
          const cachedTurnId = ulid()
          const cachedHistory = this.getHistory(userId)
          let cachedResponse = cached.response
          cachedResponse = await this.postProcessResponse(userInput, effectiveInput, cachedResponse, cachedHistory, cachedTurnId, ctx, isExt, userId)
          return {
            response: cachedResponse,
            sources: cached.sources,
            turnId: cachedTurnId,
            cognitionLayer: cached.cognitionLayer,
            panel: cached.panel,
            toolCalls: cached.toolCalls,
            contextSummary: cached.contextSummary,
          }
        }
      }

      if (this.tools) {
        // Multi-step tool calling via ToolLoop
        const loopResult = await runToolLoop(messages, {
          llm: this.llm,
          tools: this.tools,
          ctx,
          onChunk,
        })
        response = loopResult.response

        // Phase 2: classify cognition layer based on tool calls
        const toolNames = loopResult.toolCalls.map(tc => tc.name)
        if (toolNames.some(n => n.startsWith('biz_') || n === 'fetch_page' || n === 'web_search')) {
          cognitionLayer = 'observation'
        } else if (toolNames.some(n => n === 'cross_analyze')) {
          cognitionLayer = 'reflection'
        }

        // Phase 3: construct inline panel data from biz tool calls
        const bizToolCalls = loopResult.toolCalls.filter(tc => tc.name.startsWith('biz_'))
        if (bizToolCalls.length > 0 && cognitionLayer === 'observation') {
          panel = {
            moduleId: 'biz',
            component: 'observation',
            data: {
              actions: bizToolCalls.map(tc => ({
                toolName: tc.name,
                args: tc.args,
                description: describeBizTool(tc.name, tc.args),
              })),
              summary: `查询了 ${bizToolCalls.length} 项业务数据`,
            },
          }
        }

        // Phase 4: construct tool call info from trace for sidebar visualization
        toolCalls = loopResult.trace.steps.map(step => ({
          name: step.tool,
          status: step.error ? 'error' as const : 'success' as const,
          durationMs: step.durationMs,
          error: step.error,
        }))

        // Phase 4: build human-readable context summary from tool calls
        if (loopResult.toolCalls.length > 0) {
          const bizCount = loopResult.toolCalls.filter(tc => tc.name.startsWith('biz_')).length
          const searchCount = loopResult.toolCalls.filter(tc => tc.name === 'web_search' || tc.name === 'fetch_page').length
          const parts: string[] = []
          if (bizCount > 0) parts.push(`查询了 ${bizCount} 项业务数据`)
          if (searchCount > 0) parts.push(`搜索了 ${searchCount} 次`)
          if (parts.length === 0) parts.push(`调用了 ${loopResult.toolCalls.length} 个工具`)
          contextSummary = parts.join('，')
        }

        // Sync tool call messages into stored history
        if (loopResult.toolCalls.length > 0) {
          const storedHistory = this.getHistory(userId)
          for (const tc of loopResult.toolCalls) {
            storedHistory.push({ role: 'assistant', content: `[TOOL_CALL: ${tc.name}] ${JSON.stringify(tc.args)}` })
            storedHistory.push({ role: 'user', content: `[TOOL_RESULT: ${tc.name}] ${tc.result}` })
          }

          // Auto-record observations for tool interactions (feature: observation-recorder)
          if (!isExt) {
            const recorder = this.observationRecorder
            for (const tc of loopResult.toolCalls) {
              if (recorder) {
                try {
                  const spaceId = ctx?.activeSpaceId
                  recorder.record({ action: tc.name, args: tc.args, result: tc.result, userId, spaceId })
                } catch (e) { /* best-effort */ }
              }
            }
          }
        }
      } else {
        // No tools available - direct LLM call
        if (onChunk) {
          const result = await this.llm.chatStream(messages, onChunk)
          response = result.content
        } else {
          const result = await this.llm.chat(messages)
          response = result.content
        }
      }

      const storedHistory = this.getHistory(userId)

      // Post-process: self-critique, history, conversation_turns, memory extraction, insight evaluation
      const turnId = ulid()
      response = await this.postProcessResponse(userInput, effectiveInput, response, storedHistory, turnId, ctx, isExt, userId)

      // Assertion identification: classify claims in the response (async, non-blocking)
      if (!isExt && this.assertionIdentifier) {
        this.assertionIdentifier.identify(effectiveInput, response, turnId, userId, ctx?.activeSpaceId).catch((err) => {
          logger.debug('Assertion identification error:', err instanceof Error ? err.message : String(err))
        })
      }

      // ── Handoff 3: write answer cache for future similar queries ──
      if (!isExt && response && !onChunk) {
        const toolNames = (toolCalls ?? []).map(t => t.name)
        const hasRealTime = toolNames.some(n => n === 'fetch_page' || n === 'web_search')
        const hasBiz = toolNames.some(n => n.startsWith('biz_'))
        const ttl = hasRealTime ? 30_000 : hasBiz ? 120_000 : 60_000
        this.answerCache.set(effectiveInput, ctx?.activeSpaceId, {
          response,
          sources,
          toolCalls: toolCalls ?? [],
          cognitionLayer,
          panel,
          contextSummary,
        }, ttl)
      }

      return { response, sources, cognitionLayer, panel, toolCalls, contextSummary }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Brain think error:', msg)

      // Return friendly message instead of crashing for known failure modes
      const isTimeout = err instanceof Error && err.name === 'AbortError'
      const isTokenLimit = /token|context.*(length|limit|window|exceed)|max.*length/i.test(msg)

      if (isTimeout) {
        const fallback = '抱歉，处理时间过长（超过2分钟），请尝试缩短你的消息或分段发送。'
        const storedHistory = this.getHistory(userId)
        storedHistory.push({ role: 'assistant', content: fallback })
        return { response: fallback, sources: [] }
      }
      if (isTokenLimit) {
        const fallback = '抱歉，对话上下文太长了，我消化不了。请尝试：\n1. 将长文章分段发送\n2. 发一条"清空对话"让我重新开始'
        const storedHistory = this.getHistory(userId)
        storedHistory.push({ role: 'assistant', content: fallback })
        return { response: fallback, sources: [] }
      }

      throw err
    }
  }

  /** Compress old conversation history using LLM when it exceeds threshold */
  private async maybeCompactHistory(userId: string): Promise<void> {
    const history = this.getHistory(userId)
    if (history.length <= COMPACTION_THRESHOLD) return

    const toCompress = history.slice(0, history.length - COMPACTION_KEEP_RECENT)
    const toKeep = history.slice(history.length - COMPACTION_KEEP_RECENT)

    const formatted = toCompress.map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.slice(0, 300)}`).join('\n')

    try {
      const result = await this.llm.chat([
        { role: 'system', content: COMPACTION_PROMPT },
        { role: 'user', content: formatted },
      ])

      const summary = result.content.trim()
      if (summary.length > 10) {
        const compacted: LLMMessage[] = [
          { role: 'system', content: `[对话摘要] ${summary}` },
          ...toKeep,
        ]
        this.historyMap.set(userId, compacted)
        logger.info(`Brain: compacted ${toCompress.length} msgs → summary (${summary.length} chars) + ${toKeep.length} recent`)
      }
    } catch (err) {
      logger.debug(`Brain: compaction failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Run a self-critique pass on a response. Returns critique text or null if PASS. */
  private async selfCritique(userInput: string, response: string): Promise<string | null> {
    if (response.length < CRITIQUE_MIN_LENGTH) return null
    // Skip if response already contains self-critique (from system prompt instructions)
    if (response.includes('⚠️ 自我审视')) return null

    try {
      const result = await this.llm.chat([
        { role: 'system', content: CRITIQUE_PROMPT },
        { role: 'user', content: `用户消息：${userInput.slice(0, 500)}\n\nAI回复：${response}` },
      ])
      const text = result.content.trim()
      if (text === 'PASS' || text.startsWith('PASS')) return null
      return text
    } catch (err) {
      logger.debug('Self-critique error:', err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /**
   * Post-process a response: self-critique, persist to history and conversation_turns,
   * async memory extraction, and insight evaluation.
   * Returns the (possibly modified) response text.
   */
  private async postProcessResponse(
    userInput: string,
    effectiveInput: string,
    response: string,
    storedHistory: LLMMessage[],
    turnId: string,
    ctx?: UserContext,
    isExt = false,
    userId?: string,
  ): Promise<string> {
    let finalResponse = response

    // Self-critique (internal users only)
    if (!isExt) {
      const critique = await this.selfCritique(userInput, finalResponse)
      if (critique) {
        finalResponse = `${finalResponse}\n\n${critique}`
      }
    }

    storedHistory.push({ role: 'assistant', content: finalResponse })

    // Store conversation turn for assertion identification
    if (!isExt && userId) {
      try {
        const db = getDatabase()
        db.prepare(`
          INSERT INTO conversation_turns (id, user_id, space_id, user_input, assistant_response, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          turnId, userId, ctx?.activeSpaceId ?? null,
          effectiveInput.slice(0, 500), finalResponse.slice(0, 1000), Date.now(),
        )
      } catch (err) {
        logger.debug(`Brain: turn storage error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Async post-processing — fire-and-forget, never blocks the response
    const spaceId = ctx?.activeSpaceId

    if (!isExt && this.memory) {
      this.memory.extractAndStore(userInput, finalResponse, spaceId, turnId).catch((err) => {
        logger.debug('Memory extraction error:', err instanceof Error ? err.message : String(err))
      })
    }

    if (!isExt && this.insightEvaluator) {
      this.insightEvaluator.evaluate(userInput, finalResponse, spaceId).catch((err) => {
        logger.debug('Insight evaluation error:', err instanceof Error ? err.message : String(err))
      })
    }

    // Handoff 1: persist SelfState after each think() completes
    if (!isExt && userId) {
      this.writeSelfState(userId)
    }

    return finalResponse
  }

  /** Get a summary of ingested Obsidian notes for agent self-awareness. */
  private getObsidianNotesSummary(): string | null {
    try {
      const db = getDatabase()
      const rows = db.prepare(`
        SELECT b.title, b.updated_at, oi.ingested_at
        FROM bubbles b
        LEFT JOIN obsidian_ingest oi ON b.id = oi.bubble_id
        WHERE b.source = 'obsidian-ingest' AND b.deleted_at IS NULL
        ORDER BY b.updated_at DESC LIMIT 5
      `).all() as Array<{ title: string; updated_at: number; ingested_at: number | null }>
      if (rows.length === 0) return null

      const lines = rows.map(r => {
        const date = new Date(r.updated_at).toLocaleDateString('zh-CN')
        return `  - 《${r.title}》（${date}）`
      })
      return `[已摄入的 Obsidian 笔记]\n${lines.join('\n')}\n使用 memory_list_notes 查看全部。`
    } catch {
      return null
    }
  }
}

// ── Helper: map biz tool names to human-readable descriptions ──────────

/** Map biz tool name + args to a human-readable one-liner */
function describeBizTool(name: string, args: Record<string, unknown>): string {
  const toolLabels: Record<string, string> = {
    biz_dashboard: '业务概览',
    biz_inventory: '库存查询',
    biz_receivables: '应收款查询',
    biz_payables: '应付款查询',
    biz_profit_report: '利润报表',
    biz_profit_by_order: '按单利润',
    biz_counterparty_statement: '往来对账',
    biz_monthly_overview: '月度总览',
    biz_project_reconciliation: '项目结算',
    biz_uninvoiced: '未开票查询',
    biz_silence_alerts: '沉默预警',
    biz_exposure: '财务敞口',
    biz_concentration: '集中度分析',
    biz_relationships: '交易对手关系',
    biz_excel_lookup: 'Excel原始数据查询',
  }
  const label = toolLabels[name] || name
  const params = Object.entries(args)
    .filter(([k]) => k !== '_raw')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')
  return params ? `${label} (${params})` : label
}
