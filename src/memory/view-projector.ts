/**
 * ViewProjector — applies MemoryView filters to bubble queries.
 * Acts as a composable middleware wrapping the BubbleAggregator.
 * Implements query-time row-level security (not data duplication).
 */

import type { Bubble, MemoryView, ViewFilter } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface ProjectionContext {
  view: MemoryView
  counterpartyId?: string  // for 'bound' counterparty filter
  asOfTimestamp?: number   // for temporal filtering
}

/**
 * Filter bubbles based on view constraints.
 * This is the core projection logic applied after aggregation scoring.
 */
export function applyViewFilter(bubbles: Bubble[], ctx: ProjectionContext): Bubble[] {
  const { filters } = ctx.view
  let result = bubbles

  // 1. Type filter
  if (filters.allowedTypes !== '*') {
    const allowed = new Set(filters.allowedTypes)
    result = result.filter(b => allowed.has(b.type))
  }

  // 2. Abstraction level filter
  result = result.filter(b => b.abstractionLevel <= filters.maxAbstractionLevel)

  // 3. Temporal validity filter (only return currently-valid knowledge)
  if (ctx.asOfTimestamp) {
    result = result.filter(b => {
      const validFrom = (b as BubbleWithTemporal).validFrom
      const validUntil = (b as BubbleWithTemporal).validUntil
      if (validFrom && validFrom > ctx.asOfTimestamp!) return false
      if (validUntil && validUntil < ctx.asOfTimestamp!) return false
      return true
    })
  } else {
    // Default: only active (not invalidated) knowledge
    result = result.filter(b => {
      const validUntil = (b as BubbleWithTemporal).validUntil
      return !validUntil
    })
  }

  // 4. Time window filter
  if (filters.timeWindow) {
    if (filters.timeWindow.since) {
      result = result.filter(b => b.createdAt >= filters.timeWindow!.since!)
    }
    if (filters.timeWindow.until) {
      result = result.filter(b => b.createdAt <= filters.timeWindow!.until!)
    }
  }

  // 5. Tag filter
  if (filters.tagFilter && filters.tagFilter.length > 0) {
    const requiredTags = new Set(filters.tagFilter)
    result = result.filter(b => b.tags.some(t => requiredTags.has(t)))
  }

  // 6. Counterparty filter (requires DB lookup for bound filtering)
  if (filters.counterpartyFilter === 'bound' && ctx.counterpartyId) {
    result = filterByCounterparty(result, ctx.counterpartyId)
  }

  return result
}

/**
 * Build SQL WHERE clause additions based on view filter.
 * Used by aggregator for efficient DB-level filtering.
 */
export function buildViewWhereClause(filters: ViewFilter, counterpartyId?: string): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = []
  const params: unknown[] = []

  // Type filter
  if (filters.allowedTypes !== '*') {
    const placeholders = filters.allowedTypes.map(() => '?').join(',')
    conditions.push(`type IN (${placeholders})`)
    params.push(...filters.allowedTypes)
  }

  // Abstraction level
  conditions.push('abstraction_level <= ?')
  params.push(filters.maxAbstractionLevel)

  // Default temporal: only active
  conditions.push('valid_until IS NULL')

  // Time window
  if (filters.timeWindow?.since) {
    conditions.push('created_at >= ?')
    params.push(filters.timeWindow.since)
  }
  if (filters.timeWindow?.until) {
    conditions.push('created_at <= ?')
    params.push(filters.timeWindow.until)
  }

  return { conditions, params }
}

/**
 * Check if a view allows a specific bubble type.
 */
export function viewAllowsType(view: MemoryView, bubbleType: string): boolean {
  if (view.filters.allowedTypes === '*') return true
  return view.filters.allowedTypes.includes(bubbleType)
}

/**
 * Check if a view is the admin (god) view.
 */
export function isAdminView(view: MemoryView): boolean {
  return view.rolePattern === 'admin' || view.filters.allowedTypes === '*'
}

// ── Private helpers ─────────────────────────────────────────────

// Extended Bubble type with temporal fields
interface BubbleWithTemporal extends Bubble {
  validFrom?: number
  validUntil?: number
}

/**
 * Filter bubbles that are linked to a specific counterparty.
 * Uses the bubble metadata or biz table references to determine ownership.
 */
function filterByCounterparty(bubbles: Bubble[], counterpartyId: string): Bubble[] {
  const db = getDatabase()

  // Get all bubble_ids that are linked to this counterparty's biz records
  const linkedBubbleIds = new Set<string>()

  // Check biz_purchases (supplier)
  const purchaseBubbles = db.prepare(
    'SELECT bubble_id FROM biz_purchases WHERE supplier_id = ? AND bubble_id IS NOT NULL'
  ).all(counterpartyId) as Array<{ bubble_id: string }>
  for (const r of purchaseBubbles) linkedBubbleIds.add(r.bubble_id)

  // Check biz_sales (customer)
  const saleBubbles = db.prepare(
    'SELECT bubble_id FROM biz_sales WHERE customer_id = ? AND bubble_id IS NOT NULL'
  ).all(counterpartyId) as Array<{ bubble_id: string }>
  for (const r of saleBubbles) linkedBubbleIds.add(r.bubble_id)

  // Check biz_logistics (carrier)
  const logBubbles = db.prepare(
    'SELECT bubble_id FROM biz_logistics WHERE carrier_id = ? AND bubble_id IS NOT NULL'
  ).all(counterpartyId) as Array<{ bubble_id: string }>
  for (const r of logBubbles) linkedBubbleIds.add(r.bubble_id)

  // Check biz_payments (counterparty)
  const payBubbles = db.prepare(
    'SELECT bubble_id FROM biz_payments WHERE counterparty_id = ? AND bubble_id IS NOT NULL'
  ).all(counterpartyId) as Array<{ bubble_id: string }>
  for (const r of payBubbles) linkedBubbleIds.add(r.bubble_id)

  // Also check metadata for counterpartyId
  return bubbles.filter(b => {
    if (linkedBubbleIds.has(b.id)) return true
    const meta = b.metadata as Record<string, unknown>
    if (meta?.counterpartyId === counterpartyId) return true
    if (meta?.supplierId === counterpartyId) return true
    if (meta?.customerId === counterpartyId) return true
    return false
  })
}
