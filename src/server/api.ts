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
import { parsePDF, parseDocx, parseTxt, splitIntoChunks, detectFileType } from '../connector/tools/doc-import.js'
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../agent/model.js'
import type { WeComConnector } from '../connector/wecom.js'

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

export async function startServer(brain: Brain, memory: MemoryManager, port = 3000, jwtSecret = 'bubble-agent-secret', modules?: ServerModules, serviceApiKey?: string) {
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
      },
    }
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

        const { response, sources } = await brain.think(message, ctx, (chunk) => {
          socket.send(JSON.stringify({ type: 'chunk', text: chunk }))
        })

        socket.send(JSON.stringify({ type: 'done', text: response, sources }))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        socket.send(JSON.stringify({ type: 'error', text: msg }))
      }
    })
  })

  // Health check (public)
  app.get('/api/health', async () => ({ status: 'ok', version: '0.2.1' }))

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
    const targetSpace = spaceId && ctx.spaceIds.includes(spaceId) ? spaceId : ctx.activeSpaceId

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
    const sheetsProcessed: Array<{ sheet: string; rows: number; columns: string[] }> = []

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!)
      if (!rows.length) continue

      const headers = Object.keys(rows[0]!)
      const newBubbleIds: string[] = []

      // Create individual row bubbles
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

      // Build numeric column statistics
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
      for (const [col, st] of Object.entries(numericStats)) {
        statsLines.push(`${col}: 合计=${st.sum}, 最小=${st.min}, 最大=${st.max}, 有效行数=${st.count}`)
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

      semanticLines.push(`这是一份「${sheetName}」表格，共${rows.length}条记录。`)

      for (const [col, vals] of Object.entries(textCols)) {
        if (vals.size <= 10) {
          semanticLines.push(`${col}包含: ${[...vals].join('、')}（共${vals.size}种）`)
        } else {
          const sample = [...vals].slice(0, 5).join('、')
          semanticLines.push(`${col}共${vals.size}种，如: ${sample}等`)
        }
      }

      for (const [col, st] of Object.entries(numericStats)) {
        const avg = (st.sum / st.count).toFixed(2)
        semanticLines.push(`${col}合计${st.sum}，平均${avg}，范围${st.min}~${st.max}`)
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
        `数据来源: Excel文件 工作表「${sheetName}」`,
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
        metadata: { columns: headers, rowCount: rows.length, numericStats, source_file: file.filename },
        tags: [sheetName, 'excel-summary'],
        source: 'excel',
        confidence: 1.0,
        pinned: true,
        spaceId: targetSpace,
      })

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

      sheetsProcessed.push({ sheet: sheetName, rows: rows.length, columns: headers })
      logger.info(`Excel import: sheet "${sheetName}" - ${newBubbleIds.length} rows + 1 summary`)
    }

    if (!sheetsProcessed.length) return reply.code(400).send({ error: 'Excel中没有数据行' })

    logger.info(`Excel import complete: ${totalCreated} rows across ${sheetsProcessed.length} sheets from "${file.filename}"`)
    return { created: totalCreated, sheets: sheetsProcessed }
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
