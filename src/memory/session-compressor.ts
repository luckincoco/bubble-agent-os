import type { LLMProvider, LLMMessage } from '../shared/types.js'
import { createBubble } from '../bubble/model.js'
import { estimateTokens } from '../shared/tokens.js'
import { logger } from '../shared/logger.js'

/**
 * Session Compressor
 *
 * When a conversation session goes idle, compress it into a structured
 * summary bubble. This preserves key decisions, entities, and context
 * without consuming ongoing token budget.
 *
 * Inspired by agentmemory's consolidation pipeline: raw episodes → structured memory.
 */

const COMPRESSION_PROMPT = `你是一个对话分析助手。请将以下对话压缩为一份结构化摘要。

输出格式（严格遵守）：
## 主题
一句话概括本次对话的核心主题

## 关键实体
- 列出提到的人名、公司、项目、产品、数字（用 key: value 格式）

## 决策与结论
- 列出本次对话中达成的决策或结论

## 待办与未决
- 列出未解决的问题或后续行动

## 用户偏好
- 如果对话中体现了用户的偏好或习惯，列出

要求：
- 不保留闲聊和过渡语
- 数字务必精确保留
- 总长度不超过 400 字`

export interface CompressionResult {
  userId: string
  summary: string
  bubbleId: string
}

export class SessionCompressor {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Compress a completed session into a structured summary bubble.
   */
  async compress(userId: string, messages: LLMMessage[], spaceId?: string): Promise<CompressionResult | null> {
    // Skip very short sessions (not worth compressing)
    if (messages.length < 4) return null

    // Format conversation for the LLM
    const formatted = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        const role = m.role === 'user' ? '用户' : 'AI'
        // Truncate very long messages
        const content = m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content
        return `${role}: ${content}`
      })
      .join('\n')

    // Check total size - skip if too small to be meaningful
    const totalTokens = estimateTokens(formatted)
    if (totalTokens < 100) return null

    // Cap input to prevent blowing context
    const cappedFormatted = totalTokens > 3000
      ? formatted.slice(0, 8000)
      : formatted

    try {
      const result = await this.llm.chat([
        { role: 'system', content: COMPRESSION_PROMPT },
        { role: 'user', content: cappedFormatted },
      ])

      const summary = result.content.trim()
      if (summary.length < 20) return null

      // Extract title from summary (first heading or first line)
      const titleMatch = summary.match(/^##\s*主题\s*\n(.+)/m)
      const title = titleMatch?.[1]?.trim() || `对话摘要 ${new Date().toLocaleDateString('zh-CN')}`

      // Store as a synthesis bubble
      const bubble = createBubble({
        type: 'synthesis',
        title,
        content: summary,
        tags: ['session-summary', `user:${userId}`],
        source: 'session_compression',
        confidence: 0.85,
        decayRate: 0.06, // Slow decay - session summaries are valuable long-term
        spaceId,
      })

      logger.info(`Session compressed for user ${userId}: ${title} (${messages.length} msgs → ${summary.length} chars)`)
      return { userId, summary, bubbleId: bubble.id }
    } catch (err) {
      logger.debug(`Session compression failed for ${userId}:`, err instanceof Error ? err.message : String(err))
      return null
    }
  }
}
