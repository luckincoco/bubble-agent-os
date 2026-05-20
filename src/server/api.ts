import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import fastifyJwt from '@fastify/jwt'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import type { UserContext, SpaceRole } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import { registerKnowledgeRoutes } from './knowledge-routes.js'
import { registerAuthAdminRoutes } from './routes/auth-admin.js'
import { registerBizRoutes } from './routes/biz.js'
import { registerAgentRoutes } from './routes/agents.js'
import { registerSpaceRoutes } from './routes/spaces.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerChatMemoryRoutes } from './routes/chat-memory.js'
import { registerImportRoutes } from './routes/import-routes.js'
import { registerForgeRoutes } from './routes/forge.js'
import { registerAssertionRoutes } from './routes/assertions.js'
export type { ServerModules } from './route-types.js'
import type { ServerModules, JwtPayload } from './route-types.js'
import type { MessageRouter } from '../connector/router.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function startServer(brain: Brain, memory: MemoryManager, port = 3000, jwtSecret = '', modules?: ServerModules, serviceApiKey?: string, router?: MessageRouter) {
  if (!jwtSecret || jwtSecret === 'bubble-agent-default-secret-change-me' || jwtSecret === 'bubble-agent-secret') {
    throw new Error('SECURITY: JWT_SECRET 未设置或使用了默认值。请在 .env 中设置一个强随机密钥后再启动。')
  }

  const app = Fastify()

  const allowedOrigins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
    : [`http://localhost:${port}`]
  await app.register(fastifyCors, { origin: allowedOrigins, credentials: true })
  await app.register(fastifyWebsocket)
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } })
  await app.register(fastifyJwt, { secret: jwtSecret, sign: { expiresIn: '7d' } })

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    if (url === '/api/login' || url === '/api/health') return
    if (url === '/ws') return
    if (url.startsWith('/wecom/')) return
    if (!url.startsWith('/api/')) return
    if (serviceApiKey) {
      const apiKey = req.headers['x-api-key']
      if (apiKey === serviceApiKey) {
        ;(req as unknown as Record<string, unknown>).user = { userId: 'service', username: 'service', role: 'admin', spaceIds: [] }
        return
      }
    }
    try { await req.jwtVerify() } catch { reply.code(401).send({ error: '未登录或登录已过期' }) }
  })

  function requireAdmin(payload: JwtPayload, reply: FastifyReply): boolean {
    if (payload.role !== 'admin') { reply.code(403).send({ error: '权限不足，仅管理员可操作' }); return true }
    return false
  }

  function getUserCtx(req: FastifyRequest, spaceIdOverride?: string): UserContext {
    const payload = req.user as JwtPayload
    return { userId: payload.userId, spaceIds: payload.spaceIds, activeSpaceId: spaceIdOverride || payload.spaceIds[0] || '' }
  }

  function getBizCtx(req: FastifyRequest): import('../connector/biz/structured-store.js').BizContext {
    const ctx = getUserCtx(req)
    const { spaceId } = (req.query || {}) as { spaceId?: string }
    const effectiveSpace = spaceId && (ctx.spaceIds.length === 0 || ctx.spaceIds.includes(spaceId)) ? spaceId : ctx.activeSpaceId
    return { spaceId: effectiveSpace }
  }

  function getSpaceRole(userId: string, spaceId: string, userRole: string): SpaceRole | null {
    if (userRole === 'admin') return 'owner'
    const db = getDatabase()
    const row = db.prepare('SELECT role FROM user_spaces WHERE user_id = ? AND space_id = ?').get(userId, spaceId) as { role: string } | undefined
    return (row?.role as SpaceRole) || null
  }

  const deps = { brain, memory, modules, router, requireAdmin, getUserCtx, getBizCtx, getSpaceRole }

  registerAuthAdminRoutes(app, deps)
  registerChatMemoryRoutes(app, deps)
  registerBizRoutes(app, deps)
  registerAgentRoutes(app, deps)
  registerSpaceRoutes(app, deps)
  registerTaskRoutes(app, deps)
  registerImportRoutes(app, deps)
  registerForgeRoutes(app, deps)
  registerAssertionRoutes(app, deps)
  registerKnowledgeRoutes(app, { memory, getUserCtx })

  if (modules?.wecom) modules.wecom.registerRoutes(app)

  const webDist = [resolve(__dirname, '../../web/dist'), resolve(__dirname, '../web/dist'), resolve(process.cwd(), 'web/dist')].find(p => existsSync(p)) ?? resolve(process.cwd(), 'web/dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    app.addHook('onSend', async (_req, reply, payload) => {
      const url = _req.url.split('?')[0]
      if (url === '/' || url === '/index.html') reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
      return payload
    })
    logger.info(`Serving frontend from ${webDist}`)
  }

  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string
  app.get('/api/health', async () => ({ status: 'ok', version: pkgVersion }))

  if (existsSync(webDist)) {
    app.setNotFoundHandler(async (_req, reply) => {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
      return reply.sendFile('index.html')
    })
  }

  await app.listen({ port, host: '0.0.0.0' })
  logger.info(`Server: http://localhost:${port}`)
  return app
}
