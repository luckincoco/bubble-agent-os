/**
 * ViewResolver — given a UserContext or ExternalUserContext,
 * resolves the applicable MemoryView for data projection.
 */

import type { UserContext, ExternalUserContext, MemoryView } from '../shared/types.js'
import { isExternalContext } from '../shared/types.js'
import { resolveEffectiveView } from './view-registry.js'
import type { ProjectionContext } from './view-projector.js'

/**
 * Resolve the full projection context from a user context.
 * External users get a restricted view; admin gets the god view.
 */
export function resolveProjectionContext(ctx: UserContext, opts?: { asOfTimestamp?: number }): ProjectionContext | null {
  let view: MemoryView | null = null
  let counterpartyId: string | undefined

  if (isExternalContext(ctx)) {
    const extCtx = ctx as ExternalUserContext
    // External user: resolve by counterparty type (supplier/customer/logistics)
    view = resolveEffectiveView('external_contact', extCtx.platformUserId, extCtx.counterpartyType)
    counterpartyId = extCtx.counterpartyId
  } else {
    // Internal user: resolve by user role or explicit binding
    view = resolveEffectiveView('user', ctx.userId, 'admin')
  }

  if (!view) return null

  return {
    view,
    counterpartyId,
    asOfTimestamp: opts?.asOfTimestamp,
  }
}

/**
 * Quick check: does this context have admin-level access?
 */
export function hasAdminAccess(ctx: UserContext): boolean {
  if (isExternalContext(ctx)) return false
  // For now, all internal users have admin access
  // This can be refined with explicit role checks later
  return true
}
