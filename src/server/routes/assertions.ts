import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import { getDatabase } from '../../storage/database.js'

export function registerAssertionRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { brain } = deps

  app.get('/api/assertions', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { type, status, since, limit } = req.query as {
      type?: string
      status?: string
      since?: string
      limit?: string
    }

    const assertionIdentifier = brain.getAssertionIdentifier?.()
    if (!assertionIdentifier) {
      return reply.code(404).send({ error: 'Assertion identification not enabled' })
    }

    const assertions = assertionIdentifier.getAssertionsByUser(payload.userId, {
      assertionType: type as any,
      verificationStatus: status as any,
      since: since ? parseInt(since) : undefined,
      limit: limit ? parseInt(limit) : 50,
    })

    return { assertions }
  })

  app.get('/api/assertions/turn/:turnId', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { turnId } = req.params as { turnId: string }

    const assertionIdentifier = brain.getAssertionIdentifier?.()
    if (!assertionIdentifier) {
      return reply.code(404).send({ error: 'Assertion identification not enabled' })
    }

    const assertions = assertionIdentifier.getAssertionsByTurn(turnId)
    const db = getDatabase()
    const turn = db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(turnId) as Record<string, unknown> | undefined

    if (!turn) {
      return reply.code(404).send({ error: 'Turn not found' })
    }

    return { assertions, turn }
  })

  app.put('/api/assertions/:id/calibrate', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { id } = req.params as { id: string }
    const { assertionType, verificationStatus } = req.body as {
      assertionType?: string
      verificationStatus?: string
    }

    const assertionIdentifier = brain.getAssertionIdentifier?.()
    if (!assertionIdentifier) {
      return reply.code(404).send({ error: 'Assertion identification not enabled' })
    }

    const updated = assertionIdentifier.calibrateAssertion(id, {
      assertionType: assertionType as any,
      verificationStatus: verificationStatus as any,
    })

    if (!updated) {
      return reply.code(404).send({ error: 'Assertion not found' })
    }

    return { ok: true }
  })

  app.get('/api/assertions/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { spaceId } = req.query as { spaceId?: string }

    const assertionIdentifier = brain.getAssertionIdentifier?.()
    if (!assertionIdentifier) {
      return reply.code(404).send({ error: 'Assertion identification not enabled' })
    }

    return assertionIdentifier.getAssertionSummary(spaceId)
  })
}
