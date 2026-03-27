/**
 * Store a BizRecord as a Bubble with auto-linking to related entities.
 */

import type { EmbeddingProvider } from '../../shared/types.js'
import type { BizRecord, BizType } from './schema.js'
import { BIZ_TYPE_LABELS } from './schema.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { logger } from '../../shared/logger.js'
import {
  fuzzyFindCounterparty, fuzzyFindProduct, findProjectByName,
  createCounterparty, createProduct, createProject,
  createPurchase, createSale, createLogistics, createPayment,
  getLastPurchasePrice,
} from './structured-store.js'

export interface StoreResult {
  bubbleId: string
  structuredId?: string
  duplicate: boolean
  confirmation: string
}

/** Format a number with thousands separator */
function fmt(n: number): string {
  return n.toLocaleString('zh-CN')
}

/** Get the counterparty name from any biz record */
function getCounterparty(record: BizRecord): string | undefined {
  switch (record.bizType) {
    case 'procurement': return record.supplier
    case 'sales': return record.customer
    case 'payment': return record.counterparty
    case 'logistics': return record.carrier
  }
}

/** Build a concise title for the bubble */
function buildTitle(record: BizRecord): string {
  const label = BIZ_TYPE_LABELS[record.bizType]
  switch (record.bizType) {
    case 'procurement': {
      const spec = record.spec ? record.spec : ''
      return `${label} ${record.supplier} ${record.product}${spec} ${fmt(record.quantity)}吨 ¥${fmt(record.unitPrice)}/吨`
    }
    case 'sales': {
      const spec = record.spec ? record.spec : ''
      return `${label} ${record.customer} ${record.product}${spec} ${fmt(record.quantity)}吨 ¥${fmt(record.unitPrice)}/吨`
    }
    case 'payment': {
      return `${label} ${record.direction}款 ${record.counterparty} ¥${fmt(record.amount)}`
    }
    case 'logistics': {
      return `${label} ${record.destination} ${fmt(record.tonnage)}吨${record.freight ? ' ¥' + fmt(record.freight) : ''}`
    }
  }
}

/** Build human-readable content */
function buildContent(record: BizRecord): string {
  const parts: string[] = []
  switch (record.bizType) {
    case 'procurement': {
      const spec = record.spec ? `(${record.spec})` : ''
      parts.push(`${record.date} 从${record.supplier}采购${record.product}${spec} ${fmt(record.quantity)}吨`)
      parts.push(`单价${fmt(record.unitPrice)}元/吨`)
      if (record.totalAmount) parts.push(`合计${fmt(record.totalAmount)}元`)
      if (record.project) parts.push(`项目: ${record.project}`)
      if (record.invoiceStatus) parts.push(`发票: ${record.invoiceStatus}`)
      if (record.paymentStatus) parts.push(`付款: ${record.paymentStatus}`)
      break
    }
    case 'sales': {
      const spec = record.spec ? `(${record.spec})` : ''
      parts.push(`${record.date} 销售给${record.customer} ${record.product}${spec} ${fmt(record.quantity)}吨`)
      parts.push(`单价${fmt(record.unitPrice)}元/吨`)
      if (record.totalAmount) parts.push(`合计${fmt(record.totalAmount)}元`)
      if (record.project) parts.push(`项目: ${record.project}`)
      if (record.invoiceStatus) parts.push(`发票: ${record.invoiceStatus}`)
      if (record.collectionStatus) parts.push(`收款: ${record.collectionStatus}`)
      break
    }
    case 'payment': {
      parts.push(`${record.date} ${record.direction}款 ${record.counterparty} ${fmt(record.amount)}元`)
      if (record.method) parts.push(`方式: ${record.method}`)
      if (record.project) parts.push(`项目: ${record.project}`)
      break
    }
    case 'logistics': {
      parts.push(`${record.date} 物流发往${record.destination} ${fmt(record.tonnage)}吨`)
      if (record.carrier) parts.push(`承运: ${record.carrier}`)
      if (record.freight) parts.push(`运费: ${fmt(record.freight)}元`)
      if (record.liftingFee) parts.push(`吊费: ${fmt(record.liftingFee)}元`)
      if (record.driver) parts.push(`司机: ${record.driver}`)
      if (record.licensePlate) parts.push(`车牌: ${record.licensePlate}`)
      if (record.project) parts.push(`项目: ${record.project}`)
      break
    }
  }
  return parts.join('，')
}

/** Build tags for searchability */
function buildTags(record: BizRecord): string[] {
  const tags: string[] = ['biz', `biz-${record.bizType}`]
  const yearMonth = record.date.slice(0, 7) // YYYY-MM
  tags.push(yearMonth)

  const counterparty = getCounterparty(record)
  if (counterparty) tags.push(counterparty)

  if ('product' in record && record.product) tags.push(record.product)
  if (record.project) tags.push(record.project)
  if ('destination' in record && record.destination) tags.push(record.destination)

  return tags
}

