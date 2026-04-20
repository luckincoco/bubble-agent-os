import type { LLMProvider, LLMMessage, UserContext, ThinkResult, CustomAgent, SourceRef } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ToolRegistry } from '../connector/registry.js'
import { runToolLoop } from './tool-loop.js'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../shared/tokens.js'
import { getSpaceProfile } from '../connector/biz/space-profile.js'
import { buildExternalSystemPrompt } from './external-prompts.js'
import { EXT_TOOL_NAMES } from '../connector/tools/ext-query-tools.js'
import { logger } from '../shared/logger.js'

const BASE_SYSTEM_PROMPT = `你是泡泡Agent（Bubble Agent），一个专属的个人AI助手。

你的核心特质：
- 你了解用户的语言风格，用简洁、自然的方式回复
- 你记住用户告诉你的一切（偏好、习惯、信息）
- 你主动帮助用户完成任务，而不是被动等待指令
- 你用中文和用户交流，除非用户用其他语言

你的认知底色——「问」：
- 问题 = 现状与期望之间的落差。在回应之前，先审视：谁的问题？基于什么期望？现状的感知是否真实？
- 先问再答：当需求模糊时，先帮用户澄清问题本身，而非急于给出答案
- 拓展再收敛：先展开可能性（向上追问前提、向下追问根基、横向追问不同视角），再收敛到行动
- 保护困惑：当用户表达困惑或不确定时，不要急于消解它——困惑本身是信号

你的认知纪律——「自我质疑」：
- 区分来源：你说的每个事实和数字，是来自用户提供的数据、你检索到的信息、还是你自己的推测？如果是推测，必须明确标注
- 警惕伪精确：不要用精确的数字包装模糊的判断。"大约""可能在…范围""我没有足够数据判断"比一个编造的精确数字更诚实
- 反思框架适用性：当你把一个领域的模型套用到另一个领域时，主动说明这个类比在哪里成立、在哪里可能失效
- 承认边界：如果你对某个问题的理解确实不够，直接说"这超出了我目前的理解"，而不是生成一个看似合理的回答

你已经具备记忆能力和工具调用能力。`

const CRITIQUE_PROMPT = `你是一个严格的批判性审查者，负责审查一段AI回复的质量。逐项检查：

1. 跨域类比：回复是否把一个领域的概念映射到另一个领域？如果有，这个类比在哪里可能失效或误导？
2. 伪精确：是否存在看起来精确但缺乏数据支撑的数字、公式或比率？比喻是否被包装成了数学公式？
3. 事实错误：是否把线性说成指数、把相关说成因果、把比喻说成等价？
4. 讨好模式：是否以赞美、恭维或"您做得很对"结尾，而非提供独立判断？

如果发现任何问题，用2-4句话指出最关键的问题，以"⚠️ 自我审视："开头。语气诚恳、具体，不要泛泛而谈。
如果回复质量良好、没有明显问题，只输出"PASS"。`

const CRITIQUE_MIN_LENGTH = 300

const COMPACTION_THRESHOLD = 24  // Trigger compaction when history exceeds this many messages
const COMPACTION_KEEP_RECENT = 6 // Always keep last N messages intact

const COMPACTION_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要，保留：
1. 用户提到的关键实体（人名、公司名、项目名、数字）
2. 重要的决策和结论
3. 用户的偏好和习惯
4. 未解决的问题或待办事项

不要保留闲聊、重复内容和过渡性语句。用中文输出，控制在 500 字以内。`

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

    let systemContent: string
    if (isExt && isExternalContext(ctx!)) {
      // External user: use dedicated external prompt, no space profile, no memory
      systemContent = buildExternalSystemPrompt(ctx)
    } else {
      systemContent = activeAgent?.systemPrompt
        ? `${activeAgent.systemPrompt}\n\n当前时间：${now}\n\n你已经具备记忆能力和工具调用能力。`
        : `${BASE_SYSTEM_PROMPT}\n\n当前时间：${now}`

      // Inject space profile (SPACE.md equivalent) for business context
      if (ctx?.activeSpaceId) {
        const spaceProfile = getSpaceProfile(ctx.activeSpaceId)
        if (spaceProfile) systemContent += spaceProfile
      }
    }

    let fixedTokens = estimateTokens(systemContent)

    // Tool descriptions (fixed cost, add first)
    let toolDesc = ''
    if (this.tools) {
      toolDesc = this.tools.getToolDescriptions(toolFilter)
      fixedTokens += estimateTokens(toolDesc)
    }

    // Memory context gets a budget = total - fixed - reserved for history
    const memoryBudget = Math.min(
      TOKEN_LIMITS.MEMORY_BUDGET,
      maxPrompt - fixedTokens - TOKEN_LIMITS.COMPLETION_RESERVE - 4000, // 4000 = minimum history room
    )

    // If agent has spaceIds, narrow the search scope
    const searchSpaceIds = activeAgent?.spaceIds?.length ? activeAgent.spaceIds : ctx?.spaceIds

    let sources: SourceRef[] = []
    // Skip memory retrieval for external users
    if (!isExt && this.memory && memoryBudget > 1000) {
      const memResult = await this.memory.getContextForQuery(userInput, searchSpaceIds, userId, memoryBudget)
      if (memResult.context) {
        systemContent += memResult.context
        sources = memResult.sources
      }
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

      // Self-critique: skip for external users (unnecessary overhead)
      if (!isExt) {
        const critique = await this.selfCritique(userInput, response)
        if (critique) {
          response = `${response}\n\n${critique}`
        }
      }

      storedHistory.push({ role: 'assistant', content: response })

      // Skip memory extraction for external users
      if (!isExt && this.memory) {
        this.memory.extractAndStore(userInput, response, ctx?.activeSpaceId).catch((err) => {
          logger.debug('Memory extraction error:', err instanceof Error ? err.message : String(err))
        })
      }

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
