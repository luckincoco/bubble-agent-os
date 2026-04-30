/**
 * Knowledge Browser API routes.
 *
 * Provides endpoints for the frontend knowledge browser:
 *  - GET  /api/knowledge/stats     — dashboard summary counts
 *  - GET  /api/knowledge           — paginated index with filters
 *  - GET  /api/knowledge/search    — filtered search
 *  - GET  /api/knowledge/:id       — single bubble detail
 *  - GET  /api/knowledge/:id/evidence — evidence chain tree
 *  - GET  /api/knowledge/:id/graph — graph subset around a bubble
 */

import type { FastifyInstance } from 'fastify'
import type { MemoryManager, SearchFilters } from '../memory/manager.js'
import type { UserContext } from '../shared/types.js'
import { getBubble } from '../bubble/model.js'
import { getLinks } from '../bubble/links.js'
import { getGraphSubset } from '../bubble/links.js'
import { buildEvidenceChain } from '../memory/evidence-chain.js'

interface KnowledgeRoutesDeps {
  memory: MemoryManager
  getUserCtx: (req: any, spaceIdOverride?: string) => UserContext
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: KnowledgeRoutesDeps) {
  const { memory, getUserCtx } = deps

  // Helper: resolve effective spaceIds from request
  function resolveSpaceIds(req: any): string[] {
    const ctx = getUserCtx(req)
    const { spaceId } = req.query as { spaceId?: string }
    if (spaceId) {
      return ctx.spaceIds.includes(spaceId) ? [spaceId] : []
    }
    return ctx.spaceIds
  }

  // Helper: parse SearchFilters from query string
  function parseFilters(query: Record<string, unknown>): SearchFilters {
    const filters: SearchFilters = {}
    if (query.types) filters.types = String(query.types).split(',') as any
    if (query.sources) filters.sources = String(query.sources).split(',')
    if (query.levels) filters.levels = String(query.levels).split(',').map(Number)
    if (query.tags) filters.tags = String(query.tags).split(',')
    if (query.minConfidence) filters.minConfidence = Number(query.minConfidence)
    if (query.since) filters.since = Number(query.since)
    if (query.sortBy) filters.sortBy = String(query.sortBy) as SearchFilters['sortBy']
    if (query.sortDir) filters.sortDir = String(query.sortDir) as SearchFilters['sortDir']
    return filters
  }

  // ── Stats ────────────────────────────────────────────────────

  app.get('/api/knowledge/stats', async (req) => {
    const spaceIds = resolveSpaceIds(req)
    return memory.getKnowledgeStats(spaceIds)
  })

  // ── Paginated index ──────────────────────────────────────────

  app.get('/api/knowledge', async (req) => {
    const spaceIds = resolveSpaceIds(req)
    const query = req.query as Record<string, unknown>
    const filters = parseFilters(query)
    const page = query.page ? Number(query.page) : 1
    const pageSize = Math.min(Number(query.pageSize) || 30, 100)
    return memory.getKnowledgeIndex(spaceIds, filters, page, pageSize)
  })

  // ── Search with filters ──────────────────────────────────────

  app.get('/api/knowledge/search', async (req, reply) => {
    const query = req.query as Record<string, unknown>
    const q = String(query.q || '').trim()
    if (!q) return reply.code(400).send({ error: 'q parameter required' })

    const ctx = getUserCtx(req)
    const spaceIds = resolveSpaceIds(req)
    const filters = parseFilters(query)
    const limit = Math.min(Number(query.limit) || 20, 50)

    const results = await memory.search(q, limit, spaceIds, ctx.userId, filters)
    return { results }
  })

  // ── Single bubble detail ─────────────────────────────────────

  app.get('/api/knowledge/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const spaceIds = resolveSpaceIds(req)
    const bubble = getBubble(id, spaceIds)
    if (!bubble) return reply.code(404).send({ error: 'not found' })

    const links = getLinks(id)
    return { bubble, links }
  })

  // ── Evidence chain ───────────────────────────────────────────

  app.get('/api/knowledge/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string }
    const spaceIds = resolveSpaceIds(req)

    // Verify access
    const bubble = getBubble(id, spaceIds)
    if (!bubble) return reply.code(404).send({ error: 'not found' })

    const maxDepth = Math.min(Number((req.query as any).maxDepth) || 5, 5)
    const chain = buildEvidenceChain(id, maxDepth)
    return chain ?? { root: bubble, nodes: [], totalCount: 0, oldestEvidence: bubble.createdAt, newestEvidence: bubble.createdAt, sourceBreakdown: {} }
  })

  // ── Graph subset ─────────────────────────────────────────────

  app.get('/api/knowledge/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string }
    const spaceIds = resolveSpaceIds(req)

    // Verify access
    const bubble = getBubble(id, spaceIds)
    if (!bubble) return reply.code(404).send({ error: 'not found' })

    const depth = Math.min(Number((req.query as any).depth) || 2, 3)
    const spaceId = spaceIds.length === 1 ? spaceIds[0] : undefined
    return getGraphSubset(id, depth, spaceId)
  })
}
