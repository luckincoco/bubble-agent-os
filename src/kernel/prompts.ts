import type { UserContext, CustomAgent, SourceRef, ExternalUserContext } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import type { MemoryManager } from '../memory/manager.js'
import type { WorkingMemory } from '../memory/working-memory.js'
import type { ContextBudget } from '../memory/context-budget.js'
import { estimateTokens, TOKEN_LIMITS } from '../shared/tokens.js'
import { getSpaceProfile } from '../connector/biz/space-profile.js'
import { buildExternalSystemPrompt } from './external-prompts.js'

export const BASE_SYSTEM_PROMPT = `你是泡泡Agent（Bubble Agent），一个专属的个人AI助手。

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

export const CRITIQUE_PROMPT = `你是一个严格的批判性审查者，负责审查一段AI回复的质量。逐项检查：

1. 跨域类比：回复是否把一个领域的概念映射到另一个领域？如果有，这个类比在哪里可能失效或误导？
2. 伪精确：是否存在看起来精确但缺乏数据支撑的数字、公式或比率？比喻是否被包装成了数学公式？
3. 事实错误：是否把线性说成指数、把相关说成因果、把比喻说成等价？
4. 讨好模式：是否以赞美、恭维或"您做得很对"结尾，而非提供独立判断？

如果发现任何问题，用2-4句话指出最关键的问题，以"⚠️ 自我审视："开头。语气诚恳、具体，不要泛泛而谈。
如果回复质量良好、没有明显问题，只输出"PASS"。`

export const CRITIQUE_MIN_LENGTH = 300

export const COMPACTION_THRESHOLD = 24
export const COMPACTION_KEEP_RECENT = 6

export const COMPACTION_PROMPT = `你是一个对话摘要助手。请将以下对话历史压缩为一段简洁的摘要，保留：
1. 用户提到的关键实体（人名、公司名、项目名、数字）
2. 重要的决策和结论
3. 用户的偏好和习惯
4. 未解决的问题或待办事项

不要保留闲聊、重复内容和过渡性语句。用中文输出，控制在 500 字以内。`

export interface BuildSystemPromptOptions {
  isExt: boolean
  ctx?: UserContext
  activeAgent: CustomAgent | null
  toolDesc: string
  toolFilter?: string[]
  memory: MemoryManager | null
  userInput: string
  userId: string
  memoryBudget: number
  workingMemory: WorkingMemory | null
  contextBudget: ContextBudget | null
  now: string
  searchSpaceIds?: string[]
}

export interface BuildSystemPromptResult {
  systemContent: string
  sources: SourceRef[]
  fixedTokens: number
}

/**
 * Assemble the system prompt for the LLM based on context:
 * external vs internal, active agent, tool descriptions, memory context,
 * and working memory status.
 */
export async function buildSystemPrompt(opts: BuildSystemPromptOptions): Promise<BuildSystemPromptResult> {
  const { isExt, ctx, activeAgent, toolDesc, memory, userInput, userId, memoryBudget, workingMemory, contextBudget, now, searchSpaceIds } = opts

  let systemContent: string

  if (isExt && ctx && isExternalContext(ctx)) {
    systemContent = buildExternalSystemPrompt(ctx as ExternalUserContext)
  } else {
    systemContent = activeAgent?.systemPrompt
      ? `${activeAgent.systemPrompt}\n\n当前时间：${now}\n\n你已经具备记忆能力和工具调用能力。`
      : `${BASE_SYSTEM_PROMPT}\n\n当前时间：${now}`

    if (ctx?.activeSpaceId) {
      const spaceProfile = getSpaceProfile(ctx.activeSpaceId)
      if (spaceProfile) systemContent += spaceProfile
    }
  }

  let fixedTokens = estimateTokens(systemContent)
  fixedTokens += estimateTokens(toolDesc)

  let sources: SourceRef[] = []

  if (!isExt && memory && memoryBudget > 1000) {
    const memResult = await memory.getContextForQuery(userInput, searchSpaceIds, userId, memoryBudget)
    if (memResult.context) {
      systemContent += memResult.context
      sources = memResult.sources
    }
  }

  if (!isExt && workingMemory && contextBudget) {
    const sessionId = userId
    workingMemory.demoteStaleItems(sessionId)
    const hotItems = workingMemory.getHotItems(sessionId)
    if (hotItems.length > 0) {
      const itemSummaries = hotItems.map(item => ({
        title: item.bubbleId,
        relevance: item.priorityScore,
        pinned: item.pinned,
      }))
      const wmStatus = contextBudget.formatForSystemPrompt(sessionId, itemSummaries)
      systemContent += `\n\n${wmStatus}`
    }
  }

  if (toolDesc) systemContent += toolDesc

  return { systemContent, sources, fixedTokens }
}
