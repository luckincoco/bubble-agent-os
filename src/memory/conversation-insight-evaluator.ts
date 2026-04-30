/**
 * Conversation Insight Evaluator — query feedback loop.
 *
 * After each Brain.think() turn, this evaluator asynchronously checks whether
 * the assistant's response synthesized novel insights that should be persisted
 * back into the knowledge base. This closes the feedback loop:
 *   user question → memory retrieval → LLM reasoning → NEW knowledge → memory store
 *
 * Only fires when the response demonstrates genuine synthesis (combining multiple
 * sources, drawing conclusions, identifying patterns) rather than simple retrieval.
 */

import type { LLMProvider, LLMMessage } from '../shared/types.js'
import { createBubble, searchBubbles } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

// ── Types ──────────────────────────────────────────────────────

interface InsightCandidate {
  title: string
  content: string
  tags: string[]
  sourceType: 'synthesis' | 'observation' | 'question'
}

interface EvalResult {
  hasInsight: boolean
  candidates: InsightCandidate[]
}

// ── Constants ──────────────────────────────────────────────────

const MIN_RESPONSE_LENGTH = 200
const MAX_CANDIDATES_PER_TURN = 3

const EVAL_PROMPT = `你是知识萃取引擎。分析一段AI对话回复，判断是否包含值得持久化的新洞察。

值得保存的洞察:
- 用户隐含的偏好或习惯（对话中自然流露的，非直接陈述的）
- AI综合多条信息后得出的新结论或模式
- 用户提出的有深度的问题（反映认知边界）
- 对话中发现的矛盾或修正

不值得保存的:
- 简单的事实检索（用户问什么AI答什么）
- 闲聊、问候、确认性回复
- 已经在记忆中存在的信息的重复

输出严格JSON:
{
  "hasInsight": true/false,
  "candidates": [
    {
      "title": "洞察标题（10字以内）",
      "content": "洞察内容（一段话描述完整发现）",
      "tags": ["标签1", "标签2"],
      "sourceType": "synthesis" | "observation" | "question"
    }
  ]
}

candidates最多${MAX_CANDIDATES_PER_TURN}条。如果没有洞察，candidates为空数组。`

// ── Evaluator ──────────────────────────────────────────────────

export class ConversationInsightEvaluator {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Evaluate a conversation turn for novel insights.
   * Called asynchronously from Brain.think() — never blocks the response.
   */
  async evaluate(
    userInput: string,
    assistantResponse: string,
    spaceId?: string,
  ): Promise<number> {
    // Skip short/trivial responses
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return 0

    // Skip if response is an error or fallback
    if (assistantResponse.includes('抱歉') && assistantResponse.length < 300) return 0

    try {
      const result = await this.extractInsights(userInput, assistantResponse)
      if (!result.hasInsight || result.candidates.length === 0) return 0

      let stored = 0
      for (const candidate of result.candidates.slice(0, MAX_CANDIDATES_PER_TURN)) {
        const isDup = await this.isDuplicate(candidate, spaceId)
        if (isDup) continue

        const bubble = createBubble({
          type: candidate.sourceType === 'question' ? 'question' : candidate.sourceType === 'observation' ? 'observation' : 'synthesis',
          title: candidate.title,
          content: candidate.content,
          tags: [...candidate.tags, 'conversation-insight'],
          source: 'conversation-insight',
          confidence: 0.7,
          decayRate: 0.08,
          spaceId,
          abstractionLevel: 1,
        })
        stored++
        logger.debug(`ConversationInsight: stored "${candidate.title}" as ${candidate.sourceType}`)
      }

      if (stored > 0) {
        logger.info(`ConversationInsight: ${stored} new insights from conversation`)
      }
      return stored
    } catch (err) {
      logger.debug(`ConversationInsight: eval error: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
  }

  private async extractInsights(userInput: string, response: string): Promise<EvalResult> {
    const messages: LLMMessage[] = [
      { role: 'system', content: EVAL_PROMPT },
      {
        role: 'user',
        content: `## 用户消息\n${userInput.slice(0, 500)}\n\n## AI回复\n${response.slice(0, 1500)}`,
      },
    ]

    const result = await this.llm.chat(messages)
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { hasInsight: false, candidates: [] }

    const parsed = JSON.parse(jsonMatch[0]) as EvalResult
    return {
      hasInsight: parsed.hasInsight ?? false,
      candidates: (parsed.candidates || []).filter(
        (c: InsightCandidate) => c.title && c.content && c.content.length > 20,
      ),
    }
  }

  private async isDuplicate(candidate: InsightCandidate, spaceId?: string): Promise<boolean> {
    const existing = searchBubbles(candidate.title, 5, spaceId ? [spaceId] : undefined)
    return existing.some(b => {
      // High title similarity = likely duplicate
      const titleOverlap = candidate.title.length > 4 && b.title.includes(candidate.title.slice(0, 4))
      const contentOverlap = candidate.content.length > 20 && b.content.includes(candidate.content.slice(0, 20))
      return titleOverlap && contentOverlap
    })
  }
}
