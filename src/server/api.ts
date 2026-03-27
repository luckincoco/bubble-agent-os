import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import fastifyJwt from '@fastify/jwt'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import type { BubbleType, UserContext, SpaceRole } from '../shared/types.js'
import { createBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { SemanticBridge } from '../memory/semantic-bridge.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import type { TaskScheduler, ScheduledTaskType } from '../scheduler/scheduler.js'
import { EXPORTS_DIR } from '../connector/tools/excel.js'
import {
  detectSheetCategory, translateRow, generateKnowledgeCards, isBaseInfoSheet,
  isTransactionSheet, isTranslatableSheet, computePurchaseAggregations,
  computeSalesAggregations, type KnowledgeCard, type AggregationBubble,
} from '../connector/tools/excel-translator.js'
import { parsePDF, parseDocx, parseTxt, splitIntoChunks, detectFileType } from '../connector/tools/doc-import.js'
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../agent/model.js'
import type { WeComConnector } from '../connector/wecom.js'
import type { MessageRouter } from '../connector/router.js'
import * as biz from '../connector/biz/structured-store.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// JWT payload type
interface JwtPayload {
  userId: string
  username: string
  role: 'admin' | 'user'
  spaceIds: string[]
}

export interface ServerModules {
  semanticBridge?: SemanticBridge
  surpriseDetector?: SurpriseDetector
  scheduler?: TaskScheduler
  tencentConfig?: { secretId: string; secretKey: string; region?: string }
  wecom?: WeComConnector
}

export async function startServer(brain: Brain, memory: MemoryManager, port = 3000, jwtSecret = 'bubble-agent-secret', modules?: ServerModules, serviceApiKey?: string, router?: MessageRouter) {
  const app = Fastify()
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyWebsocket)
  await app.register(fastifyMultipart, { limits: { fileSize: 50 * 1024 * 1024 } })
  await app.register(fastifyJwt, { secret: jwtSecret, sign: { expiresIn: '7d' } })

  // Auth middleware: protect /api/* (except login & health) and /ws
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]

    // Public routes
    if (url === '/api/login' || url === '/api/health') return
    // WebSocket: token verified inside ws handler via query string
    if (url === '/ws') return
    // WeCom callback: verified via signature inside connector
    if (url.startsWith('/wecom/')) return
    // Static files (non-API)
    if (!url.startsWith('/api/')) return

    // Service API key auth (for machine-to-machine calls, e.g. Bobi → Bubble)
    if (serviceApiKey) {
      const apiKey = req.headers['x-api-key']
      if (apiKey === serviceApiKey) {
        // Inject a service user context so downstream handlers work (empty spaceIds = access all)
        ;(req as any).user = { userId: 'service', username: 'service', role: 'admin', spaceIds: [] }
        return
      }
    }

    try {
      await req.jwtVerify()
    } catch {
      reply.code(401).send({ error: '未登录或登录已过期' })
    }
  })

  // Serve frontend static files if built
  const webDist = [
    resolve(__dirname, '../../web/dist'),
    resolve(__dirname, '../web/dist'),
    resolve(process.cwd(), 'web/dist'),
  ].find(p => existsSync(p)) ?? resolve(process.cwd(), 'web/dist')
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' })

    // Prevent browsers from caching index.html so deploys take effect immediately
    app.addHook('onSend', async (req, reply, payload) => {
      const url = req.url.split('?')[0]
      if (url === '/' || url === '/index.html') {
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate')
      }
      return payload
    })

    logger.info(`Serving frontend from ${webDist}`)
  }

  // --- Auth endpoints ---

  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body as { username?: string; password?: string }
    if (!username || !password) return reply.code(400).send({ error: '请输入用户名和密码' })

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return reply.code(401).send({ error: '用户名或密码错误' })
    }

    // Get user's space ids
    let spaceIds: string[]
    let spaces: Array<{ id: string; name: string; description: string }>

    if (user.role === 'admin') {
      // Admin sees all spaces
      const allSpaces = db.prepare('SELECT * FROM spaces ORDER BY created_at').all() as any[]
      spaceIds = allSpaces.map((s: any) => s.id)
      spaces = allSpaces.map((s: any) => ({ id: s.id, name: s.name, description: s.description || '' }))
    } else {
      const userSpaces = db.prepare(`
        SELECT s.* FROM spaces s
        JOIN user_spaces us ON us.space_id = s.id
        WHERE us.user_id = ?
        ORDER BY s.created_at
      `).all(user.id) as any[]
      spaceIds = userSpaces.map((s: any) => s.id)
      spaces = userSpaces.map((s: any) => ({ id: s.id, name: s.name, description: s.description || '' }))
    }

    const payload: JwtPayload = { userId: user.id, username: user.username, role: user.role, spaceIds }
    const token = app.jwt.sign(payload)

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        spaceIds,
        spaces,
        preferences: user.preferences ? JSON.parse(user.preferences) : {},
      },
    }
  })

  // --- User Preferences ---

  app.get('/api/preferences', async (req) => {
    const payload = req.user as JwtPayload
    const db = getDatabase()
    const row = db.prepare('SELECT preferences FROM users WHERE id = ?').get(payload.userId) as { preferences?: string } | undefined
    const prefs = row?.preferences ? JSON.parse(row.preferences) : {}
    return { preferences: prefs }
  })

  app.put('/api/preferences', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { preferences } = req.body as { preferences?: unknown }
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      return reply.code(400).send({ error: 'preferences 必须是一个对象' })
    }
    const db = getDatabase()
    db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(preferences), payload.userId)
    return { ok: true }
  })

  // Change password
  app.post('/api/change-password', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string }
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: '请输入旧密码和新密码' })
    if (newPassword.length < 6) return reply.code(400).send({ error: '新密码至少6位' })

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId) as any
    if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
      return reply.code(401).send({ error: '旧密码错误' })
    }

    const hash = bcrypt.hashSync(newPassword, 10)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, payload.userId)
    logger.info(`User ${payload.username} changed password`)
    return { ok: true }
  })

  // ─── User Management (admin) ─────────────────────────────────

  function requireAdmin(payload: JwtPayload, reply: any): boolean {
    if (payload.role !== 'admin') {
      reply.code(403).send({ error: '权限不足，仅管理员可操作' })
      return true
    }
    return false
  }

  const RESERVED_USERNAMES = new Set(['service', 'system'])
  const USERNAME_RE = /^[a-zA-Z0-9_]{2,30}$/

  // POST /api/users — Create user
  app.post('/api/users', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { username, password, displayName, role } = req.body as {
      username?: string; password?: string; displayName?: string; role?: string
    }
    if (!username || !password || !displayName) {
      return reply.code(400).send({ error: '请输入用户名、密码和显示名' })
    }
    if (!USERNAME_RE.test(username)) {
      return reply.code(400).send({ error: '用户名只能包含字母、数字和下划线，长度2-30位' })
    }
    if (RESERVED_USERNAMES.has(username)) {
      return reply.code(400).send({ error: '该用户名为系统保留' })
    }
    if (password.length < 6) {
      return reply.code(400).send({ error: '密码至少6位' })
    }
    const userRole = role || 'user'
    if (userRole !== 'admin' && userRole !== 'user') {
      return reply.code(400).send({ error: '角色只能是 admin 或 user' })
    }

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
    if (existing) return reply.code(409).send({ error: '用户名已存在' })

    const { ulid } = await import('ulid')
    const userId = ulid()
    const spaceId = ulid()
    const hash = bcrypt.hashSync(password, 10)
    const now = Date.now()

    const createUser = db.transaction(() => {
      db.prepare(
        'INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(userId, username, hash, displayName, userRole, now)
      db.prepare(
        'INSERT INTO spaces (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(spaceId, displayName, `${displayName}的个人空间`, userId, now)
      db.prepare(
        "INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, 'owner')"
      ).run(userId, spaceId)
    })
    createUser()

    logger.info(`User created: "${username}" (${userRole}) by ${payload.username}`)
    return {
      user: { id: userId, username, displayName, role: userRole },
      space: { id: spaceId, name: displayName },
    }
  })

  // GET /api/users — List all users
  app.get('/api/users', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const db = getDatabase()
    const rows = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.role, u.created_at,
             COUNT(us.space_id) as space_count
      FROM users u
      LEFT JOIN user_spaces us ON us.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at
    `).all() as Array<{ id: string; username: string; display_name: string; role: string; created_at: number; space_count: number }>

    return {
      users: rows.map(r => ({
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
        createdAt: r.created_at,
        spaceCount: r.space_count,
      })),
    }
  })

  // GET /api/users/:id — User detail
  app.get('/api/users/:id', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    const db = getDatabase()
    const user = db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(id) as any
    if (!user) return reply.code(404).send({ error: '用户不存在' })

    const spaces = db.prepare(`
      SELECT s.id, s.name, s.description, us.role
      FROM user_spaces us
      JOIN spaces s ON s.id = us.space_id
      WHERE us.user_id = ?
      ORDER BY s.created_at
    `).all(id) as Array<{ id: string; name: string; description: string; role: string }>

    return {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        createdAt: user.created_at,
        spaces,
      },
    }
  })

  // PUT /api/users/:id — Update user
  app.put('/api/users/:id', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    const { displayName, role } = req.body as { displayName?: string; role?: string }
    if (!displayName && !role) return reply.code(400).send({ error: '请提供要更新的字段' })

    if (role) {
      if (role !== 'admin' && role !== 'user') {
        return reply.code(400).send({ error: '角色只能是 admin 或 user' })
      }
      if (id === payload.userId) {
        return reply.code(400).send({ error: '不能修改自己的角色' })
      }
    }

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
    if (!existing) return reply.code(404).send({ error: '用户不存在' })

    const sets: string[] = []
    const params: unknown[] = []
    if (displayName) { sets.push('display_name = ?'); params.push(displayName) }
    if (role) { sets.push('role = ?'); params.push(role) }
    params.push(id)

    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    logger.info(`User updated: ${id} by ${payload.username}`)
    return { ok: true }
  })

  // DELETE /api/users/:id — Delete user
  app.delete('/api/users/:id', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    if (id === payload.userId) return reply.code(400).send({ error: '不能删除自己' })

    const db = getDatabase()
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as any
    if (!target) return reply.code(404).send({ error: '用户不存在' })

    if (target.role === 'admin') {
      const count = db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get() as { cnt: number }
      if (count.cnt <= 1) return reply.code(400).send({ error: '不能删除最后一个管理员' })
    }

    const deleteUser = db.transaction(() => {
      db.prepare('DELETE FROM user_spaces WHERE user_id = ?').run(id)
      db.prepare('DELETE FROM users WHERE id = ?').run(id)
    })
    deleteUser()

    logger.info(`User deleted: "${target.username}" by ${payload.username}`)
    return { ok: true }
  })

  // POST /api/users/:id/reset-password — Admin resets password
  app.post('/api/users/:id/reset-password', async (req, reply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    const { newPassword } = req.body as { newPassword?: string }
    if (!newPassword) return reply.code(400).send({ error: '请输入新密码' })
    if (newPassword.length < 6) return reply.code(400).send({ error: '密码至少6位' })

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(id)
    if (!existing) return reply.code(404).send({ error: '用户不存在' })

    const hash = bcrypt.hashSync(newPassword, 10)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id)
    logger.info(`Password reset for user ${id} by ${payload.username}`)
    return { ok: true }
  })

  // ─────────────────────────────────────────────────────────────

  // Helper: extract user context from JWT
  function getUserCtx(req: any, spaceIdOverride?: string): UserContext {
    const payload = req.user as JwtPayload
    return {
      userId: payload.userId,
      spaceIds: payload.spaceIds,
      activeSpaceId: spaceIdOverride || payload.spaceIds[0] || '',
    }
  }

  // Helper: get user's role in a specific space
  function getSpaceRole(userId: string, spaceId: string, userRole: string): SpaceRole | null {
    if (userRole === 'admin') return 'owner'
    const db = getDatabase()
    const row = db.prepare('SELECT role FROM user_spaces WHERE user_id = ? AND space_id = ?').get(userId, spaceId) as { role: string } | undefined
    return (row?.role as SpaceRole) || null
  }

  // --- API endpoints ---

  app.post('/api/chat', async (req, reply) => {
    const { message, spaceId } = req.body as { message: string; spaceId?: string }
    if (!message) return reply.code(400).send({ error: 'message required' })
    const ctx = getUserCtx(req, spaceId)
    // Use router if available (unified Layer 0 → Layer 1 flow), fallback to brain.think
    if (router) {
      const result = await router.handle(message, ctx)
      return { response: result.response, sources: result.sources }
    }
    const { response, sources } = await brain.think(message, ctx)
    return { response, sources }
  })

  app.get('/api/memories', async (req) => {
    const ctx = getUserCtx(req)
    const { spaceId } = req.query as { spaceId?: string }
    const filterIds = spaceId ? [spaceId].filter(id => ctx.spaceIds.includes(id)) : ctx.spaceIds
    return { memories: memory.listMemories(filterIds) }
  })

  // WebSocket: streaming chat
  app.get('/ws', { websocket: true }, (socket, req) => {
    // Verify token from query string
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

        const ctx: UserContext = {
          userId: userPayload.userId,
          spaceIds: userPayload.spaceIds,
          activeSpaceId: spaceId || userPayload.spaceIds[0] || '',
        }

        socket.send(JSON.stringify({ type: 'start' }))

        // Use router if available (unified Layer 0 → Layer 1 flow), fallback to brain.think
        const onChunk = (chunk: string) => {
          socket.send(JSON.stringify({ type: 'chunk', text: chunk }))
        }

        let response: string
        let sources: any[]

        if (router) {
          const result = await router.handle(message, ctx, { onChunk })
          response = result.response
          sources = result.sources
        } else {
          const result = await brain.think(message, ctx, onChunk)
          response = result.response
          sources = result.sources
        }

        socket.send(JSON.stringify({ type: 'done', text: response, sources }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        socket.send(JSON.stringify({ type: 'error', text: msg }))
      }
    })
  })

  // Health check (public)
  const pkgPath = resolve(process.cwd(), 'package.json')
  const pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string
  app.get('/api/health', async () => ({ status: 'ok', version: pkgVersion }))

  // Search
  app.get('/api/search', async (req) => {
    const ctx = getUserCtx(req)
    const { q, limit: lim } = req.query as { q?: string; limit?: string }
    if (!q) return { results: [] }
    const bubbles = await memory.search(q, parseInt(lim || '15'), ctx.spaceIds)
    return { results: bubbles.map(b => ({ type: b.type, title: b.title, content: b.content, tags: b.tags })) }
  })

  // Batch import
  app.post('/api/import', async (req, reply) => {
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
    // spaceIds=[] means "access all" (admin/service user)
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

  // Excel import
  app.post('/api/import-excel', async (req, reply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传Excel文件' })

    const targetSpace = ctx.activeSpaceId

    const buf = await file.toBuffer()
    const workbook = XLSX.read(buf)
    if (!workbook.SheetNames.length) return reply.code(400).send({ error: 'Excel中没有工作表' })

    let totalCreated = 0
    let knowledgeCardsCreated = 0
    let aggregationsCreated = 0
    const sheetsProcessed: Array<{ sheet: string; rows: number; columns: string[]; category: string }> = []

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!)
      if (!rows.length) continue

      const headers = Object.keys(rows[0]!)
      const category = detectSheetCategory(sheetName)
      const newBubbleIds: string[] = []

      // --- Phase 1: Generate knowledge cards from base-info sheets ---
      if (isBaseInfoSheet(category)) {
        const cards = generateKnowledgeCards(rows, category)
        for (const card of cards) {
          const bubble = createBubble({
            type: card.type as BubbleType,
            title: card.title,
            content: card.content,
            metadata: card.metadata,
            tags: [...card.tags, sheetName, 'knowledge-card'],
            source: 'excel-translated',
            confidence: card.confidence,
            decayRate: card.decayRate,
            pinned: card.pinned,
            abstractionLevel: card.abstractionLevel,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          knowledgeCardsCreated++
          totalCreated++
        }
        logger.info(`Excel import: sheet "${sheetName}" (${category}) → ${cards.length} knowledge cards`)
      }

      // --- Phase 2: Create translated row bubbles for transaction sheets ---
      if (isTranslatableSheet(category)) {
        for (const row of rows) {
          const values = headers.map(h => row[h]).filter(v => v != null && v !== '')
          if (!values.length) continue

          const translated = translateRow(row, sheetName, category)

          const bubble = createBubble({
            type: 'memory' as BubbleType,
            title: translated.title,
            content: translated.content,
            metadata: translated.metadata,
            tags: [...translated.tags, sheetName, 'excel-row'],
            source: 'excel-translated',
            confidence: 0.95,
            pinned: false,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          totalCreated++
        }
      } else if (!isBaseInfoSheet(category)) {
        // Non-translatable, non-base-info sheets: use original key:value format
        for (const row of rows) {
          const values = headers.map(h => row[h]).filter(v => v != null && v !== '')
          if (!values.length) continue

          const title = `${sheetName} - ${String(values[0])}`
          const contentParts = headers
            .map(h => ({ key: h, val: row[h] }))
            .filter(p => p.val != null && p.val !== '')
            .map(p => `${p.key}: ${p.val}`)
          const content = contentParts.join('\n')

          const metadata: Record<string, unknown> = {}
          for (const h of headers) {
            if (row[h] != null && row[h] !== '') metadata[h] = row[h]
          }

          const bubble = createBubble({
            type: 'entity' as BubbleType,
            title,
            content,
            metadata,
            tags: [sheetName, 'excel-row'],
            source: 'excel',
            confidence: 1.0,
            pinned: false,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          totalCreated++
        }
      }

      // --- Phase 3: Pre-computed aggregations for transaction sheets ---
      if (isTransactionSheet(category)) {
        const aggBubbles: AggregationBubble[] = category === 'purchase'
          ? computePurchaseAggregations(rows)
          : computeSalesAggregations(rows)

        for (const agg of aggBubbles) {
          const bubble = createBubble({
            type: 'synthesis' as BubbleType,
            title: agg.title,
            content: agg.content,
            metadata: agg.metadata,
            tags: [...agg.tags, sheetName, 'excel-aggregation'],
            source: 'excel-translated',
            confidence: 1.0,
            pinned: true,
            abstractionLevel: agg.abstractionLevel,
            spaceId: targetSpace,
          })
          // Link aggregation to summary
          newBubbleIds.push(bubble.id)
          aggregationsCreated++
          totalCreated++
        }
        logger.info(`Excel import: sheet "${sheetName}" (${category}) → ${aggBubbles.length} aggregation bubbles`)
      }

      // --- Phase 4: Build summary bubble (enhanced with semantic info) ---
      const numericStats: Record<string, { sum: number; min: number; max: number; count: number }> = {}
      for (const h of headers) {
        const nums: number[] = []
        for (const r of rows) {
          const v = r[h]
          if (v != null && v !== '' && !isNaN(Number(v))) nums.push(Number(v))
        }
        if (nums.length > rows.length * 0.5) {
          numericStats[h] = {
            sum: nums.reduce((a, b) => a + b, 0),
            min: Math.min(...nums),
            max: Math.max(...nums),
            count: nums.length,
          }
        }
      }

      // Build compact data table (markdown)
      const tableHeader = `| ${headers.join(' | ')} |`
      const tableSep = `| ${headers.map(() => '---').join(' | ')} |`
      const tableRows = rows.map(r =>
        `| ${headers.map(h => r[h] != null ? String(r[h]) : '').join(' | ')} |`
      )

      const statsLines: string[] = []
      for (const [colName, st] of Object.entries(numericStats)) {
        statsLines.push(`${colName}: 合计=${st.sum}, 最小=${st.min}, 最大=${st.max}, 有效行数=${st.count}`)
      }

      // --- Semantic bridge: rule-based natural language summary ---
      const semanticLines: string[] = []
      const textCols: Record<string, Set<string>> = {}
      for (const h of headers) {
        const uniqueVals = new Set<string>()
        for (const r of rows) {
          const v = r[h]
          if (v != null && v !== '' && isNaN(Number(v))) uniqueVals.add(String(v))
        }
        if (uniqueVals.size > 0 && uniqueVals.size <= rows.length * 0.8) {
          textCols[h] = uniqueVals
        }
      }

      semanticLines.push(`这是一份「${sheetName}」表格（类型: ${category}），共${rows.length}条记录。`)

      for (const [colName, vals] of Object.entries(textCols)) {
        if (vals.size <= 10) {
          semanticLines.push(`${colName}包含: ${[...vals].join('、')}（共${vals.size}种）`)
        } else {
          const sample = [...vals].slice(0, 5).join('、')
          semanticLines.push(`${colName}共${vals.size}种，如: ${sample}等`)
        }
      }

      for (const [colName, st] of Object.entries(numericStats)) {
        const avg = (st.sum / st.count).toFixed(2)
        semanticLines.push(`${colName}合计${st.sum}，平均${avg}，范围${st.min}~${st.max}`)
      }

      const firstTextCol = Object.keys(textCols)[0]
      const firstNumCol = Object.keys(numericStats)[0]
      if (firstTextCol && firstNumCol && textCols[firstTextCol].size <= 20) {
        const grouped: Record<string, number> = {}
        for (const r of rows) {
          const key = String(r[firstTextCol] ?? '其他')
          const val = Number(r[firstNumCol])
          if (!isNaN(val)) grouped[key] = (grouped[key] || 0) + val
        }
        const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1])
        const topItems = sorted.slice(0, 5).map(([k, v]) => `${k}(${v})`).join('、')
        semanticLines.push(`按${firstTextCol}汇总${firstNumCol}: ${topItems}`)
      }

      const summaryContent = [
        `数据来源: Excel文件 工作表「${sheetName}」（${category}）`,
        `共 ${rows.length} 行数据，列: ${headers.join(', ')}`,
        '',
        '业务摘要:',
        semanticLines.join('\n'),
        '',
        statsLines.length ? `数值列统计:\n${statsLines.join('\n')}` : '',
        '',
        '完整数据表:',
        tableHeader,
        tableSep,
        ...tableRows,
      ].filter(Boolean).join('\n')

      const summaryBubble = createBubble({
        type: 'document' as BubbleType,
        title: `Excel数据总览: ${sheetName}`,
        content: summaryContent,
        metadata: { columns: headers, rowCount: rows.length, numericStats, source_file: file.filename, sheetCategory: category },
        tags: [sheetName, 'excel-summary'],
        source: 'excel',
        confidence: 1.0,
        pinned: true,
        spaceId: targetSpace,
      })

      // Link all row bubbles to summary
      for (const rowId of newBubbleIds) {
        addLink(rowId, summaryBubble.id, 'belongs_to', 0.6, 'system')
      }

      if (modules?.semanticBridge) {
        modules.semanticBridge.bridgeExcelImport(
          newBubbleIds, rows as Record<string, unknown>[], headers, summaryBubble.id, targetSpace,
        ).catch(err => logger.error('SemanticBridge error:', err instanceof Error ? err.message : String(err)))
      }

      if (modules?.surpriseDetector) {
        modules.surpriseDetector.scanExcelImport(
          rows as Record<string, unknown>[], headers, numericStats, sheetName, targetSpace,
        ).catch(err => logger.error('SurpriseDetector error:', err instanceof Error ? err.message : String(err)))
      }

      sheetsProcessed.push({ sheet: sheetName, rows: rows.length, columns: headers, category })
      logger.info(`Excel import: sheet "${sheetName}" (${category}) - ${newBubbleIds.length} bubbles + 1 summary`)
    }

    if (!sheetsProcessed.length) return reply.code(400).send({ error: 'Excel中没有数据行' })

    logger.info(`Excel import complete: ${totalCreated} total (${knowledgeCardsCreated} knowledge cards, ${aggregationsCreated} aggregations) across ${sheetsProcessed.length} sheets from "${file.filename}"`)
    return { created: totalCreated, knowledgeCards: knowledgeCardsCreated, aggregations: aggregationsCreated, sheets: sheetsProcessed }
  })

  // Document import (PDF, Word, TXT)
  app.post('/api/import-doc', async (req, reply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传文档文件（支持PDF、Word、TXT）' })

    const filename = file.filename || 'unknown'
    const fileType = detectFileType(filename)
    if (!fileType) {
      return reply.code(400).send({ error: '不支持的文件格式，请上传 .pdf、.docx 或 .txt 文件' })
    }

    const targetSpace = ctx.activeSpaceId
    const buf = await file.toBuffer()

    let text: string
    let pageCount: number | undefined

    try {
      if (fileType === 'pdf') {
        const result = await parsePDF(buf)
        text = result.text
        pageCount = result.pageCount
      } else if (fileType === 'docx') {
        const result = await parseDocx(buf)
        text = result.text
      } else {
        text = parseTxt(buf).text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: `文档解析失败: ${msg}` })
    }

    if (!text.trim()) return reply.code(400).send({ error: '文档内容为空' })

    const chunks = splitIntoChunks(text, 2000)
    const wordCount = text.length
    const newBubbleIds: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const bubble = createBubble({
        type: 'entity' as BubbleType,
        title: `${filename} - 第${i + 1}段`,
        content: chunks[i],
        metadata: { filename, fileType, chunkIndex: i, totalChunks: chunks.length },
        tags: [filename, 'doc-chunk', `chunk-${i + 1}`],
        source: 'doc-import',
        confidence: 1.0,
        pinned: false,
        spaceId: targetSpace,
      })
      newBubbleIds.push(bubble.id)
    }

    // Summary bubble
    const summaryLines = [
      `文档来源: ${filename}`,
      `文件类型: ${fileType.toUpperCase()}`,
      pageCount != null ? `页数: ${pageCount}` : null,
      `总字数: ${wordCount}`,
      `分块数: ${chunks.length}`,
      '',
      '内容预览:',
      text.slice(0, 500) + (text.length > 500 ? '...' : ''),
    ].filter(l => l != null).join('\n')

    const summaryBubble = createBubble({
      type: 'document' as BubbleType,
      title: `文档总览: ${filename}`,
      content: summaryLines,
      metadata: { filename, fileType, pageCount, wordCount, chunkCount: chunks.length },
      tags: [filename, 'doc-summary'],
      source: 'doc-import',
      confidence: 1.0,
      pinned: true,
      spaceId: targetSpace,
    })

    // Link chunks to summary
    for (const chunkId of newBubbleIds) {
      addLink(chunkId, summaryBubble.id, 'part_of', 0.9, 'system')
    }

    if (modules?.semanticBridge && 'bridgeDocImport' in modules.semanticBridge) {
      (modules.semanticBridge as any).bridgeDocImport(newBubbleIds, chunks, summaryBubble.id, targetSpace)
        ?.catch((err: unknown) => logger.error('SemanticBridge doc error:', err instanceof Error ? err.message : String(err)))
    }

    logger.info(`Doc import: "${filename}" (${fileType}) - ${chunks.length} chunks + 1 summary`)
    return { created: newBubbleIds.length + 1, filename, fileType, chunks: chunks.length, wordCount }
  })

  // Excel export file download
  app.get('/api/exports/:filename', async (req, reply) => {
    const { filename } = req.params as { filename: string }
    const safeName = decodeURIComponent(filename).replace(/[^a-zA-Z0-9_\u4e00-\u9fff.\-]/g, '_')
    const filePath = resolve(EXPORTS_DIR, safeName)

    if (!filePath.startsWith(EXPORTS_DIR) || !existsSync(filePath)) {
      return reply.code(404).send({ error: '文件不存在或已过期' })
    }

    const buf = readFileSync(filePath)
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`)
    return reply.send(buf)
  })

  // --- Scheduled Tasks CRUD ---

  app.get('/api/tasks', async () => {
    if (!modules?.scheduler) return { tasks: [] }
    return { tasks: modules.scheduler.listTasks() }
  })

  app.post('/api/tasks', async (req, reply) => {
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

  app.put('/api/tasks/:id', async (req, reply) => {
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

  app.delete('/api/tasks/:id', async (req, reply) => {
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { id } = req.params as { id: string }
    try {
      modules.scheduler.removeTask(id)
      return { ok: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/tasks/:id/run', async (req, reply) => {
    if (!modules?.scheduler) return reply.code(503).send({ error: '调度器未启用' })

    const { id } = req.params as { id: string }
    try {
      const result = await modules.scheduler.executeNow(id)
      return result
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // --- P2-4: Space member management ---

  // Create a new space
  app.post('/api/spaces', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { name, description } = req.body as { name?: string; description?: string }
    if (!name) return reply.code(400).send({ error: 'name 为必填项' })

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM spaces WHERE name = ?').get(name) as any
    if (existing) return reply.code(409).send({ error: '空间名称已存在' })

    const id = (await import('ulid')).ulid()
    const now = Date.now()
    db.prepare('INSERT INTO spaces (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, description || '', payload.userId, now)
    db.prepare("INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, 'owner')").run(payload.userId, id)

    logger.info(`Space created: "${name}" by ${payload.username}`)
    return { id, name, description: description || '' }
  })

  // List members of a space
  app.get('/api/spaces/:id/members', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const role = getSpaceRole(payload.userId, id, payload.role)
    if (!role) return reply.code(403).send({ error: '无权访问该空间' })

    const db = getDatabase()
    const rows = db.prepare(`
      SELECT u.id as user_id, u.username, u.display_name, us.role
      FROM user_spaces us JOIN users u ON u.id = us.user_id
      WHERE us.space_id = ?
      ORDER BY us.role, u.display_name
    `).all(id) as Array<{ user_id: string; username: string; display_name: string; role: string }>

    return {
      members: rows.map(r => ({
        userId: r.user_id,
        username: r.username,
        displayName: r.display_name,
        role: r.role,
      })),
    }
  })

  // Add member to a space
  app.post('/api/spaces/:id/members', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id } = req.params as { id: string }
    const { username, role: memberRole } = req.body as { username?: string; role?: SpaceRole }

    const callerRole = getSpaceRole(payload.userId, id, payload.role)
    if (callerRole !== 'owner') return reply.code(403).send({ error: '只有空间所有者可以添加成员' })
    if (!username) return reply.code(400).send({ error: 'username 为必填项' })

    const db = getDatabase()
    const targetUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string } | undefined
    if (!targetUser) return reply.code(404).send({ error: '用户不存在' })

    const existingMember = db.prepare('SELECT user_id FROM user_spaces WHERE user_id = ? AND space_id = ?').get(targetUser.id, id)
    if (existingMember) return reply.code(409).send({ error: '该用户已在空间中' })

    db.prepare('INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, ?)').run(targetUser.id, id, memberRole || 'editor')
    logger.info(`Space ${id}: added ${username} as ${memberRole || 'editor'}`)
    return { ok: true }
  })

  // Update member role
  app.put('/api/spaces/:id/members/:userId', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id, userId } = req.params as { id: string; userId: string }
    const { role: newRole } = req.body as { role?: SpaceRole }

    const callerRole = getSpaceRole(payload.userId, id, payload.role)
    if (callerRole !== 'owner') return reply.code(403).send({ error: '只有空间所有者可以修改角色' })
    if (!newRole) return reply.code(400).send({ error: 'role 为必填项' })

    const db = getDatabase()
    const result = db.prepare('UPDATE user_spaces SET role = ? WHERE user_id = ? AND space_id = ?').run(newRole, userId, id)
    if (result.changes === 0) return reply.code(404).send({ error: '该成员不在空间中' })

    logger.info(`Space ${id}: ${userId} role -> ${newRole}`)
    return { ok: true }
  })

  // Remove member from space
  app.delete('/api/spaces/:id/members/:userId', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id, userId } = req.params as { id: string; userId: string }

    const callerRole = getSpaceRole(payload.userId, id, payload.role)
    if (callerRole !== 'owner') return reply.code(403).send({ error: '只有空间所有者可以移除成员' })
    if (userId === payload.userId) return reply.code(400).send({ error: '不能移除自己' })

    const db = getDatabase()
    const result = db.prepare('DELETE FROM user_spaces WHERE user_id = ? AND space_id = ?').run(userId, id)
    if (result.changes === 0) return reply.code(404).send({ error: '该成员不在空间中' })

    logger.info(`Space ${id}: removed ${userId}`)
    return { ok: true }
  })

  // --- P2-3: Custom Agent CRUD ---

  app.get('/api/agents', async (req) => {
    const payload = req.user as JwtPayload
    const agents = listAgents(payload.userId, payload.spaceIds)
    return { agents }
  })

  app.post('/api/agents', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { name, description, systemPrompt, avatar, tools, spaceIds } = req.body as {
      name?: string; description?: string; systemPrompt?: string; avatar?: string; tools?: string[]; spaceIds?: string[]
    }
    if (!name || !systemPrompt) return reply.code(400).send({ error: 'name 和 systemPrompt 为必填项' })

    const agent = createAgent({ name, description, systemPrompt, avatar, tools, spaceIds, creatorId: payload.userId })
    logger.info(`Agent created: "${name}" by ${payload.username}`)
    return { agent }
  })

  app.put('/api/agents/:id', async (req, reply) => {
    const payload = req.user as JwtPayload
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

  app.delete('/api/agents/:id', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id } = req.params as { id: string }

    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: 'Agent 不存在' })
    if (agent.creatorId !== payload.userId && payload.role !== 'admin') {
      return reply.code(403).send({ error: '无权删除该 Agent' })
    }

    deleteAgent(id)
    // Deactivate for all users that had this agent active
    brain.setActiveAgent(payload.userId, null)
    logger.info(`Agent deleted: "${agent.name}" by ${payload.username}`)
    return { ok: true }
  })

  // Activate / deactivate an agent for the current user
  app.post('/api/agents/:id/activate', async (req, reply) => {
    const payload = req.user as JwtPayload
    const { id } = req.params as { id: string }

    if (id === 'none') {
      brain.setActiveAgent(payload.userId, null)
      return { ok: true, agentId: null }
    }

    const agent = getAgent(id)
    if (!agent) return reply.code(404).send({ error: 'Agent 不存在' })
    brain.setActiveAgent(payload.userId, agent)
    return { ok: true, agentId: agent.id }
  })

  // ═══════════════════════════════════════════════════════════════
  // Structured Business API (进销存 v0.5)
  // ═══════════════════════════════════════════════════════════════

  // ── Products ──────────────────────────────────────────────────

  app.get('/api/biz/products', async (req) => {
    const { q } = req.query as { q?: string }
    return { data: biz.getProducts(q) }
  })

  app.post('/api/biz/products', async (req, reply) => {
    const body = req.body as any
    if (!body.code || !body.name) return reply.code(400).send({ error: 'code 和 name 为必填项' })
    return { data: biz.createProduct(body) }
  })

  app.put('/api/biz/products/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!biz.getProductById(id)) return reply.code(404).send({ error: '产品不存在' })
    biz.updateProduct(id, req.body as any)
    return { data: biz.getProductById(id) }
  })

  app.delete('/api/biz/products/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteProduct(id)
    return { ok: true }
  })

  // ── Counterparties ────────────────────────────────────────────

  app.get('/api/biz/counterparties', async (req) => {
    const { type } = req.query as { type?: string }
    return { data: biz.getCounterparties(type) }
  })

  app.post('/api/biz/counterparties', async (req, reply) => {
    const body = req.body as any
    if (!body.name || !body.type) return reply.code(400).send({ error: 'name 和 type 为必填项' })
    return { data: biz.createCounterparty(body) }
  })

  app.put('/api/biz/counterparties/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.updateCounterparty(id, req.body as any)
    return { ok: true }
  })

  app.delete('/api/biz/counterparties/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteCounterparty(id)
    return { ok: true }
  })

  // ── Projects ──────────────────────────────────────────────────

  app.get('/api/biz/projects', async () => {
    return { data: biz.getProjects() }
  })

  app.post('/api/biz/projects', async (req, reply) => {
    const body = req.body as any
    if (!body.name) return reply.code(400).send({ error: 'name 为必填项' })
    return { data: biz.createProject(body) }
  })

  app.put('/api/biz/projects/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.updateProject(id, req.body as any)
    return { ok: true }
  })

  app.delete('/api/biz/projects/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteProject(id)
    return { ok: true }
  })

  // ── Purchases ─────────────────────────────────────────────────

  app.get('/api/biz/purchases', async (req) => {
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getPurchases(filter) }
  })

  app.post('/api/biz/purchases', async (req, reply) => {
    const body = req.body as any
    if (!body.date || !body.supplierId || !body.productId) {
      return reply.code(400).send({ error: 'date, supplierId, productId 为必填项' })
    }
    return { data: biz.createPurchase(body) }
  })

  app.put('/api/biz/purchases/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.updatePurchase(id, req.body as any)
    return { ok: true }
  })

  app.delete('/api/biz/purchases/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deletePurchase(id)
    return { ok: true }
  })

  // ── Sales ─────────────────────────────────────────────────────

  app.get('/api/biz/sales', async (req) => {
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getSales(filter) }
  })

  app.post('/api/biz/sales', async (req, reply) => {
    const body = req.body as any
    if (!body.date || !body.customerId || !body.productId) {
      return reply.code(400).send({ error: 'date, customerId, productId 为必填项' })
    }
    if (body.costPrice == null) {
      const lastPrice = biz.getLastPurchasePrice(body.productId)
      if (lastPrice != null) {
        body.costPrice = lastPrice
        body.costAmount = Math.round(body.tonnage * lastPrice * 100) / 100
        body.profit = Math.round((body.totalAmount - body.costAmount) * 100) / 100
      }
    }
    return { data: biz.createSale(body) }
  })

  app.put('/api/biz/sales/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.updateSale(id, req.body as any)
    return { ok: true }
  })

  app.delete('/api/biz/sales/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteSale(id)
    return { ok: true }
  })

  // ── Logistics ─────────────────────────────────────────────────

  app.get('/api/biz/logistics', async (req) => {
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getLogistics(filter) }
  })

  app.post('/api/biz/logistics', async (req, reply) => {
    const body = req.body as any
    if (!body.date) return reply.code(400).send({ error: 'date 为必填项' })
    return { data: biz.createLogistics(body) }
  })

  app.delete('/api/biz/logistics/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteLogistics(id)
    return { ok: true }
  })

  // ── Payments ──────────────────────────────────────────────────

  app.get('/api/biz/payments', async (req) => {
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getPayments(filter) }
  })

  app.post('/api/biz/payments', async (req, reply) => {
    const body = req.body as any
    if (!body.date || !body.direction || !body.counterpartyId || !body.amount) {
      return reply.code(400).send({ error: 'date, direction, counterpartyId, amount 为必填项' })
    }
    return { data: biz.createPayment(body) }
  })

  app.delete('/api/biz/payments/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deletePayment(id)
    return { ok: true }
  })

  // ── Invoices ──────────────────────────────────────────────────

  app.get('/api/biz/invoices', async (req) => {
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getInvoices(filter) }
  })

  app.post('/api/biz/invoices', async (req, reply) => {
    const body = req.body as any
    if (!body.date || !body.direction || !body.counterpartyId || !body.amount) {
      return reply.code(400).send({ error: 'date, direction, counterpartyId, amount 为必填项' })
    }
    return { data: biz.createInvoice(body) }
  })

  app.delete('/api/biz/invoices/:id', async (req) => {
    const { id } = req.params as { id: string }
    biz.deleteInvoice(id)
    return { ok: true }
  })

  // ── Computed Views ────────────────────────────────────────────

  app.get('/api/biz/inventory', async () => ({ data: biz.getInventory() }))
  app.get('/api/biz/receivables', async () => ({ data: biz.getReceivables() }))
  app.get('/api/biz/payables', async () => ({ data: biz.getPayables() }))
  app.get('/api/biz/dashboard', async () => ({ data: biz.getDashboard() }))
  app.get('/api/biz/reconciliation', async () => ({ data: biz.getProjectReconciliation() }))

  // ── Lookup (VLOOKUP replacement) ──────────────────────────────

  app.get('/api/biz/lookup/product', async (req) => {
    const { code } = req.query as { code?: string }
    return { data: code ? biz.lookupProduct(code) ?? null : null }
  })

  app.get('/api/biz/lookup/last-price', async (req) => {
    const { productId } = req.query as { productId?: string }
    return { data: productId ? biz.getLastPurchasePrice(productId) ?? null : null }
  })

  // --- P2-1: OCR image import ---

  app.post('/api/import-image', async (req, reply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传图片文件' })

    if (!modules?.tencentConfig) {
      return reply.code(503).send({ error: 'OCR 服务未配置（需要 TENCENT_SECRET_ID / TENCENT_SECRET_KEY）' })
    }

    const buf = await file.toBuffer()
    const filename = file.filename || 'image'

    try {
      const { recognizeImage } = await import('../connector/ocr.js')
      const result = await recognizeImage(buf, modules.tencentConfig)

      if (!result.text.trim()) {
        return reply.code(400).send({ error: '图片中未识别到文字' })
      }

      const targetSpace = ctx.activeSpaceId
      const bubble = createBubble({
        type: 'document' as BubbleType,
        title: `OCR识别: ${filename}`,
        content: result.text,
        metadata: {
          source_file: filename,
          ocr_confidence: result.averageConfidence,
          ocr_regions: result.regions.length,
        },
        tags: ['ocr', filename],
        source: 'ocr',
        confidence: result.averageConfidence / 100,
        pinned: false,
        spaceId: targetSpace,
      })

      logger.info(`OCR import: "${filename}" -> ${result.regions.length} regions, bubble ${bubble.id}`)
      return {
        bubbleId: bubble.id,
        text: result.text,
        confidence: result.averageConfidence,
        regions: result.regions.length,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('OCR error:', msg)
      return reply.code(500).send({ error: `OCR 识别失败: ${msg}` })
    }
  })

  // Register WeCom callback routes (before SPA fallback to avoid being caught by it)
  if (modules?.wecom) {
    modules.wecom.registerRoutes(app)
  }

  // SPA fallback
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
