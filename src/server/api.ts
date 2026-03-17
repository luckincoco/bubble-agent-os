import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import { logger } from '../shared/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function startServer(brain: Brain, memory: MemoryManager, port = 3000) {
  const app = Fastify()
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyWebsocket)

  // Serve frontend static files if built
  // Try multiple paths: dev mode (src/server/) vs prod mode (dist/)
  const webDist = [
    resolve(__dirname, '../../web/dist'),
    resolve(__dirname, '../web/dist'),
    resolve(process.cwd(), 'web/dist'),
  ].find(p => existsSync(p)) ?? resolve(process.cwd(), 'web/dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })
    logger.info(`Serving frontend from ${webDist}`)
  }

  // REST: chat
  app.post('/api/chat', async (req, reply) => {
    const { message } = req.body as { message: string }
    if (!message) return reply.code(400).send({ error: 'message required' })
    const response = await brain.think(message)
    return { response }
  })

  // REST: memories
  app.get('/api/memories', async () => {
    return { memories: memory.listMemories() }
  })

  // WebSocket: streaming chat
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', async (raw: Buffer) => {
      try {
        const { message } = JSON.parse(raw.toString())
        if (!message) return

        socket.send(JSON.stringify({ type: 'start' }))

        const response = await brain.think(message, (chunk) => {
          socket.send(JSON.stringify({ type: 'chunk', text: chunk }))
        })

        socket.send(JSON.stringify({ type: 'done', text: response }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        socket.send(JSON.stringify({ type: 'error', text: msg }))
      }
    })
  })

  // Health check
  app.get('/api/health', async () => ({ status: 'ok', version: '0.1.0' }))

  // SPA fallback: non-API routes serve index.html
  if (existsSync(webDist)) {
    app.setNotFoundHandler(async (_req, reply) => {
      return reply.sendFile('index.html')
    })
  }

  await app.listen({ port, host: '0.0.0.0' })
  logger.info(`Server: http://localhost:${port}`)
  return app
}
