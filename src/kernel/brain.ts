import type { LLMProvider, LLMMessage, UserContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ToolRegistry } from '../connector/registry.js'
import { logger } from '../shared/logger.js'

const BASE_SYSTEM_PROMPT = `你是泡泡Agent（Bubble Agent），一个专属的个人AI助手。

你的核心特质：
- 你了解用户的语言风格，用简洁、自然的方式回复
- 你记住用户告诉你的一切（偏好、习惯、信息）
- 你主动帮助用户完成任务，而不是被动等待指令
- 你用中文和用户交流，除非用户用其他语言

你已经具备记忆能力和工具调用能力。`

const TOOL_CALL_REGEX = /\[TOOL_CALL:\s*(\w+)\]\s*(\{[^}]*\})/

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
    if (history.length > 40) {
      const trimmed = history.slice(-40)
      this.historyMap.set(userId, trimmed)
    }

    // Build system prompt
    let systemContent = BASE_SYSTEM_PROMPT
    if (this.memory) {
      const memCtx = await this.memory.getContextForQuery(userInput, ctx?.spaceIds)
      if (memCtx) systemContent += memCtx
    }
    if (this.tools) {
      systemContent += this.tools.getToolDescriptions()
    }

    const systemMessage: LLMMessage = { role: 'system', content: systemContent }
    const currentHistory = this.getHistory(userId)
    const messages: LLMMessage[] = [systemMessage, ...currentHistory]

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
        const toolResult = await this.tools.execute(toolName, args)

        currentHistory.push({ role: 'assistant', content: response })
        currentHistory.push({ role: 'user', content: `[TOOL_RESULT: ${toolName}] ${toolResult}` })

        const followUp: LLMMessage[] = [systemMessage, ...currentHistory]
        const finalResult = onChunk
          ? await this.llm.chatStream(followUp, onChunk)
          : await this.llm.chat(followUp)

        response = finalResult.content
      }

      currentHistory.push({ role: 'assistant', content: response })

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