/** Build a user-facing confirmation message */
function buildConfirmation(record: BizRecord): string {
  const label = BIZ_TYPE_LABELS[record.bizType]
  const lines: string[] = [`已记录${label}`]

  switch (record.bizType) {
    case 'procurement': {
      lines.push(`${record.date}`)
      lines.push(`${record.supplier}`)
      const spec = record.spec ? ` ${record.spec}` : ''
      lines.push(`${record.product}${spec} x ${fmt(record.quantity)}吨`)
      lines.push(`单价 ¥${fmt(record.unitPrice)}/吨`)
      if (record.totalAmount) lines.push(`合计 ¥${fmt(record.totalAmount)}`)
      break
    }
    case 'sales': {
      lines.push(`${record.date}`)
      lines.push(`${record.customer}`)
      const spec = record.spec ? ` ${record.spec}` : ''
      lines.push(`${record.product}${spec} x ${fmt(record.quantity)}吨`)
      lines.push(`单价 ¥${fmt(record.unitPrice)}/吨`)
      if (record.totalAmount) lines.push(`合计 ¥${fmt(record.totalAmount)}`)
      break
    }
    case 'payment': {
      lines.push(`${record.date}`)
      lines.push(`${record.direction}款 ${record.counterparty}`)
      lines.push(`金额 ¥${fmt(record.amount)}`)
      if (record.method) lines.push(`方式: ${record.method}`)
      break
    }
    case 'logistics': {
      lines.push(`${record.date}`)
      lines.push(`发往 ${record.destination} ${fmt(record.tonnage)}吨`)
      if (record.carrier) lines.push(`承运: ${record.carrier}`)
      if (record.freight) lines.push(`运费 ¥${fmt(record.freight)}`)
      break
    }
  }

  if (record.project) lines.push(`项目: ${record.project}`)
  return lines.join('\n')
}

/** Get main numeric value for duplicate detection */
function getMainAmount(record: BizRecord): number {
  switch (record.bizType) {
    case 'procurement': return record.totalAmount ?? record.quantity * record.unitPrice
    case 'sales': return record.totalAmount ?? record.quantity * record.unitPrice
    case 'payment': return record.amount
    case 'logistics': return record.tonnage
  }
}

