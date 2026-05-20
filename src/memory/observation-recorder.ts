import { createBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

/**
 * Auto Observation Capture
 *
 * Records significant tool call results and user actions as lightweight
 * "observation" type bubbles — no LLM extraction needed.
 *
 * Inspired by agentmemory's observe() pattern: capture raw events,
 * let later consolidation distill them into semantic memory.
 */

export interface ObservationEvent {
  /** Tool name or action type */
  action: string
  /** Structured arguments / context */
  args: Record<string, unknown>
  /** Raw result string */
  result: string
  /** Optional user ID for scoping */
  userId?: string
  /** Optional space ID for storage */
  spaceId?: string
}

/** Tools whose results are too transient to record */
const SKIP_TOOLS = new Set([
  'get_time',
  'get_weather',
])

/** Tools whose results are high-value and always worth recording */
const HIGH_VALUE_TOOLS = new Set([
  'query_excel',
  'cross_analyze',
  'web_search',
  'fetch_page',
  'export_excel',
  'clean_excel',
  'biz_query',
  'ext_query',
  'code_forge',
])

/** Minimum result length to consider recording (filters out trivial "OK" results) */
const MIN_RESULT_LENGTH = 30

export class ObservationRecorder {
  private recentObservations: Map<string, number> = new Map() // dedup key → timestamp

  /**
   * Evaluate and potentially record a tool call as an observation.
   * Returns the created bubble ID, or null if skipped.
   */
  record(event: ObservationEvent): string | null {
    const { action, args, result, spaceId } = event

    // Skip known-low-value tools
    if (SKIP_TOOLS.has(action)) return null

    // Skip empty or trivial results
    if (!result || result.length < MIN_RESULT_LENGTH) return null

    // Dedup: don't record the same tool+args combo within 5 minutes
    const dedupKey = `${action}:${JSON.stringify(args)}`
    const now = Date.now()
    const lastSeen = this.recentObservations.get(dedupKey)
    if (lastSeen && now - lastSeen < 5 * 60 * 1000) return null
    this.recentObservations.set(dedupKey, now)

    // Periodic cleanup of dedup map (keep last 200 entries)
    if (this.recentObservations.size > 200) {
      const entries = [...this.recentObservations.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 100)
      this.recentObservations = new Map(entries)
    }

    // Determine significance: high-value tools always pass, others need longer results
    const isHighValue = HIGH_VALUE_TOOLS.has(action)
    if (!isHighValue && result.length < 100) return null

    // Build observation title and content
    const title = buildTitle(action, args)
    const content = buildContent(action, args, result)

    // Compute decay rate: high-value observations decay slower
    const decayRate = isHighValue ? 0.08 : 0.15

    const bubble = createBubble({
      type: 'observation',
      title,
      content,
      tags: ['auto-observation', `tool:${action}`, 'assertion:fact'],
      source: 'tool_call',
      confidence: isHighValue ? 0.9 : 0.7,
      decayRate,
      spaceId,
      metadata: { assertionType: 'fact', assertionSource: 'tool_result' },
    })

    logger.debug(`Observation recorded: [${action}] ${title}`)
    return bubble.id
  }

  /**
   * Record multiple tool calls from a single conversation turn,
   * linking them together as co-occurring observations.
   */
  recordBatch(events: ObservationEvent[]): string[] {
    const ids: string[] = []
    for (const event of events) {
      const id = this.record(event)
      if (id) ids.push(id)
    }

    // Link co-occurring observations
    if (ids.length > 1) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          addLink(ids[i], ids[j], 'co_observed', 0.6, 'system')
        }
      }
    }

    return ids
  }
}

function buildTitle(action: string, args: Record<string, unknown>): string {
  // Extract the most descriptive arg for the title
  const query = args.query || args.keyword || args.question || args.filename || args.url
  if (query) {
    const queryStr = String(query).slice(0, 40)
    return `${action}: ${queryStr}`
  }
  return `${action} 调用结果`
}

function buildContent(action: string, args: Record<string, unknown>, result: string): string {
  // Cap result at 500 chars for observation storage (full data lives elsewhere)
  const cappedResult = result.length > 500 ? result.slice(0, 500) + '…' : result
  const argsStr = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)}`)
    .join(', ')

  return `[${action}] ${argsStr}\n结果: ${cappedResult}`
}
