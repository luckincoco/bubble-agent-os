import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import { updateBubble } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { ulid } from 'ulid'
import { recordFeedback, queryFeedback, getFeedbackStats } from '../../memory/feedback-store.js'

/**
 * Phase 1 feedback loop endpoints.
 *
 * POST /api/feedback              — record a feedback event
 * POST /api/feedback/inaccurate   — mark a bubble as inaccurate
 * GET  /api/feedback              — query feedback events
 * GET  /api/feedback/stats        — get feedback stats by source
 */
export function registerFeedbackRoutes(app: FastifyInstance, _deps: RouteDeps) {
  const { requireAdmin } = _deps

  // ── Generic feedback event ────────────────────────────────────

  app.post('/api/feedback', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { sourceType, sourceId, action, context } = req.body as {
      sourceType?: string
      sourceId?: string
      action?: string
      context?: Record<string, unknown>
    }

    if (!sourceType || !action) {
      return reply.code(400).send({ error: 'sourceType 和 action 为必填项' })
    }

    const validActions = ['delivered', 'read', 'dismissed', 'marked_useful', 'marked_useless', 'acted']
    if (!validActions.includes(action)) {
      return reply.code(400).send({ error: `action 必须是 ${validActions.join('、')} 之一` })
    }

    const event = recordFeedback(
      payload.userId,
      sourceType,
      action as any,
      {
        sourceId: sourceId || '',
        context: context || {},
      },
    )

    return { success: true, id: event.id }
  })

  // ── Mark bubble as inaccurate ────────────────────────────────

  app.post('/api/feedback/inaccurate', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { bubbleId } = req.body as { bubbleId?: string }

    if (!bubbleId) {
      return reply.code(400).send({ error: '缺少 bubbleId' })
    }

    const updated = updateBubble(bubbleId, {
      confidence: 0,
      decayRate: 0.15,
    })

    if (!updated) {
      return reply.code(404).send({ error: '记录不存在' })
    }

    // Record the correction as a bubble link for audit trail
    try {
      addLink(bubbleId, `feedback-${ulid()}`, 'user_contradicts', 1.0, 'user')
    } catch { /* non-critical */ }

    return { success: true }
  })

  // ── Query feedback events ────────────────────────────────────

  app.get('/api/feedback', async (req: FastifyRequest) => {
    const payload = req.user as JwtPayload
    const query = req.query as {
      sourceType?: string
      sourceId?: string
      action?: string
      limit?: string
      since?: string
    }

    const events = queryFeedback({
      sourceType: query.sourceType,
      sourceId: query.sourceId,
      action: query.action as any,
      userId: payload.role === 'admin' ? undefined : payload.userId,
      limit: query.limit ? parseInt(query.limit) : 100,
      since: query.since ? parseInt(query.since) : undefined,
    })

    return { events }
  })

  // ── Feedback stats ───────────────────────────────────────────

  app.get('/api/feedback/stats', async (req: FastifyRequest) => {
    const query = req.query as { sourceType?: string; sourceId?: string }
    if (!query.sourceType) {
      return { error: 'sourceType 为必填项' }
    }

    const stats = getFeedbackStats(query.sourceType, query.sourceId)
    return { stats }
  })
}
