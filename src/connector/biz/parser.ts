/**
 * Minimal LLM-based business record parser.
 * Uses a focused prompt (~300 tokens) to extract structured JSON from natural language.
 * One LLM call per parse — no streaming, no memory context.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js'
import type { BizType, BizRecord } from './schema.js'
import { logger } from '../../shared/logger.js'

function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const SYSTEM_PROMPT = `你是钢贸业务数据解析器。将用户的自然语言输入解析为严格JSON对象。
今天是 {TODAY}。如果用户说"今天"则date填今天，说"昨天"填昨天，以此类推。

根据业务类型输出对应JSON（只输出JSON，不要其他文字）：

采购:
{"bizType":"procurement","date":"YYYY-MM-DD","supplier":"供应商","product":"品名","spec":"规格","quantity":0,"unitPrice":0,"project":"项目名"}

销售:
{"bizType":"sales","date":"YYYY-MM-DD","customer":"客户","product":"品名","spec":"规格","quantity":0,"unitPrice":0,"project":"项目名"}

收付款:
{"bizType":"payment","date":"YYYY-MM-DD","counterparty":"对方","direction":"收或付","amount":0,"method":"方式","project":"项目名"}

物流:
{"bizType":"logistics","date":"YYYY-MM-DD","carrier":"承运公司","destination":"目的地","tonnage":0,"freight":0,"liftingFee":0,"driver":"司机","licensePlate":"车牌"}

规则：
- 用户未提及的字段直接省略，不要填空字符串或0
- totalAmount不需要输出（系统自动算）
- 规格如"14的"表示Ø14，"12的螺纹"表示Ø12螺纹钢
- 只输出一个JSON对象`

/** Required fields per biz type — if missing, parse is considered failed */
const REQUIRED_FIELDS: Record<BizType, string[]> = {
  procurement: ['supplier', 'product'],
  sales: ['customer', 'product'],
  payment: ['counterparty', 'amount'],
  logistics: ['destination'],
}

export class BizParser {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  async parse(rawInput: string, hintBizType: BizType): Promise<BizRecord | null> {
    const systemContent = SYSTEM_PROMPT.replace('{TODAY}', todayStr())

    const messages: LLMMessage[] = [
      { role: 'system', content: systemContent },
      { role: 'user', content: `业务类型提示: ${hintBizType}\n用户原文: ${rawInput}` },
    ]

    try {
      const response = await this.llm.chat(messages)
      const text = response.content.trim()

      // Extract JSON object from response (handle markdown code blocks)
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.debug('BizParser: no JSON object found in response')
        return null
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>

      // Validate bizType
      const bizType = parsed.bizType as BizType
      if (!['procurement', 'sales', 'payment', 'logistics'].includes(bizType)) {
        logger.debug(`BizParser: invalid bizType "${bizType}"`)
        return null
      }

      // Validate required fields
      const required = REQUIRED_FIELDS[bizType]
      for (const field of required) {
        const val = parsed[field]
        if (val === undefined || val === null || val === '') {
          logger.debug(`BizParser: missing required field "${field}" for ${bizType}`)
          return null
        }
      }

      // Default date to today if not provided
      if (!parsed.date) {
        parsed.date = todayStr()
      }

      // Auto-calculate totalAmount for procurement/sales
      if ((bizType === 'procurement' || bizType === 'sales') && parsed.quantity && parsed.unitPrice) {
        const q = Number(parsed.quantity)
        const p = Number(parsed.unitPrice)
        if (!isNaN(q) && !isNaN(p)) {
          parsed.totalAmount = Math.round(q * p * 100) / 100
        }
      }

      // Attach raw input
      parsed.rawInput = rawInput

      return parsed as unknown as BizRecord
    } catch (err) {
      logger.debug('BizParser error:', err instanceof Error ? err.message : String(err))
      return null
    }
  }
}