export class BizStore {
  private embeddings: EmbeddingProvider | null = null

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
  }

  async store(record: BizRecord, spaceId?: string): Promise<StoreResult> {
    const counterparty = getCounterparty(record) ?? ''
    const mainAmount = getMainAmount(record)

    // ── Duplicate detection ───────────────────────────────────────
    // Same date + same counterparty + same amount + within 5 minutes
    const existing = searchBubbles(`${counterparty} ${record.date}`, 10)
    const now = Date.now()
    const fiveMinutes = 5 * 60 * 1000

    for (const b of existing) {
      if (!b.tags.includes('biz')) continue
      if (!b.tags.includes(`biz-${record.bizType}`)) continue
      if (now - b.createdAt > fiveMinutes) continue

      const meta = b.metadata as Record<string, unknown>
      if (meta.date === record.date && getCounterparty(meta as any) === counterparty) {
        const existingAmount = getMainAmount(meta as any as BizRecord)
        if (Math.abs(existingAmount - mainAmount) < 0.01) {
          return {
            bubbleId: b.id,
            duplicate: true,
            confirmation: `该笔${BIZ_TYPE_LABELS[record.bizType]}记录疑似重复（${counterparty} ${record.date} ¥${fmt(mainAmount)}），未重复录入。`,
          }
        }
      }
    }

    // ── Generate embedding ────────────────────────────────────────
    const content = buildContent(record)
    let embedding: number[] | undefined
    if (this.embeddings) {
      try {
        embedding = await this.embeddings.embed(content)
      } catch {
        logger.debug('BizStore: embedding generation failed, storing without vector')
      }
    }

    // ── Create bubble ─────────────────────────────────────────────
    const bubble = createBubble({
      type: 'event',
      title: buildTitle(record),
      content,
      metadata: record as unknown as Record<string, unknown>,
      tags: buildTags(record),
      embedding,
      source: 'biz-entry',
      confidence: 1.0,
      decayRate: 0.01,
      pinned: false,
      spaceId,
      abstractionLevel: 0,
    })

    // ── Dual-write to structured biz_* table ──────────────────────
    let structuredId: string | undefined
    try {
      structuredId = this.writeStructured(record, bubble.id)
    } catch (err) {
      logger.warn('BizStore: structured write failed (bubble saved OK):', err instanceof Error ? err.message : String(err))
    }

    // ── Auto-link to related bubbles ──────────────────────────────
    this.autoLink(bubble.id, record, spaceId)

    logger.info(`BizStore: created ${record.bizType} bubble ${bubble.id}${structuredId ? ` + biz ${structuredId}` : ''} — ${buildTitle(record)}`)

    return {
      bubbleId: bubble.id,
      structuredId,
      duplicate: false,
      confirmation: buildConfirmation(record),
    }
  }

  // ── Resolve name → ID helpers (auto-create if missing) ─────────

  private resolveCounterpartyId(name: string, type: 'supplier' | 'customer' | 'logistics' | 'both'): string {
    const found = fuzzyFindCounterparty(name, type)
    if (found) return found.id
    const created = createCounterparty({ name, type })
    logger.info(`BizStore: auto-created ${type} counterparty "${name}" → ${created.id}`)
    return created.id
  }

  private resolveProductId(name: string, spec?: string): string {
    const query = spec ? `${name} ${spec}` : name
    const found = fuzzyFindProduct(query)
    if (found) return found.id
    const code = spec ? `${name}-${spec}` : name
    const created = createProduct({
      code, brand: '', name, spec: spec ?? '',
      category: '螺纹钢', measureType: '理计',
    })
    logger.info(`BizStore: auto-created product "${code}" → ${created.id}`)
    return created.id
  }

  private resolveProjectId(name: string): string {
    const found = findProjectByName(name)
    if (found) return found.id
    const created = createProject({ name, status: 'active' })
    logger.info(`BizStore: auto-created project "${name}" → ${created.id}`)
    return created.id
  }

  // ── Write to structured biz_* table ───────────────────────────

  private writeStructured(record: BizRecord, bubbleId: string): string | undefined {
    const projectId = record.project ? this.resolveProjectId(record.project) : undefined

    switch (record.bizType) {
      case 'procurement': {
        const supplierId = this.resolveCounterpartyId(record.supplier, 'supplier')
        const productId = this.resolveProductId(record.product, record.spec)
        const totalAmount = record.totalAmount ?? record.quantity * record.unitPrice
        return createPurchase({
          date: record.date, supplierId, productId,
          tonnage: record.quantity, unitPrice: record.unitPrice, totalAmount,
          projectId, invoiceStatus: record.invoiceStatus ?? 'none',
          paymentStatus: record.paymentStatus ?? 'unpaid',
          bubbleId, rawInput: record.rawInput,
        }).id
      }
      case 'sales': {
        const customerId = this.resolveCounterpartyId(record.customer, 'customer')
        const productId = this.resolveProductId(record.product, record.spec)
        const totalAmount = record.totalAmount ?? record.quantity * record.unitPrice
        const costPrice = getLastPurchasePrice(productId)
        const costAmount = costPrice != null ? Math.round(record.quantity * costPrice * 100) / 100 : undefined
        const profit = costAmount != null ? Math.round((totalAmount - costAmount) * 100) / 100 : undefined
        return createSale({
          date: record.date, customerId, productId,
          tonnage: record.quantity, unitPrice: record.unitPrice, totalAmount,
          costPrice, costAmount, profit,
          projectId, invoiceStatus: record.invoiceStatus ?? 'none',
          collectionStatus: record.collectionStatus ?? 'uncollected',
          bubbleId, rawInput: record.rawInput,
        }).id
      }
      case 'payment': {
        const counterpartyId = this.resolveCounterpartyId(record.counterparty, 'both')
        const direction: 'in' | 'out' = record.direction === '收' ? 'in' : 'out'
        return createPayment({
          date: record.date, direction, counterpartyId, projectId,
          amount: record.amount, method: record.method,
          bubbleId, rawInput: record.rawInput,
        }).id
      }
      case 'logistics': {
        const carrierId = record.carrier ? this.resolveCounterpartyId(record.carrier, 'logistics') : undefined
        return createLogistics({
          date: record.date, carrierId, projectId,
          destination: record.destination, tonnage: record.tonnage,
          freight: record.freight, liftingFee: record.liftingFee,
          bubbleId, rawInput: record.rawInput,
        }).id
      }
    }
  }

  // ── Auto-link bubbles ─────────────────────────────────────────

  private autoLink(bubbleId: string, record: BizRecord, spaceId?: string): void {
    try {
      const counterparty = getCounterparty(record)

      if (counterparty) {
        const related = searchBubbles(counterparty, 15, spaceId ? [spaceId] : undefined)
        for (const b of related) {
          if (b.id === bubbleId) continue
          if (!b.tags.includes('biz')) continue
          const meta = b.metadata as Record<string, unknown>
          if (getCounterparty(meta as any) === counterparty) {
            addLink(bubbleId, b.id, 'same_counterparty', 0.8, 'system')
          }
        }
      }

      if (record.project) {
        const related = searchBubbles(record.project, 10, spaceId ? [spaceId] : undefined)
        for (const b of related) {
          if (b.id === bubbleId) continue
          if (!b.tags.includes('biz')) continue
          const meta = b.metadata as Record<string, unknown>
          if (meta.project === record.project) {
            addLink(bubbleId, b.id, 'same_project', 0.8, 'system')
          }
        }
      }
    } catch (err) {
      logger.debug('BizStore autoLink error:', err instanceof Error ? err.message : String(err))
    }
  }
}
