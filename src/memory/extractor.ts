import type { LLMProvider, LLMMessage } from '../shared/types.js'
import { logger } from '../shared/logger.js'

export interface ExtractedMemory {
  title: string
  content: string
  tags: string[]
  confidence: number
}

const EXTRACT_PROMPT = `你是一个记忆提取器。分析用户和助手的对话，提取值得长期记住的关键信息。

提取规则：
1. 只提取具体的事实信息（姓名、偏好、习惯、工作、关系、地点等）
2. 不提取闲聊、问候、临时指令
3. 如果对话中没有值得记住的信息，返回空数组
4. 每条记忆应该是独立的、完整的一句话
5. confidence 表示确信程度：用户明确说的 = 1.0，推测的 = 0.6-0.8

输出格式（严格 JSON 数组）：
[{"title": "简短标题", "content": "完整描述", "tags": ["标签1"], "confidence": 1.0}]

如果没有值得记住的内容，返回：[]`

export class MemoryExtractor {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  async extract(userMessage: string, assistantMessage: string): Promise<ExtractedMemory[]> {
    const messages: LLMMessage[] = [
      { role: 'system', content: EXTRACT_PROMPT },
      { role: 'user', content: `对话内容：\n用户: ${userMessage}\n助手: ${assistantMessage}\n\n请提取值得记住的信息：` },
    ]

    try {
      const response = await this.llm.chat(messages)
      const text = response.content.trim()

      // Extract JSON array from response (handle markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/)
      if (!jsonMatch) {
        logger.debug('Memory extractor: no JSON array found in response')
        return []
      }

      const parsed = JSON.parse(jsonMatch[0]) as ExtractedMemory[]

      if (!Array.isArray(parsed)) return []

      // Validate and filter
      return parsed.filter(
        (m) => m.title && m.content && typeof m.confidence === 'number'
      ).map((m) => ({
        title: m.title,
        content: m.content,
        tags: Array.isArray(m.tags) ? m.tags : [],
        confidence: Math.min(1.0, Math.max(0, m.confidence)),
      }))
    } catch (err) {
      logger.debug('Memory extraction failed:', err instanceof Error ? err.message : String(err))
      return []
    }
  }
}
