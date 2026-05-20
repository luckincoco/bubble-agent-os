import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'
import type { RouteDeps, JwtPayload, ServerModules } from '../route-types.js'
import type { ExternalUserContext, UserContext } from '../../shared/types.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import * as biz from '../../connector/biz/structured-store.js'
import type { MessageRouter } from '../../connector/router.js'

const RESERVED_USERNAMES = new Set(['service', 'system'])
const USERNAME_RE = /^[a-zA-Z0-9_]{2,30}$/

export function registerAuthAdminRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { getUserCtx } = deps

  function requireAdmin(payload: JwtPayload, reply: FastifyReply): boolean {
    if (payload.role !== 'admin') {
      reply.code(403).send({ error: '权限不足，仅管理员可操作' })
      return true
    }
    return false
  }

  // ── Login ─────────────────────────────────────────────────────

  app.post('/api/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = req.body as { username?: string; password?: string }
    if (!username || !password) return reply.code(400).send({ error: '请输入用户名和密码' })

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined
    if (!user || !bcrypt.compareSync(password, user.password_hash as string)) {
      return reply.code(401).send({ error: '用户名或密码错误' })
    }

    const userSpaces = db.prepare(`
      SELECT s.* FROM spaces s
      JOIN user_spaces us ON us.space_id = s.id
      WHERE us.user_id = ?
      ORDER BY s.created_at
    `).all(user.id) as Array<Record<string, unknown>>
    const spaceIds = userSpaces.map((s: Record<string, unknown>) => s.id as string)
    const spaces = userSpaces.map((s: Record<string, unknown>) => ({ id: s.id as string, name: s.name as string, description: (s.description as string) || '' }))

    const payload: JwtPayload = { userId: user.id as string, username: user.username as string, role: user.role as 'admin' | 'user', spaceIds }
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
        preferences: user.preferences ? JSON.parse(user.preferences as string) : {},
      },
    }
  })

  // ── Preferences ───────────────────────────────────────────────

  app.get('/api/preferences', async (req: FastifyRequest) => {
    const payload = req.user as JwtPayload
    const db = getDatabase()
    const row = db.prepare('SELECT preferences FROM users WHERE id = ?').get(payload.userId) as { preferences?: string } | undefined
    const prefs = row?.preferences ? JSON.parse(row.preferences) : {}
    return { preferences: prefs }
  })

  app.put('/api/preferences', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { preferences } = req.body as { preferences?: unknown }
    if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
      return reply.code(400).send({ error: 'preferences 必须是一个对象' })
    }
    const db = getDatabase()
    db.prepare('UPDATE users SET preferences = ? WHERE id = ?').run(JSON.stringify(preferences), payload.userId)
    return { ok: true }
  })

  // ── Change Password ───────────────────────────────────────────

  app.post('/api/change-password', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { oldPassword, newPassword } = req.body as { oldPassword?: string; newPassword?: string }
    if (!oldPassword || !newPassword) return reply.code(400).send({ error: '请输入旧密码和新密码' })
    if (newPassword.length < 6) return reply.code(400).send({ error: '新密码至少6位' })

    const db = getDatabase()
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId) as Record<string, unknown> | undefined
    if (!user || !bcrypt.compareSync(oldPassword, user.password_hash as string)) {
      return reply.code(401).send({ error: '旧密码错误' })
    }

    const hash = bcrypt.hashSync(newPassword, 10)
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, payload.userId)
    logger.info(`User ${payload.username} changed password`)
    return { ok: true }
  })

  // ── User Management (admin) ───────────────────────────────────

  app.post('/api/users', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.get('/api/users', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.get('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    const db = getDatabase()
    const user = db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined
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

  app.put('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.delete('/api/users/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    if (id === payload.userId) return reply.code(400).send({ error: '不能删除自己' })

    const db = getDatabase()
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined
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

  app.post('/api/users/:id/reset-password', async (req: FastifyRequest, reply: FastifyReply) => {
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

  // ── Test Role (admin-only, simulate external user) ────────────

  app.post('/api/test-role', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { counterpartyName, counterpartyType, message, spaceId } = req.body as {
      counterpartyName?: string
      counterpartyType?: 'supplier' | 'customer' | 'logistics'
      message?: string
      spaceId?: string
    }

    if (!counterpartyName || !counterpartyType || !message) {
      return reply.code(400).send({ error: 'counterpartyName, counterpartyType, message 为必填项' })
    }

    const effectiveSpace = spaceId && (payload.spaceIds.length === 0 || payload.spaceIds.includes(spaceId))
      ? spaceId
      : payload.spaceIds[0] || ''
    const bizCtx = { spaceId: effectiveSpace }

    const counterparty = biz.findCounterpartyByName(bizCtx, counterpartyName, counterpartyType)
      ?? biz.findCounterpartyByName(bizCtx, counterpartyName)
    if (!counterparty) {
      const all = biz.getCounterparties(bizCtx, counterpartyType)
      const names = all.map(c => c.name).slice(0, 10)
      return reply.code(404).send({
        error: `未找到「${counterpartyName}」`,
        available: names,
      })
    }

    const extCtx: ExternalUserContext = {
      userId: payload.userId,
      spaceIds: payload.spaceIds,
      activeSpaceId: effectiveSpace,
      isExternal: true,
      counterpartyId: counterparty.id,
      counterpartyName: counterparty.name,
      counterpartyType: (counterparty.type === 'both' ? 'supplier' : counterparty.type) as 'supplier' | 'customer' | 'logistics',
      permissionLevel: 'query',
      platformUserId: `test-${payload.userId}`,
      platform: 'wecom',
    }

    const { router, brain } = deps
    if (router) {
      const result = await router.handle(message, extCtx)
      return {
        role: counterpartyType,
        counterparty: counterparty.name,
        question: message,
        response: result.response,
        sources: result.sources,
      }
    }

    const { response, sources } = await brain.think(message, extCtx)
    return {
      role: counterpartyType,
      counterparty: counterparty.name,
      question: message,
      response,
      sources,
    }
  })
}
