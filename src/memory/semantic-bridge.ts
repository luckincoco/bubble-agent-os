import { searchBubbles } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { updateBubble } from '../bubble/model.js'
import { logger } from '../shared/logger.js'

/** Patterns matching entity/name columns in Chinese business data */
const ENTITY_COL_PATTERN = /供应商|客户|名称|公司|品名|产品|厂家|品牌|单位|商家|店铺|门店|收货人|发货人/

/**
 * SemanticBridge automatically links newly imported Excel data
 * to existing bubbles in the memory network.
 *
 * When an Excel is imported, it scans entity columns (supplier, product, etc.)
 * and searches for matching bubbles, creating 'related' links at weight 0.7.
 */
export class SemanticBridge {

  /**
   * Bridge Excel import data to existing memory network.
   * Fire-and-forget: caller should `.catch(logger.error)`.
   */
  async bridgeExcelImport(
    newBubbleIds: string[],
    rows: Record<string, unknown>[],
    headers: string[],
    summaryId: string,
    spaceId?: string,
  ): Promise<void> {
    // Step 1: Identify entity columns
    const entityCols = headers.filter(h => ENTITY_COL_PATTERN.test(h))
    if (entityCols.length === 0) {
      logger.debug('SemanticBridge: no entity columns found')
      return
    }

    // Step 2: Collect unique entity values (top 50 by frequency)
    const freq = new Map<string, number>()
    for (const row of rows) {
      for (const col of entityCols) {
        const val = row[col]
        if (val != null && val !== '' && typeof val === 'string') {
          const trimmed = val.trim()
          if (trimmed.length >= 2) {
            freq.set(trimmed, (freq.get(trimmed) || 0) + 1)
          }
        } else if (val != null && val !== '') {
          const str = String(val).trim()
          if (str.length >= 2) {
            freq.set(str, (freq.get(str) || 0) + 1)
          }
        }
      }
    }

    // Sort by frequency, take top 50
    const entities = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([name]) => name)

    if (entities.length === 0) {
      logger.debug('SemanticBridge: no entity values found')
      return
    }

    // Step 3: Search and link
    const newIdSet = new Set(newBubbleIds)
    let linkedCount = 0
    const spaceIds = spaceId ? [spaceId] : undefined

    for (const entity of entities) {
      const matches = searchBubbles(entity, 5, spaceIds)
      // Exclude bubbles from this import
      const external = matches.filter(b => !newIdSet.has(b.id))

      for (const match of external) {
        // Link from each new bubble that contains this entity
        for (const newId of newBubbleIds) {
          addLink(newId, match.id, 'related', 0.7, 'inferred')
          linkedCount++
        }
        // Also link summary to matched bubble
        addLink(summaryId, match.id, 'related', 0.7, 'inferred')
        linkedCount++
        break  // Only link to best match per entity
      }
    }

    // Step 4: Update summary bubble with linking stats
    if (linkedCount > 0) {
      const note = `\n\n[语义桥] 自动关联: ${entities.length}个实体检索, 产生${linkedCount}条关联链接`
      try {
        // Append to summary content
        const existing = searchBubbles(`Excel数据总览`, 1, spaceIds)
        const summary = existing.find(b => b.id === summaryId)
        if (summary) {
          updateBubble(summaryId, { content: summary.content + note })
        }
      } catch {
        // Non-critical, just log
      }
    }

    logger.info(`SemanticBridge: ${entities.length} entities scanned, ${linkedCount} links created`)
  }
}
