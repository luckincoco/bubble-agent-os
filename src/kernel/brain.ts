import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { LLMProvider, LLMMessage, UserContext, ThinkResult, CustomAgent, SelfState, Tension, FailedHypothesis, SurpriseEntry, ConfidenceGradient, SelfStateTransition, CognitionLayer } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ConversationInsightEvaluator } from '../memory/conversation-insight-evaluator.js'
import type { ObservationRecorder } from '../memory/observation-recorder.js'
import type { AssertionIdentifier } from '../memory/assertion-identifier.js'
import type { ResonanceIntegration } from '../memory/resonance/index.js'
import type { MetricsCollector, ConversationSignal } from '../memory/resonance/index.js'
import type { SelfCalibrator } from '../memory/calibration/self-calibrator.js'
import { getDatabase } from '../storage/database.js'
import { ulid } from 'ulid'
import type { ToolRegistry } from '../connector/registry.js'
import type { WorkingMemory } from '../memory/working-memory.js'
import type { ContextBudget } from '../memory/context-budget.js'
import type { Tracer } from '../observability/tracer.js'
import { runToolLoop } from './tool-loop.js'
import { AnswerCache } from './answer-cache.js'
import { ContinuousBuffer } from '../cognition/continuous-buffer.js'
import { extractMathAbstraction } from '../math/abstraction.js'
import { mergeAbstractions, detectContradictions } from '../math/merge.js'
import type { MathAbstraction } from '../shared/types.js'
import { createBubble, findBubblesByType } from '../bubble/model.js'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../shared/tokens.js'
import { EXT_TOOL_NAMES } from '../connector/tools/ext-query-tools.js'
import { countDrafts } from '../memory/draft-observations.js'
import { getConfig } from '../shared/config.js'
import { logger } from '../shared/logger.js'
import { verifyBizNumbers } from './number-verifier.js'
import { buildNumericalContext } from './numerical-context.js'
import { generateValuePropositions, buildValueStatement } from '../cognition/data-valuation.js'
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
  private selfCalibrator: SelfCalibrator | null = null
  private workingMemory: WorkingMemory | null = null
  private contextBudget: ContextBudget | null = null
  private tracer: Tracer | null = null

  /** Handoff 1: loaded cross-session self-state */
  private currentSelfState: SelfState | null = null

  /** Handoff 3: in-memory answer cache for similar queries */
  private answerCache = new AnswerCache()

  /** ELF-inspired continuous cognition buffer (cross-turn continuous state) */
  private continuousBuffer = new ContinuousBuffer()

  /** P4: accumulated math state per user (cross-turn math model) */
  private mathState = new Map<string, MathAbstraction>()

  /** Phase 3: numerical context for multi-turn consistency */
  private numericalContext = new Map<string, string>()

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

  setSelfCalibrator(calibrator: SelfCalibrator): void {
    this.selfCalibrator = calibrator
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
      const parsed = JSON.parse(raw)

      // ── Normalize: fill in missing fields from older format ──
      this.currentSelfState = {
        userId: parsed.userId ?? userId,
        sessionId: parsed.sessionId ?? ulid(),
        unresolvedTensions: parsed.unresolvedTensions ?? [],
        failedHypotheses: parsed.failedHypotheses ?? [],
        surpriseLog: parsed.surpriseLog ?? [],
        confidenceGradient: parsed.confidenceGradient ?? [],
        recentTransitions: parsed.recentTransitions ?? [],
        lastActiveAt: parsed.lastActiveAt ?? Date.now(),
      }

      const openTensions = this.currentSelfState.unresolvedTensions.filter(t => t.resolutionStatus === 'open').length
      const openSurprises = this.currentSelfState.surpriseLog.filter(s => !s.resolved).length
      if (openTensions > 0 || openSurprises > 0) {
        logger.info(`Brain: loaded SelfState for ${userId} (${openTensions} tensions, ${openSurprises} surprises)`)
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
  private writeSelfState(userId: string, userInput?: string, response?: string) {
    try {
      const config = getConfig()
      const dir = resolve(config.storage.dataDir, 'self-state')
      mkdirSync(dir, { recursive: true })

      // ── 1. Start from previous SelfState (carry forward what's still open) ──
      const prev = this.currentSelfState
      const tensions: Tension[] = []
      const failed: FailedHypothesis[] = prev?.failedHypotheses ?? []
      const surprises: SurpriseEntry[] = prev?.surpriseLog ?? []
      const gradients: ConfidenceGradient[] = prev?.confidenceGradient ?? []
      // Inject SelfCalibrator confidence gradients (overrides for overlapping domains)
      if (this.selfCalibrator && getConfig().features.selfCalibration) {
        const calGradients = this.selfCalibrator.getRecentGradients()
        if (calGradients.length > 0) {
          for (const cg of calGradients) {
            const idx = gradients.findIndex(g => g.domain === cg.domain)
            if (idx >= 0) gradients[idx] = cg
            else gradients.push(cg)
          }
        }
      }
      const transitions: SelfStateTransition[] = prev?.recentTransitions ?? []

      // Carry forward open tensions (not resolved, not abandoned)
      if (prev) {
        for (const t of prev.unresolvedTensions) {
          if (t.resolutionStatus === 'open') {
            tensions.push(t)
          }
        }
      }

      // ── 2. Scan current turn for new signals ──
      if (userInput && response) {
        // 2a. User correction signals → new tension
        const correctionPattern = /不对|不是|错了|不是这样|你理解错了|我说的是|你搞错了|你误解了|你错了/i
        if (correctionPattern.test(userInput)) {
          tensions.push({
            concepts: [userInput.slice(0, 30), response.slice(0, 30)],
            evidenceRatio: 0.3,
            lastReevaluated: Date.now(),
            resolutionStatus: 'open',
            label: '用户纠正',
          })
          // 2d. Same signal → also record as failed hypothesis
          failed.push({
            hypothesis: response.slice(0, 80),
            contradictedBy: userInput.slice(0, 80),
            contradictedAt: Date.now(),
            confidence: 0.3,
          })
        }

        // 2b. Assistant uncertainty signals → tension about own knowledge
        const uncertaintyPattern = /也许|可能|不确定|不太确定|我猜|推测|没有足够信息|不太清楚|无法确认|存疑/i
        if (uncertaintyPattern.test(response)) {
          tensions.push({
            concepts: ['已知信息', response.slice(0, 30)],
            evidenceRatio: 0.5,
            lastReevaluated: Date.now(),
            resolutionStatus: 'open',
            label: '认知不确定',
          })
        }

        // 2c. Unanswered question → gap tension
        if (/不知道|不清楚|无法回答|没有相关信息/.test(response)) {
          tensions.push({
            concepts: [userInput.slice(0, 30), '无法回答'],
            evidenceRatio: 0.2,
            lastReevaluated: Date.now(),
            resolutionStatus: 'open',
            label: '知识盲区',
          })
        }

        // 2e. User expresses surprise → record as surprise entry
        const userSurprisePattern = /惊讶|没想到|居然|竟然|出乎意料|奇怪|怪了|怎么会这样|真的假的|不可能吧|难以置信|太意外了/i
        if (userSurprisePattern.test(userInput)) {
          surprises.push({
            expected: '预期未知',
            actual: userInput.slice(0, 80),
            resolved: false,
            timestamp: Date.now(),
          })
        }

        // 2f. Assistant discovers something surprising → record as self-surprise
        const assistantDiscoveryPattern = /原来|发现|注意到|有意思|没想到|出乎意料|令我惊讶|奇怪的是|竟然|居然/i
        if (assistantDiscoveryPattern.test(response)) {
          surprises.push({
            expected: '先前预期',
            actual: response.slice(0, 80).replace(assistantDiscoveryPattern, '→发现←'),
            resolved: false,
            timestamp: Date.now(),
          })
        }
      }

      // ── 2g. System-detected contradictions in knowledge graph → tensions ──
      // Query recent 'contradicts' links and surface as tensions
      try {
        const db = getDatabase()
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        const contradictRows = db.prepare(`
          SELECT bl.source_id, bl.target_id, b1.title AS src_title, b2.title AS tgt_title, bl.weight, bl.link_source
          FROM bubble_links bl
          JOIN bubbles b1 ON b1.id = bl.source_id
          JOIN bubbles b2 ON b2.id = bl.target_id
          WHERE bl.relation = 'contradicts'
            AND bl.link_source IN ('causal-evaluator', 'difference-engine')
            AND bl.created_at > ?
          LIMIT 5
        `).all(weekAgo) as Array<{ source_id: string; target_id: string; src_title: string; tgt_title: string; weight: number; link_source: string }>

        for (const c of contradictRows) {
          const label = c.link_source === 'difference-engine' ? '维度分歧' : '认知矛盾'
          // Check if a similar tension already exists (avoid duplicates across writeSelfState calls)
          const alreadyExists = tensions.some(t =>
            t.label === label &&
            (t.concepts[0].includes(c.src_title?.slice(0, 15) ?? '') ||
             t.concepts[1].includes(c.tgt_title?.slice(0, 15) ?? ''))
          )
          if (!alreadyExists) {
            // Use link weight as evidence ratio proxy (weight = difference magnitude)
            const evidenceRatio = Math.min(0.8, Math.max(0.2, (c.weight ?? 0.5) / 3))
            tensions.push({
              concepts: [c.src_title?.slice(0, 30) || '未知', c.tgt_title?.slice(0, 30) || '未知'],
              evidenceRatio,
              lastReevaluated: Date.now(),
              resolutionStatus: 'open',
              label,
            })
          }
        }
      } catch { /* best-effort */ }

      // ── 3. Limit to freshest 5 tensions ──
      const finalTensions = tensions
        .sort((a, b) => b.lastReevaluated - a.lastReevaluated)
        .slice(0, 5)

      const state: SelfState = {
        userId,
        sessionId: ulid(),
        unresolvedTensions: finalTensions,
        failedHypotheses: failed.slice(-3),
        surpriseLog: surprises.slice(-3),
        confidenceGradient: gradients.slice(-3),
        recentTransitions: transitions.slice(-5),
        lastActiveAt: Date.now(),
      }
      this.currentSelfState = state
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
    if (!isExt && this.currentSelfState) {
      const ss = this.currentSelfState

      // ── Unresolved tensions ──
      const openTensions = ss.unresolvedTensions?.filter(t => t.resolutionStatus === 'open') ?? []
      if (openTensions.length > 0) {
        const lines = openTensions.map(t => {
          const label = t.label ? `[${t.label}] ` : ''
          return `  - ${label}${t.concepts[0]} ↔ ${t.concepts[1]}`
        })
        systemContent += `\n\n[上次会话遗留 — 未消化的认知张力]\n上次结束时有 ${openTensions.length} 个未解决的问题：\n${lines.join('\n')}\n如果用户提到相关话题，可以自然地衔接。`
      }

      // ── Surprises ──
      const openSurprises = ss.surpriseLog?.filter(s => !s.resolved) ?? []
      if (openSurprises.length > 0) {
        const lines = openSurprises.map(s =>
          `  - 预期「${s.expected}」→ 实际「${s.actual}」`
        )
        systemContent += `\n\n[上次的意外发现]\n${lines.join('\n')}`
      }

      // ── Failed hypotheses ──
      if (ss.failedHypotheses?.length > 0) {
        const lines = ss.failedHypotheses.map(f =>
          `  - 假设「${f.hypothesis}」被「${f.contradictedBy}」推翻`
        )
        systemContent += `\n\n[已被推翻的假设]\n${lines.join('\n')}`
      }
    }

    // Inject continuous cognition buffer context (ELF-inspired)
    if (!isExt && userId) {
      const bufSummary = this.continuousBuffer.getContextSummary(userId)
      if (bufSummary) {
        systemContent += `\n\n${bufSummary}`
      }
    }

    // Inject resonance patterns (feature: resonance-layer)
    if (!isExt && this.resonance && getConfig().features.resonanceLayer) {
      try {
        const paths = this.resonance.findResonantPaths(userInput, ctx?.activeSpaceId)
        if (paths.length > 0) {
          const lines = paths.map(p =>
            `  - [${p.structureType}] ${p.triggerContext} (${p.activationCount}次共激活)`
          )
          systemContent += `\n\n[共振模式]\n以下模式在当前上下文中被反复激活：\n${lines.join('\n')}`
        }
      } catch { /* best-effort */ }
    }

    // Inject high-confidence observations as discovered insights (正法眼藏)
    if (!isExt) {
      try {
        const spaceIds = ctx?.activeSpaceId ? [ctx.activeSpaceId] : undefined
        const observations = findBubblesByType('observation' as any, 10, spaceIds)
          .filter(b => {
            const meta = b.metadata as Record<string, unknown>
            const trend = meta?.trend as string | undefined
            return b.confidence >= 0.7 && trend !== 'stale' && trend !== 'weakening'
          })
          .sort((a, b) => b.confidence - a.confidence)
          .slice(0, 3)
        if (observations.length > 0) {
          const lines = observations.map(o =>
            `  - ${o.title}（置信度 ${(o.confidence * 100).toFixed(0)}%）`
          )
          systemContent += `\n\n[系统发现]\n最近对你对话的分析发现了一些规律：\n${lines.join('\n')}\n如果当前话题相关，可以自然地提及。`
        }
      } catch { /* best-effort */ }
    }

    // Phase 3: inject numerical context from previous tool calls (multi-turn accuracy)
    if (!isExt && getConfig().features.bizStructuredData) {
      const numCtx = this.numericalContext.get(userId)
      if (numCtx) systemContent += numCtx
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
      let dataBlockResults: Array<{ name: string; result: string }> | null = null
      let propositions: import('../shared/types.js').ValueProposition[] | undefined
      let propositionCount: number | undefined

      // ── Handoff 3: answer cache check — skip LLM + tool loop on hit ──
      if (!isExt && !onChunk) {
        const cached = this.answerCache.get(effectiveInput, ctx?.activeSpaceId)
        if (cached) {
          logger.info(`Brain: answer cache HIT for "${effectiveInput.slice(0, 60)}"`)
          const cachedTurnId = ulid()
          const cachedHistory = this.getHistory(userId)
          let cachedResponse = cached.response
          cachedResponse = await this.postProcessResponse(userInput, effectiveInput, cachedResponse, cachedHistory, cachedTurnId, ctx, isExt, userId)
          // Update continuous buffer even for cache hits
          if (!isExt) {
            this.continuousBuffer.update(userId, effectiveInput, cachedResponse)
          }
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

        // Phase 2 (number-verifier): capture [DATA]-containing tool results for post-response number verification
        dataBlockResults = loopResult.toolCalls.filter(
          tc => tc.result && tc.result.includes('[DATA]'),
        ).map(tc => ({ name: tc.name, result: tc.result }))

        // Phase 5: generate value propositions from [DATA] blocks
        if (dataBlockResults.length > 0 && getConfig().features.dataValuation) {
          propositions = generateValuePropositions(dataBlockResults, effectiveInput)
          propositionCount = propositions.length
        }

        // Phase 3: build & store numerical context for multi-turn consistency
        if (dataBlockResults.length > 0) {
          const numCtx = buildNumericalContext(dataBlockResults)
          if (numCtx) this.numericalContext.set(userId, numCtx)
        }

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

      // Phase 2 (number-verifier): check response numbers against [DATA] blocks from tool results
      if (dataBlockResults && dataBlockResults.length > 0 && getConfig().features.bizStructuredData) {
        const correction = verifyBizNumbers(response, dataBlockResults)
        if (correction) response = response + '\n\n' + correction
      }

      // Phase 5 (v2): append value proposition statement to response
      if (propositions && propositions.length > 0 && getConfig().features.dataValuation) {
        const statement = buildValueStatement(propositions)
        if (statement) response = response + '\n\n' + statement
      }

      // Assertion identification: classify claims in the response (async, non-blocking)
      if (!isExt && this.assertionIdentifier) {
        this.assertionIdentifier.identify(effectiveInput, response, turnId, userId, ctx?.activeSpaceId).catch((err) => {
          logger.debug('Assertion identification error:', err instanceof Error ? err.message : String(err))
        })
      }

      // Analyze conversation signals + self-calibration
      const calibrationSignals: ConversationSignal[] = []
      if (!isExt && this.metricsCollector && getConfig().features.resonanceLayer) {
        try {
          const signals = this.metricsCollector.analyzeUserMessage(effectiveInput, response, userId, ctx?.activeSpaceId)
          calibrationSignals.push(...signals)
        } catch { /* best-effort */ }
      }
      if (!isExt && this.selfCalibrator && getConfig().features.selfCalibration && calibrationSignals.length > 0) {
        try {
          this.selfCalibrator.calibrate(calibrationSignals, ctx?.activeSpaceId)
        } catch { /* best-effort */ }
      }

      // ── Automatic Math Abstraction: extract math structure from conversation ──
      if (!isExt) {
        extractMathAbstraction(effectiveInput + '\n' + response, this.llm).then(result => {
          if (result && ctx?.activeSpaceId) {
            createBubble({
              type: 'observation',
              title: '数学抽象: ' + result.summary.slice(0, 30),
              content: JSON.stringify(result, null, 2),
              tags: ['auto-math', 'math-abstraction', `math-conf:${result.confidence.toFixed(2)}`],
              source: 'math-abstraction',
              confidence: Math.min(1, result.confidence),
              decayRate: 0.15,
              spaceId: ctx.activeSpaceId,
              abstractionLevel: 2,
            })

            // Accumulate math state across turns (P4)
            const prev = this.mathState.get(userId)
            if (prev) {
              const merged = mergeAbstractions([prev, result])
              this.mathState.set(userId, merged)
              const contradictions = detectContradictions(prev, result)
              if (contradictions.length > 0) {
                logger.info(`Math state contradiction for ${userId}: ${contradictions.map(c => c.description).join('; ')}`)
              }
            } else {
              this.mathState.set(userId, result)
            }
          }
        }).catch((err) => {
          logger.debug(`Auto math abstraction error: ${err instanceof Error ? err.message : String(err)}`)
        })
      }

      // ── Continuous Cognition Buffer: update + materialize ──
      if (!isExt) {
        this.continuousBuffer.update(userId, effectiveInput, response)
        // Try materialize (no-op if divergence hasn't crossed threshold yet)
        this.continuousBuffer.materialize(userId, ctx?.activeSpaceId)
      }

      // ── Handoff 3: write answer cache for future similar queries ──
      if (!isExt && response && !onChunk) {
        const toolNames = (toolCalls ?? []).map(t => t.name)
        const hasRealTime = toolNames.some(n => n === 'fetch_page' || n === 'web_search')
        const hasBiz = toolNames.some(n => n.startsWith('biz_'))
        const ttl = hasRealTime ? 15_000 : hasBiz ? 15_000 : 60_000
        this.answerCache.set(effectiveInput, ctx?.activeSpaceId, {
          response,
          sources,
          toolCalls: toolCalls ?? [],
          cognitionLayer,
          panel,
          contextSummary,
        }, ttl)
      }

      return { response, sources, cognitionLayer, panel, toolCalls, contextSummary, propositions, propositionCount }
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
    const finalResponse = response

    // Self-critique (internal users only) — fire-and-forget, never blocks the response
    if (!isExt) {
      this.selfCritique(userInput, finalResponse).then(critique => {
        if (critique) {
          logger.info(`Self-critique: ${critique.slice(0, 200)}`)
        }
      }).catch(err => {
        logger.debug(`Self-critique error: ${err instanceof Error ? err.message : String(err)}`)
      })
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
      this.writeSelfState(userId, effectiveInput, finalResponse)
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
