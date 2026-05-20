import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import type { ScheduledTaskType } from '../../scheduler/scheduler.js'

export function registerTaskRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { requireAdmin, modules } = deps

  app.get('/api/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    if (!modules?.scheduler) return { tasks: [] }
    return { tasks: modules.scheduler.listTasks() }
  })

  app.post('/api/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { name, type, cron: cronExpr, params } = req.body as {
      name?: string; type?: string; cron?: string; params?: Record<string, unknown>
    }
    if (!name || !type || !cronExpr) {
      return reply.code(400).send({ error: 'name, type, cron 为必填项' })
    }

    try {
      const id = await modules.scheduler.addTask(name, type as ScheduledTaskType, cronExpr, params)
      return { id }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.put('/api/tasks/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { id } = req.params as { id: string }
    const updates = req.body as { name?: string; cron?: string; params?: Record<string, unknown>; enabled?: boolean }

    try {
      modules.scheduler.updateTask(id, updates)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.delete('/api/tasks/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { id } = req.params as { id: string }
    try {
      modules.scheduler.removeTask(id)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/run', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { id } = req.params as { id: string }
    try {
      const result = await modules.scheduler.executeNow(id)
      return result
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })
}
