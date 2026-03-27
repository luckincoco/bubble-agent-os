/**
 * Rule-based business entry intent detector.
 * Zero LLM calls — pure regex matching.
 *
 * Strategy: require BOTH an action verb AND a domain keyword + numeric value
 * to avoid false positives on casual conversation.
 */

import type { BizType } from './schema.js'

export interface DetectResult {
  detected: boolean
  bizType?: BizType
}

// ── Steel trade domain keywords ───────────────────────────────────────
const STEEL_KEYWORDS = /钢[材筋]?|螺纹|盘螺|高线|线材|圆钢|角钢|槽钢|工字钢|H型钢|焊管|无缝管|镀锌管|方管|扁钢|钢板|钢卷|型钢|建材|水泥|砂石|混凝土|商砼/

// ── Numeric patterns ──────────────────────────────────────────────────
const HAS_NUMBER = /\d+\.?\d*/
const QUANTITY_UNIT = /\d+\.?\d*\s*(?:吨|t|T|支|根|件|米|m|公斤|kg|KG|方|立方|车|捆|包|卷|张|块)/
const MONEY_AMOUNT = /\d+\.?\d*\s*(?:万|元|块钱?)?/

// ── Action verbs per biz type ─────────────────────────────────────────
const PROCUREMENT_VERBS = /进了?|采购了?|购入了?|买了?|拿了?|进货|订了?|订购|到了?\s*\d+/
const SALES_VERBS = /卖了?|出了?|发了?|销售了?|送了?|出货|出库|发货/
const PAYMENT_VERBS = /收到?了?|付了?|打了?|转了?|汇了?|回了?|回款|付款|收款|打款|转账|结了?|结算/
const LOGISTICS_VERBS = /发车|装车|拉了?|运了?|到货|物流|运费|吊费|吊装|提货|卸货|配送/

// ── Price indicator ───────────────────────────────────────────────────
const PRICE_INDICATOR = /单价|每吨|元\/吨|\/吨|一吨|块钱?一/

/**
 * Detect whether user input is a business entry.
 * Returns the detected biz type or { detected: false }.
 */
export function detectBizIntent(text: string): DetectResult {
  const trimmed = text.trim()

  // Too short or too long → unlikely a biz entry
  if (trimmed.length < 6 || trimmed.length > 500) return { detected: false }

  // Must contain at least one number
  if (!HAS_NUMBER.test(trimmed)) return { detected: false }

  // ── Procurement ─────────────────────────────────────────────────
  if (PROCUREMENT_VERBS.test(trimmed)) {
    // Must have quantity unit OR (steel keyword + number) OR price indicator
    if (
      QUANTITY_UNIT.test(trimmed) ||
      (STEEL_KEYWORDS.test(trimmed) && HAS_NUMBER.test(trimmed)) ||
      PRICE_INDICATOR.test(trimmed)
    ) {
      return { detected: true, bizType: 'procurement' }
    }
  }

  // ── Sales ───────────────────────────────────────────────────────
  if (SALES_VERBS.test(trimmed)) {
    if (
      QUANTITY_UNIT.test(trimmed) ||
      (STEEL_KEYWORDS.test(trimmed) && HAS_NUMBER.test(trimmed)) ||
      PRICE_INDICATOR.test(trimmed)
    ) {
      return { detected: true, bizType: 'sales' }
    }
  }

  // ── Payment ─────────────────────────────────────────────────────
  if (PAYMENT_VERBS.test(trimmed)) {
    if (MONEY_AMOUNT.test(trimmed)) {
      return { detected: true, bizType: 'payment' }
    }
  }

  // ── Logistics ───────────────────────────────────────────────────
  if (LOGISTICS_VERBS.test(trimmed)) {
    if (QUANTITY_UNIT.test(trimmed) || MONEY_AMOUNT.test(trimmed) || HAS_NUMBER.test(trimmed)) {
      return { detected: true, bizType: 'logistics' }
    }
  }

  return { detected: false }
}
