/**
 * Symmetric perspective mirror templates (对称视角镜像).
 * Phase Zero infrastructure — maps each business event to the counterparty's perspective.
 * Used by the future "external spokesperson" (对外代言人) to generate counterparty-facing messages.
 */

export interface MirrorTemplate {
  eventType: string
  ourPerspective: string
  theirPerspective: string
  ourVerb: string
  theirVerb: string
  templateOur: string
  templateTheir: string
  dataFields: string[]
}

export const MIRROR_TEMPLATES: Record<string, MirrorTemplate> = {
  purchase: {
    eventType: 'purchase',
    ourPerspective: '我方采购',
    theirPerspective: '对方销售',
    ourVerb: '向{counterparty}采购了',
    theirVerb: '向我方销售了',
    templateOur: '{date}，我方向{counterparty}采购了{product} {tonnage}吨，单价{unitPrice}元/吨，合计{totalAmount}元',
    templateTheir: '{date}，贵方向我方销售了{product} {tonnage}吨，单价{unitPrice}元/吨，合计{totalAmount}元',
    dataFields: ['date', 'counterparty', 'product', 'tonnage', 'unitPrice', 'totalAmount'],
  },
  sale: {
    eventType: 'sale',
    ourPerspective: '我方销售',
    theirPerspective: '对方采购',
    ourVerb: '向{counterparty}销售了',
    theirVerb: '向我方采购了',
    templateOur: '{date}，我方向{counterparty}销售了{product} {tonnage}吨，单价{unitPrice}元/吨，合计{totalAmount}元',
    templateTheir: '{date}，贵方向我方采购了{product} {tonnage}吨，单价{unitPrice}元/吨，合计{totalAmount}元',
    dataFields: ['date', 'counterparty', 'product', 'tonnage', 'unitPrice', 'totalAmount'],
  },
  payment_in: {
    eventType: 'payment_in',
    ourPerspective: '我方收款',
    theirPerspective: '对方付款',
    ourVerb: '收到{counterparty}付款',
    theirVerb: '向我方支付了',
    templateOur: '{date}，我方收到{counterparty}付款{amount}元',
    templateTheir: '{date}，贵方向我方支付了{amount}元',
    dataFields: ['date', 'counterparty', 'amount'],
  },
  payment_out: {
    eventType: 'payment_out',
    ourPerspective: '我方付款',
    theirPerspective: '对方收款',
    ourVerb: '向{counterparty}支付了',
    theirVerb: '收到我方付款',
    templateOur: '{date}，我方向{counterparty}支付了{amount}元',
    templateTheir: '{date}，贵方收到我方付款{amount}元',
    dataFields: ['date', 'counterparty', 'amount'],
  },
  logistics: {
    eventType: 'logistics',
    ourPerspective: '我方发货',
    theirPerspective: '对方收货',
    ourVerb: '向{counterparty}发货',
    theirVerb: '收到我方发货',
    templateOur: '{date}，我方向{counterparty}发货{tonnage}吨，运至{destination}',
    templateTheir: '{date}，贵方收到我方发货{tonnage}吨，运至{destination}',
    dataFields: ['date', 'counterparty', 'tonnage', 'destination'],
  },
  invoice_out: {
    eventType: 'invoice_out',
    ourPerspective: '我方开票',
    theirPerspective: '对方收票',
    ourVerb: '向{counterparty}开具发票',
    theirVerb: '收到我方发票',
    templateOur: '{date}，我方向{counterparty}开具发票，金额{amount}元',
    templateTheir: '{date}，贵方收到我方发票，金额{amount}元',
    dataFields: ['date', 'counterparty', 'amount'],
  },
  invoice_in: {
    eventType: 'invoice_in',
    ourPerspective: '我方收票',
    theirPerspective: '对方开票',
    ourVerb: '收到{counterparty}发票',
    theirVerb: '向我方开具了发票',
    templateOur: '{date}，我方收到{counterparty}发票，金额{amount}元',
    templateTheir: '{date}，贵方向我方开具了发票，金额{amount}元',
    dataFields: ['date', 'counterparty', 'amount'],
  },
}

const MIRROR_EVENT_MAP: Record<string, string> = {
  purchase: 'sale',
  sale: 'purchase',
  payment_in: 'payment_out',
  payment_out: 'payment_in',
  invoice_in: 'invoice_out',
  invoice_out: 'invoice_in',
  logistics: 'logistics',
}

/** Render an event description from the specified perspective. */
export function renderMirror(
  eventType: string,
  data: Record<string, string | number>,
  perspective: 'our' | 'their',
): string {
  const template = MIRROR_TEMPLATES[eventType]
  if (!template) return `未知事件类型: ${eventType}`

  const raw = perspective === 'our' ? template.templateOur : template.templateTheir
  return raw.replace(/\{(\w+)\}/g, (_, key) => {
    const val = data[key]
    return val != null ? String(val) : ''
  })
}

/** Get the mirror event type (what the counterparty sees as their event type). */
export function getMirrorEventType(eventType: string): string {
  return MIRROR_EVENT_MAP[eventType] ?? eventType
}
