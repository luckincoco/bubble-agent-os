import type { LLMProvider, LLMMessage, UserContext, ThinkResult, CustomAgent } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ConversationInsightEvaluator } from '../memory/conversation-insight-evaluator.js'
import type { ToolRegistry } from '../connector/registry.js'
import type { WorkingMemory } from '../memory/working-memory.js'
import type { ContextBudget } from '../memory/context-budget.js'
import { runToolLoop } from './tool-loop.js'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../shared/tokens.js'
import { EXT_TOOL_NAMES } from '../connector/tools/ext-query-tools.js'
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
  private memory: MemoryManager | null = null
  private tools: ToolRegistry | null = null
  private agentConfigs: Map<string, CustomAgent> = new Map()
  private insightEvaluator: ConversationInsightEvaluator | null = null
  private workingMemory: WorkingMemory | null = null
  private contextBudget: ContextBudget | null = null

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

  setWorkingMemory(wm: WorkingMemory, budget: ContextBudget) {
    this.workingMemory = wm
    this.contextBudget = budget
    logger.info('Brain: working memory connected')
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
    }
    return h
  }

  /** Clear conversation history for a user */
  clearHistory(userId: string) {
    this.historyMap.delete(userId)
    logger.info(`Brain: history cleared for user ${userId}`)
  }

  async think(userInput: string, ctx?: UserContext, onChunk?: (text: string) => void): Promise<ThinkResult> {
    const userId = ctx?.userId ?? '_default'

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
      activeAgent,
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
    const sources = promptResult.sources

    const systemMessage: LLMMessage = { role: 'system', content: promptResult.systemContent }
    const systemTokens = estimateTokens(promptResult.systemContent) + 4

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

      if (this.tools) {
        // Multi-step tool calling via ToolLoop
        const loopResult = await runToolLoop(messages, {
          llm: this.llm,
          tools: this.tools,
          ctx,
          onChunk,
        })
        response = loopResult.response

        // Sync tool call messages into stored history
        if (loopResult.toolCalls.length > 0) {
          const storedHistory = this.getHistory(userId)
          for (const tc of loopResult.toolCalls) {
            storedHistory.push({ role: 'assistant', content: `[TOOL_CALL: ${tc.name}] ${JSON.stringify(tc.args)}` })
            storedHistory.push({ role: 'user', content: `[TOOL_RESULT: ${tc.name}] ${tc.result}` })
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

      // Post-process: self-critique, history, memory extraction, insight evaluation
      response = await this.postProcessResponse(userInput, response, storedHistory, ctx, isExt)

      return { response, sources }
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

  /**
   * Post-process a response: self-critique, persist to history, async memory extraction,
   * and insight evaluation. Returns the (possibly modified) response text.
   */
  private async postProcessResponse(
    userInput: string,
    response: string,
    storedHistory: LLMMessage[],
    ctx?: UserContext,
    isExt = false,
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

    // Async post-processing — fire-and-forget, never blocks the response
    const spaceId = ctx?.activeSpaceId

    if (!isExt && this.memory) {
      this.memory.extractAndStore(userInput, finalResponse, spaceId).catch((err) => {
        logger.debug('Memory extraction error:', err instanceof Error ? err.message : String(err))
      })
    }

    if (!isExt && this.insightEvaluator) {
      this.insightEvaluator.evaluate(userInput, finalResponse, spaceId).catch((err) => {
        logger.debug('Insight evaluation error:', err instanceof Error ? err.message : String(err))
      })
    }

    return finalResponse
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
}
