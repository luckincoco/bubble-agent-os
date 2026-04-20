import type { Bubble, BubbleType } from '../shared/types.js'
import { createBubble, searchBubbles, findBubblesByType } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { calcSurprise } from './manager.js'
import { logger } from '../shared/logger.js'

interface NumericStats {
  sum: number
  min: number
  max: number
  count: number
}

/**
 * SurpriseDetector monitors incoming data (Excel imports, messages)
 * for anomalies and contradictions.
 *
 * Inspired by Cambrian-S spatial hypersensitivity:
 * the system passively detects "surprising" data without explicit queries.
 *
 * When anomalies are found, it creates 'event' type bubbles tagged with
 * 'surprise' to surface them in future searches.
 */
export class SurpriseDetector {

  /**
   * Scan an Excel import for numeric anomalies compared to historical data.
   * Fire-and-forget: caller should `.catch(logger.error)`.
   */
  async scanExcelImport(
    rows: Record<string, unknown>[],
    headers: string[],
    numericStats: Record<string, NumericStats>,
    sheetName: string,
    spaceId?: string,
  ): Promise<void> {
    const spaceIds = spaceId ? [spaceId] : undefined

    // Search for historical excel-summary bubbles of the same sheet
    const historicalSummaries = searchBubbles(`Excel数据总览: ${sheetName}`, 10, spaceIds)
      .filter(b => b.tags?.includes('excel-summary') && b.tags?.includes(sheetName))

    // Skip the most recent one (it's the one we just created)
    const previous = historicalSummaries.slice(1)
    if (previous.length === 0) {
      logger.debug('SurpriseDetector: no historical data for comparison')
      return
    }

    // Extract historical numeric stats from metadata
    const oldStats = previous[0].metadata?.numericStats as Record<string, NumericStats> | undefined
    if (!oldStats) {
      logger.debug('SurpriseDetector: no numeric stats in historical summary')
      return
    }

    const events: string[] = []

    // Detect numeric anomalies
    for (const [col, newSt] of Object.entries(numericStats)) {
      const oldSt = oldStats[col]
      if (!oldSt) continue

      // Max value spike: newMax > oldMax * 1.2
      if (newSt.max > oldSt.max * 1.2) {
        events.push(`${col} 最大值异常增长: ${oldSt.max} → ${newSt.max} (+${((newSt.max / oldSt.max - 1) * 100).toFixed(1)}%)`)
      }

      // Min value drop: newMin < oldMin * 0.8
      if (newSt.min < oldSt.min * 0.8 && oldSt.min > 0) {
        events.push(`${col} 最小值异常下降: ${oldSt.min} → ${newSt.min} (-${((1 - newSt.min / oldSt.min) * 100).toFixed(1)}%)`)
      }

      // Volume change: |newSum - oldSum| > oldSum * 0.3
      if (oldSt.sum > 0 && Math.abs(newSt.sum - oldSt.sum) > oldSt.sum * 0.3) {
        const direction = newSt.sum > oldSt.sum ? '增长' : '下降'
        const pct = ((Math.abs(newSt.sum - oldSt.sum) / oldSt.sum) * 100).toFixed(1)
        events.push(`${col} 总量${direction}: ${oldSt.sum} → ${newSt.sum} (${pct}%)`)
      }
    }

    // Detect new entities (text columns with new values)
    const ENTITY_COL_PATTERN = /供应商|客户|名称|公司|品名|产品|厂家|品牌|单位/
    const entityCols = headers.filter(h => ENTITY_COL_PATTERN.test(h))
    for (const col of entityCols) {
      const currentEntities = new Set<string>()
      for (const row of rows) {
        const v = row[col]
        if (v != null && v !== '') currentEntities.add(String(v).trim())
      }

      // Search for historical entities in this column
      const oldContent = previous[0].content || ''
      const newEntities: string[] = []
      for (const entity of currentEntities) {
        if (entity.length >= 2 && !oldContent.includes(entity)) {
          newEntities.push(entity)
        }
      }

      if (newEntities.length > 0) {
        events.push(`${col} 发现${newEntities.length}个新实体: ${newEntities.slice(0, 5).join('、')}${newEntities.length > 5 ? '...' : ''}`)
      }
    }

    if (events.length === 0) {
      logger.debug('SurpriseDetector: no anomalies detected in Excel import')
      return
    }

    // Create event bubble for each batch of anomalies
    const content = [
      `数据异常检测报告 - ${sheetName}`,
      `对比基准: ${new Date(previous[0].createdAt).toLocaleDateString('zh-CN')} 的数据`,
      '',
      ...events.map(e => `- ${e}`),
    ].join('\n')

    const eventBubble = createBubble({
      type: 'event' as BubbleType,
      title: `数据异常: ${sheetName} (${events.length}项)`,
      content,
      tags: ['surprise', sheetName, 'excel-anomaly'],
      source: 'system',
      confidence: 1.0,
      pinned: false,
      spaceId,
    })

    // Link to the current and previous summaries
    addLink(eventBubble.id, historicalSummaries[0].id, 'detected_in', 0.9, 'system')
    if (previous[0]) {
      addLink(eventBubble.id, previous[0].id, 'compared_with', 0.7, 'system')
    }

    logger.info(`SurpriseDetector: ${events.length} anomalies detected in "${sheetName}"`)
  }

