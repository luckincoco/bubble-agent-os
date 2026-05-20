import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps } from '../route-types.js'
import { listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../../agent/model.js'
import { logger } from '../../shared/logger.js'

export function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { requireAdmin } = deps

  app.get('/api/agents', async (req: FastifyRequest) => {
    const payload = req.user as { userId: string; spaceIds: string[] }
    const agents = listAgents(payload.userId, payload.spaceIds)
    return { agents }
  })

  app.post('/api/agents', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as { userId: string; username: string }
    const { name, description, systemPrompt, avatar, tools, spaceIds } = req.body as {
      name?: string; description?: string; systemPrompt?: string; avatar?: string; tools?: string[]; spaceIds?: string[]
    }
    if (!name || !systemPrompt) return reply.code(400).send({ error: 'name 和 systemPrompt 为必填项' })

    const agent = createAgent({ name, description, systemPrompt, avatar, tools, spaceIds, creatorId: payload.userId })
    logger.info(`Agent created: "${name}" by ${payload.username}`)
    return { agent }
  })

  app.put('/api/agents/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as { userId: string; role: string }
    const { id } = req.params as { id: string }
    const updates = req.body as Partial<{ name: string; description: string; systemPrompt: string; avatar: string; tools: string[]; spaceIds: string[] }>

    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: 'Agent 不存在' })
    if (agent.creatorId !== payload.userId && payload.role !== 'admin') {
      return reply.code(403).send({ error: '无权修改该 Agent' })
    }

    updateAgent(id, updates)
    return { agent: getAgent(id) }
  })

  app.delete('/api/agents/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as { userId: string; role: string; username: string }
    const { id } = req.params as { id: string }

    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: 'Agent 不存在' })
    if (agent.creatorId !== payload.userId && payload.role !== 'admin') {
      return reply.code(403).send({ error: '无权删除该 Agent' })
    }

    deleteAgent(id)
    deps.brain.setActiveAgent(payload.userId, null)
    logger.info(`Agent deleted: "${agent.name}" by ${payload.username}`)
    return { ok: true }
  })

  app.post('/api/agents/:id/activate', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as { userId: string }
    const { id } = req.params as { id: string }

    if (id === 'none') {
      deps.brain.setActiveAgent(payload.userId, null)
      return { ok: true, agentId: null }
    }

    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: 'Agent 不存在' })
    deps.brain.setActiveAgent(payload.userId, agent)
    return { ok: true, agentId: agent.id }
  })
}
