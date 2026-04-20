/**
 * Unified identity resolution for all connectors.
 * Maps platform user IDs to admin or external user contexts.
 */

import type { UserContext, ExternalUserContext } from '../shared/types.js'
import { findExternalContact } from './biz/external-store.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

// ── Cache ────────────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T
  expiresAt: number
}

const extCache = new Map<string, CacheEntry<ExternalUserContext | null>>()
const EXT_CACHE_TTL = 30_000 // 30s

let adminCtxCache: UserContext | null = null

// ── Admin Context ────────────────────────────────────────────────────

function resolveAdminContext(): UserContext {
  if (adminCtxCache) return adminCtxCache

  try {
    const db = getDatabase()
    const user = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin') as { id: string } | undefined
    if (!user) throw new Error('No admin user found')

    const spaces = db.prepare('SELECT space_id FROM user_spaces WHERE user_id = ?').all(user.id) as Array<{ space_id: string }>
    adminCtxCache = {
      userId: user.id,
      spaceIds: spaces.map(s => s.space_id),
      activeSpaceId: spaces[0]?.space_id || '',
    }
  } catch {
    adminCtxCache = { userId: 'system', spaceIds: [], activeSpaceId: '' }
  }

  return adminCtxCache
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Resolve identity from a platform message sender.
 * Returns ExternalUserContext if sender is a bound external contact,
 * otherwise returns the admin context (backward compatible).
 */
export function resolveIdentity(platform: 'wecom' | 'feishu', platformUserId: string): UserContext | ExternalUserContext {
  // Check cache first
  const cacheKey = `${platform}:${platformUserId}`
  const cached = extCache.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value ?? resolveAdminContext()
  }

  // Look up external contact binding
  try {
    const contact = findExternalContact(platform, platformUserId)
    if (contact) {
      const admin = resolveAdminContext()
      const extCtx: ExternalUserContext = {
        userId: `ext-${platform}-${platformUserId}`,
        spaceIds: [contact.spaceId],
        activeSpaceId: contact.spaceId,
        isExternal: true,
        counterpartyId: contact.counterpartyId,
        counterpartyName: contact.counterpartyName,
        counterpartyType: contact.counterpartyType as 'supplier' | 'customer' | 'logistics',
        permissionLevel: contact.permissionLevel,
        platformUserId,
        platform,
      }
      extCache.set(cacheKey, { value: extCtx, expiresAt: Date.now() + EXT_CACHE_TTL })
      logger.info(`Identity: external user ${platformUserId} (${platform}) → ${contact.counterpartyName}`)
      return extCtx
    }
  } catch (err) {
    logger.error('Identity resolution error:', err instanceof Error ? err.message : String(err))
  }

  // Not found → cache as null (avoid repeated DB lookups for admin)
  extCache.set(cacheKey, { value: null, expiresAt: Date.now() + EXT_CACHE_TTL })
  return resolveAdminContext()
}

/** Clear the identity cache (called when bindings change) */
export function clearIdentityCache(): void {
  extCache.clear()
  adminCtxCache = null
}