  /**
   * Scan a user message for contradictions with existing knowledge.
   * Fire-and-forget: caller should `.catch(logger.error)`.
   */
  async scanMessage(text: string, spaceId?: string): Promise<void> {
    // Only scan messages with numeric content (e.g. "product X costs 500")
    const hasNumbers = /\d+\.?\d*/.test(text)
    if (!hasNumbers || text.length < 10) return

    const spaceIds = spaceId ? [spaceId] : undefined

    // Search for related existing bubbles
    const existing = searchBubbles(text, 10, spaceIds)
    if (existing.length === 0) return

    const { score, contradicts } = calcSurprise(text, existing)

    if (!contradicts || score < 0.8) return

    // Create event bubble for the contradiction
    const eventBubble = createBubble({
      type: 'event' as BubbleType,
      title: `信息矛盾检测`,
      content: `检测到新消息与已有记忆矛盾:\n\n新信息: ${text.slice(0, 200)}\n\n相关记忆: ${existing[0].content.slice(0, 200)}`,
      tags: ['surprise', 'contradiction', 'message-scan'],
      source: 'system',
      confidence: 1.0,
      pinned: false,
      spaceId,
    })

    addLink(eventBubble.id, existing[0].id, 'contradicts', 1.0, 'system')

    logger.info(`SurpriseDetector: contradiction detected in message`)

    // Check if accumulated contradictions create cognitive pressure → trigger "问"
    this.checkContradictionPressure(spaceId)
  }

  /**
   * Contradiction escalation — Bubble's "问" under cognitive pressure.
   *
   * When multiple contradictions accumulate without resolution,
   * Bubble can't act coherently. This isn't a scheduled question —
   * it's a survival response: "不问就会死" (don't ask = can't function).
   *
   * Creates a 'question' bubble only when real pressure exists:
   * ≥2 unresolved contradictions within 7 days on overlapping topics.
   */
  private checkContradictionPressure(spaceId?: string): void {
    const DAY_MS = 24 * 60 * 60 * 1000
    const now = Date.now()
    const spaceIds = spaceId ? [spaceId] : undefined

    // Find recent contradiction events
    const recentContradictions = searchBubbles('矛盾', 20, spaceIds)
      .filter(b =>
        b.type === 'event'
        && b.tags.includes('contradiction')
        && b.createdAt > now - 7 * DAY_MS,
      )

    // Only escalate when pressure is real: ≥2 unresolved contradictions
    if (recentContradictions.length < 2) return

    // Don't ask the same thing twice within 3 days
    const existingQuestions = searchBubbles('信息矛盾', 5, spaceIds)
      .filter(b =>
        b.type === 'question'
        && b.tags.includes('contradiction-pressure')
        && b.createdAt > now - 3 * DAY_MS,
      )
    if (existingQuestions.length > 0) return

    // Build question from accumulated contradictions
    const contradictionSummary = recentContradictions.slice(0, 3)
      .map(c => `- ${c.content.slice(0, 120)}`)
      .join('\n')

    const questionBubble = createBubble({
      type: 'question' as BubbleType,
      title: `${recentContradictions.length} 处信息矛盾待确认`,
      content: `最近检测到 ${recentContradictions.length} 处信息矛盾，无法自行判断哪个是当前有效的：\n\n${contradictionSummary}\n\n需要你确认哪些信息是最新的。`,
      tags: ['question', 'contradiction-pressure', 'auto-ask'],
      source: 'surprise-detector',
      confidence: 1.0,
      decayRate: 0.1,
      spaceId,
    })

    // Link question to the contradiction events it emerged from
    for (const c of recentContradictions.slice(0, 5)) {
      addLink(questionBubble.id, c.id, 'questions_about', 0.9, 'system')
    }

    logger.info(`SurpriseDetector: escalated ${recentContradictions.length} contradictions → question "${questionBubble.title}"`)
  }
}
