/**
 * Store a TeachRecord as a pinned entity bubble.
 * Handles conflict resolution (expire old cards) and forget operations.
 */

import type { EmbeddingProvider } from '../../shared/types.js'
import type { TeachRecord } from './parser.js'
import type { TeachAction } from './detector.js'
import { createBubble, updateBubble, searchBubbles } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { logger } from '../../shared/logger.js'

export interface TeachStoreResult {
  bubbleId: string
  action: TeachAction
  expired: string[]
  confirmation: string
}

/** Map entityType to Chinese tag */
const ENTITY_TYPE_LABEL: Record<string, string> = {
  supplier: '供应商', customer: '客户', project: '项目',
  product: '产品', person: '人物', rule: '规则', other: '知识',
}

export class TeachStore {
  private embeddings: EmbeddingProvider | null = null

  setEmbeddingProvider(provider: EmbeddingProvider) {
    this.embeddings = provider
  }

  async store(record: TeachRecord, spaceId?: string): Promise<TeachStoreResult> {
    if (record.action === 'forget') {
      return this.handleForget(record, spaceId)
    }
    return this.handleRememberOrUpdate(record, spaceId)
  }

  private async handleRememberOrUpdate(record: TeachRecord, spaceId?: string): Promise<TeachStoreResult> {
    const expired: string[] = []

    // ── Find conflicting bubbles ──────────────────────────────────
    const spaceIds = spaceId ? [spaceId] : undefined
    const candidates = searchBubbles(record.entityName, 20, spaceIds)

    for (const b of candidates) {
      if (b.type !== 'entity') continue
      if (!b.pinned) continue
      const meta = b.metadata as Record<string, unknown>
      if (meta.source !== 'teach') continue
      if (!b.tags.includes(record.entityName)) continue

      // For 'update' with specific attribute, only expire matching attribute
      if (record.action === 'update' && record.attribute) {
        if (meta.attribute !== record.attribute) continue
      }

      // Expire old card: set pinned=false to let it naturally decay
      updateBubble(b.id, { pinned: false })
      expired.push(b.id)
      logger.info(`TeachStore: expired old knowledge card ${b.id} (${b.title})`)
    }

    // ── Generate embedding ────────────────────────────────────────
    let embedding: number[] | undefined
    if (this.embeddings) {
      try {
        embedding = await this.embeddings.embed(record.factText)
      } catch {
        logger.debug('TeachStore: embedding generation failed, storing without vector')
      }
    }

    // ── Build tags ────────────────────────────────────────────────
    const typeLabel = ENTITY_TYPE_LABEL[record.entityType] || '知识'
    const tags = ['知识', '教学', typeLabel, record.entityName, ...record.tags]
    // Deduplicate
    const uniqueTags = [...new Set(tags)]

    // ── Build title ───────────────────────────────────────────────
    const title = record.attribute
      ? `知识: ${record.entityName} - ${record.attribute}`
      : `知识: ${record.entityName}`

    // ── Create bubble ─────────────────────────────────────────────
    const bubble = createBubble({
      type: 'entity',
      title,
      content: record.factText,
      metadata: {
        source: 'teach',
        action: record.action,
        entityType: record.entityType,
        entityName: record.entityName,
        attribute: record.attribute,
        value: record.value,
        rawInput: record.rawInput,
        taughtAt: Date.now(),
      },
      tags: uniqueTags,
      embedding,
      source: 'teach',
      confidence: 1.0,
      decayRate: 0.01,
      pinned: true,
      spaceId,
      abstractionLevel: 1,
    })

    // ── Auto-link to related bubbles ──────────────────────────────
    this.autoLink(bubble.id, record.entityName, spaceId)

    logger.info(`TeachStore: created knowledge card ${bubble.id} — ${title}`)

    // ── Build confirmation ────────────────────────────────────────
    let confirmation: string
    switch (record.action) {
      case 'remember':
        confirmation = `已记住：${record.factText}`
        break
      case 'note':
        confirmation = `已标记注意：${record.factText}`
        break
      case 'update':
        confirmation = `已更新：${record.factText}`
        if (expired.length > 0) {
          confirmation += `（已替换 ${expired.length} 条旧记录）`
        }
        break
      default:
        confirmation = `已记录：${record.factText}`
    }

    return { bubbleId: bubble.id, action: record.action, expired, confirmation }
  }

  private async handleForget(record: TeachRecord, spaceId?: string): Promise<TeachStoreResult> {
    const spaceIds = spaceId ? [spaceId] : undefined
    const candidates = searchBubbles(record.entityName, 20, spaceIds)
    const expired: string[] = []

    for (const b of candidates) {
      if (b.type !== 'entity') continue
      if (!b.pinned) continue
      const meta = b.metadata as Record<string, unknown>
      if (meta.source !== 'teach') continue
      if (!b.tags.includes(record.entityName)) continue

      // If attribute specified, only forget matching attribute
      if (record.attribute) {
        if (meta.attribute !== record.attribute) continue
      }

      // Accelerate decay: set pinned=false + high decayRate
      updateBubble(b.id, { pinned: false, decayRate: 0.5 })
      expired.push(b.id)
      logger.info(`TeachStore: forgot knowledge card ${b.id} (${b.title})`)
    }

    const confirmation = expired.length > 0
      ? `已遗忘：关于「${record.entityName}」的 ${expired.length} 条知识已标记过期`
      : `没有找到关于「${record.entityName}」的知识记录，无需遗忘`

    return {
      bubbleId: '',
      action: 'forget',
      expired,
      confirmation,
    }
  }

  private autoLink(bubbleId: string, entityName: string, spaceId?: string): void {
    try {
      const spaceIds = spaceId ? [spaceId] : undefined
      const related = searchBubbles(entityName, 15, spaceIds)
      let linked = 0

      for (const b of related) {
        if (b.id === bubbleId) continue
        if (!b.tags.includes(entityName)) continue
        addLink(bubbleId, b.id, 'same_entity', 0.9, 'system')
        linked++
        if (linked >= 10) break // Limit link count
      }

      if (linked > 0) {
        logger.debug(`TeachStore: linked ${linked} related bubbles for "${entityName}"`)
      }
    } catch (err) {
      logger.debug('TeachStore autoLink error:', err instanceof Error ? err.message : String(err))
    }
  }
}
