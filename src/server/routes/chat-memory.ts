import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import type { BubbleType } from '../../shared/types.js'
import { createBubble, softDeleteBubble } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { logger } from '../../shared/logger.js'

export function registerChatMemoryRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { brain, memory, router, getUserCtx } = deps

  app.post('/api/chat', async (req: FastifyRequest, reply: FastifyReply) => {
    const { message, spaceId } = req.body as { message: string; spaceId?: string }
    if (!message) return reply.code(400).send({ error: 'message required' })
    const ctx = getUserCtx(req, spaceId)
    if (router) {
      const result = await router.handle(message, ctx)
      return { response: result.response, sources: result.sources, turnId: result.turnId, cognitionLayer: result.cognitionLayer, panel: result.panel, toolCalls: result.toolCalls, contextSummary: result.contextSummary }
    }
    const { response, sources, turnId, cognitionLayer, panel, toolCalls, contextSummary } = await brain.think(message, ctx)
    return { response, sources, turnId, cognitionLayer, panel, toolCalls, contextSummary }
  })

  app.get('/api/memories', async (req: FastifyRequest) => {
    const ctx = getUserCtx(req)
    const { spaceId } = req.query as { spaceId?: string }
    const filterIds = spaceId ? [spaceId].filter(id => ctx.spaceIds.includes(id)) : ctx.spaceIds
    return { memories: memory.listMemories(filterIds) }
  })

  app.get('/ws', { websocket: true }, (socket, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    let userPayload: JwtPayload

    try {
      if (!token) throw new Error('no token')
      userPayload = app.jwt.verify<JwtPayload>(token)
    } catch {
      socket.close(4401, 'Unauthorized')
      return
    }

    socket.on('message', async (raw: Buffer) => {
      try {
        const { message, spaceId } = JSON.parse(raw.toString())
        if (!message) return

        const ctx = {
          userId: userPayload.userId,
          spaceIds: userPayload.spaceIds,
          activeSpaceId: spaceId || userPayload.spaceIds[0] || '',
        }

        socket.send(JSON.stringify({ type: 'start' }))

        const onChunk = (chunk: string) => {
          socket.send(JSON.stringify({ type: 'chunk', text: chunk }))
        }

        let response: string
        let sources: any[]
        let turnId: string | undefined
        let cognitionLayer: string | undefined
        let panel: unknown
        let toolCalls: import('../../shared/types.js').ToolCallInfo[] | undefined
        let contextSummary: string | undefined

        if (router) {
          const result = await router.handle(message, ctx, { onChunk })
          response = result.response
          sources = result.sources
          turnId = result.turnId
          cognitionLayer = result.cognitionLayer
          panel = result.panel
          toolCalls = result.toolCalls
          contextSummary = result.contextSummary
        } else {
          const result = await brain.think(message, ctx, onChunk)
          response = result.response
          sources = result.sources
          turnId = result.turnId
          cognitionLayer = result.cognitionLayer
          panel = result.panel
          toolCalls = result.toolCalls
          contextSummary = result.contextSummary
        }

        socket.send(JSON.stringify({ type: 'done', text: response, sources, turnId, cognitionLayer, panel, toolCalls, contextSummary }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        socket.send(JSON.stringify({ type: 'error', text: msg }))
      }
    })
  })

  app.get('/api/search', async (req: FastifyRequest) => {
    const ctx = getUserCtx(req)
    const { q, limit: lim } = req.query as { q?: string; limit?: string }
    if (!q) return { results: [] }
    const bubbles = await memory.search(q, parseInt(lim || '15'), ctx.spaceIds)
    return { results: bubbles.map(b => ({ type: b.type, title: b.title, content: b.content, tags: b.tags })) }
  })

  app.post('/api/import', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getUserCtx(req)
    const { bubbles = [], links = [], spaceId } = req.body as {
      bubbles: Array<{
        ref: string
        type: BubbleType
        title: string
        content: string
        metadata?: Record<string, unknown>
        tags?: string[]
        source?: string
        confidence?: number
        pinned?: boolean
      }>
      links: Array<{
        sourceRef: string
        targetRef: string
        relation: string
        weight?: number
      }>
      spaceId?: string
    }

    if (!bubbles.length) return reply.code(400).send({ error: 'bubbles array required' })
    const targetSpace = spaceId && (ctx.spaceIds.length === 0 || ctx.spaceIds.includes(spaceId)) ? spaceId : ctx.activeSpaceId

    const refToId = new Map<string, string>()
    let created = 0

    for (const b of bubbles) {
      const bubble = createBubble({
        type: b.type,
        title: b.title,
        content: b.content,
        metadata: b.metadata,
        tags: b.tags,
        source: b.source || 'user',
        confidence: b.confidence ?? 1.0,
        pinned: b.pinned ?? false,
        spaceId: targetSpace,
      })
      refToId.set(b.ref, bubble.id)
      created++
    }

    let linked = 0
    for (const l of links) {
      const sourceId = refToId.get(l.sourceRef)
      const targetId = refToId.get(l.targetRef)
      if (sourceId && targetId) {
        addLink(sourceId, targetId, l.relation, l.weight ?? 0.8, 'user')
        linked++
      }
    }

    logger.info(`Import: ${created} bubbles, ${linked} links`)
    return { created, linked }
  })

  app.delete('/api/bubbles/:id/soft', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const { reason } = req.body as { reason?: string }
    const ok = softDeleteBubble(id, reason || '')
    if (!ok) return reply.code(404).send({ error: '记忆不存在' })
    return { success: true }
  })
}
