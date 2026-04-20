/**
 * LLM-based knowledge record parser for the "teach bubble" skill.
 * Uses a focused prompt to extract structured JSON from natural language.
 * One LLM call per parse — no streaming, no memory context.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js'
import type { TeachAction } from './detector.js'
import { logger } from '../../shared/logger.js'

export interface TeachRecord {
  action: TeachAction
  entityName: string
  entityType: 'supplier' | 'customer' | 'project' | 'product' | 'person' | 'rule' | 'other'
  attribute?: string
  value?: string
  factText: string
  tags: string[]
  rawInput: string
}

const SYSTEM_PROMPT = `你是知识卡片解析器。将用户教给泡泡的业务知识解析为严格JSON。

输出格式（只输出JSON，不要其他文字）：
{
  "entityName": "实体名称（供应商/客户/项目/产品/人名）",
  "entityType": "supplier|customer|project|product|person|rule|other",
  "attribute": "属性名（联系人、电话、产品线、回款情况等，可空）",
  "value": "属性值（可空）",
  "factText": "整理后的完整知识描述（一句话）",
  "tags": ["标签1", "标签2"]
}

规则：
- entityName 必填，是知识的主语（品牌A、供应商A、示例项目A...）
- entityType 根据语境判断：供应商=supplier、客户/项目=customer或project、产品=product、人=person
- 否定事实（没有/不做/不接）要在 factText 中保留否定含义
- tags 包含实体名和关键主题词，便于检索
- 通用规则（非特定实体）entityType 填 "rule"
- 只输出一个JSON对象`

export class TeachParser {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  async parse(bodyText: string, action: TeachAction, rawInput: string): Promise<TeachRecord | null> {
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `用户教泡泡的内容：${bodyText}` },
    ]

    try {
      const response = await this.llm.chat(messages)
      const text = response.content.trim()

      // Extract JSON object from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.debug('TeachParser: no JSON object found in response')
        return null
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>

      // Validate required fields
      const entityName = parsed.entityName as string
      const factText = parsed.factText as string
      if (!entityName || !factText) {
        logger.debug(`TeachParser: missing required field (entityName="${entityName}", factText="${factText}")`)
        return null
      }

      // Validate entityType
      const validTypes = ['supplier', 'customer', 'project', 'product', 'person', 'rule', 'other']
      let entityType = parsed.entityType as string
      if (!validTypes.includes(entityType)) {
        entityType = 'other'
      }

      // Build tags array, ensure it's an array
      let tags: string[] = []
      if (Array.isArray(parsed.tags)) {
        tags = parsed.tags.filter((t): t is string => typeof t === 'string')
      }

      return {
        action,
        entityName,
        entityType: entityType as TeachRecord['entityType'],
        attribute: parsed.attribute as string | undefined,
        value: parsed.value as string | undefined,
        factText,
        tags,
        rawInput,
      }
    } catch (err) {
      logger.debug('TeachParser error:', err instanceof Error ? err.message : String(err))
      return null
    }
  }
}
