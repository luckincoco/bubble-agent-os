import type { LLMProvider, LLMMessage, UserContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ToolRegistry } from '../connector/registry.js'
import { estimateTokens, TOKEN_LIMITS } from '../shared/tokens.js'
import { logger } from '../shared/logger.js'

const BASE_SYSTEM_PROMPT = `你是泡泡Agent（Bubble Agent），一个专属的个人AI助手。

你的核心特质：
- 你了解用户的语言风格，用简洁、自然的方式回复
- 你记住用户告诉你的一切（偏好、习惯、信息）
- 你主动帮助用户完成任务，而不是被动等待指令
- 你用中文和用户交流，除非用户用其他语言

你已经具备记忆能力和工具调用能力。`

const TOOL_CALL_REGEX = /\[TOOL_CALL:\s*(\w+)\]\s*(\{[^}]*\})/

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

  private getHistory(userId: string): LLMMessage[] {
    let h = this.historyMap.get(userId)
    if (!h) {
      h = []
      this.historyMap.set(userId, h)
    }
    return h
  }

  async think(userInput: string, ctx?: UserContext, onChunk?: (text: string) => void): Promise<string> {
    const userId = ctx?.userId ?? '_default'
    const history = this.getHistory(userId)

    history.push({ role: 'user', content: userInput })
    // Hard cap at 40 messages first, then token-trim below
    if (history.length > 40) {
      const trimmed = history.slice(-40)
      this.historyMap.set(userId, trimmed)
    }

    // Track conversation focus for dynamic search weights
    this.memory?.recordFocus(userId, userInput)

    // --- Token budget management ---
    const maxPrompt = TOKEN_LIMITS.MAX_PROMPT_TOKENS
    let systemContent = BASE_SYSTEM_PROMPT
    let fixedTokens = estimateTokens(systemContent)

    // Tool descriptions (fixed cost, add first)
    let toolDesc = ''
    if (this.tools) {
      toolDesc = this.tools.getToolDescriptions()
      fixedTokens += estimateTokens(toolDesc)
    }

    // Memory context gets a budget = total - fixed - reserved for history
    const memoryBudget = Math.min(
      TOKEN_LIMITS.MEMORY_BUDGET,
      maxPrompt - fixedTokens - TOKEN_LIMITS.COMPLETION_RESERVE - 4000, // 4000 = minimum history room
    )

    if (this.memory && memoryBudget > 1000) {
      const memCtx = await this.memory.getContextForQuery(userInput, ctx?.spaceIds, userId, memoryBudget)
      if (memCtx) systemContent += memCtx
    }
    if (toolDesc) systemContent += toolDesc

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

      if (onChunk) {
        const result = await this.llm.chatStream(messages, onChunk)
        response = result.content
      } else {
        const result = await this.llm.chat(messages)
        response = result.content
      }

      // Check for tool calls in response
      const toolMatch = response.match(TOOL_CALL_REGEX)
      if (toolMatch && this.tools) {
        const [, toolName, argsStr] = toolMatch
        logger.debug(`Tool call: ${toolName}`)
        const args = JSON.parse(argsStr)
        const toolResult = await this.tools.execute(toolName, args, ctx)

        const storedHistory = this.getHistory(userId)
        storedHistory.push({ role: 'assistant', content: response })
        storedHistory.push({ role: 'user', content: `[TOOL_RESULT: ${toolName}] ${toolResult}` })

        // Re-trim for the follow-up call
        const followUpHistory = trimHistoryByTokens(storedHistory, historyBudget)
        const followUp: LLMMessage[] = [systemMessage, ...followUpHistory]
        const finalResult = onChunk
          ? await this.llm.chatStream(followUp, onChunk)
          : await this.llm.chat(followUp)

        response = finalResult.content
      }

      const storedHistory = this.getHistory(userId)
      storedHistory.push({ role: 'assistant', content: response })

      if (this.memory) {
        this.memory.extractAndStore(userInput, response, ctx?.activeSpaceId).catch((err) => {
          logger.debug('Memory extraction error:', err instanceof Error ? err.message : String(err))
        })
      }

      return response
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Brain think error:', msg)
      throw err
    }
  }
}
