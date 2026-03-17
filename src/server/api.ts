import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import * as XLSX from 'xlsx'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import type { BubbleType } from '../shared/types.js'
import { createBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { logger } from '../shared/logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function startServer(brain: Brain, memory: MemoryManager, port = 3000) {
  const app = Fastify()
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyWebsocket)
  await app.register(fastifyMultipart, { limits: { fileSize: 10 * 1024 * 1024 } })

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

  // Search: query bubble memories directly (no LLM, returns raw data)
  app.get('/api/search', async (req) => {
    const { q, limit: lim } = req.query as { q?: string; limit?: string }
    if (!q) return { results: [] }
    const bubbles = await memory.search(q, parseInt(lim || '15'))
    return { results: bubbles.map(b => ({ type: b.type, title: b.title, content: b.content, tags: b.tags })) }
  })

  // Batch import: create bubbles and links
  app.post('/api/import', async (req, reply) => {
    const { bubbles = [], links = [] } = req.body as {
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
    }

    if (!bubbles.length) return reply.code(400).send({ error: 'bubbles array required' })

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

  // Excel import: upload .xlsx/.xls, each row becomes a bubble
  app.post('/api/import-excel', async (req, reply) => {
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传Excel文件' })

    const buf = await file.toBuffer()
    const workbook = XLSX.read(buf)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) return reply.code(400).send({ error: 'Excel中没有工作表' })

    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!)
    if (!rows.length) return reply.code(400).send({ error: 'Excel中没有数据行' })

    const headers = Object.keys(rows[0]!)
    let created = 0

    for (const row of rows) {
      const values = headers.map(h => row[h]).filter(v => v != null && v !== '')
      if (!values.length) continue

      const title = String(values[0])
      const contentParts = headers
        .map(h => ({ key: h, val: row[h] }))
        .filter(p => p.val != null && p.val !== '')
        .map(p => `${p.key}: ${p.val}`)
      const content = contentParts.join('\n')

      const metadata: Record<string, unknown> = {}
      for (const h of headers) {
        if (row[h] != null && row[h] !== '') metadata[h] = row[h]
      }

      createBubble({
        type: 'entity' as BubbleType,
        title,
        content,
        metadata,
        tags: [sheetName],
        source: 'excel',
        confidence: 1.0,
        pinned: false,
      })
      created++
    }

    logger.info(`Excel import: ${created} bubbles from sheet "${sheetName}"`)
    return { created, sheet: sheetName, columns: headers }
  })

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
