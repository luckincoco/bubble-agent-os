import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import type { SpaceRole } from '../../shared/types.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

export function registerSpaceRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { getSpaceRole } = deps

  app.post('/api/spaces', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    const { name, description } = req.body as { name?: string; description?: string }
    if (!name) return reply.code(400).send({ error: 'name 为必填项' })

    const db = getDatabase()
    const existing = db.prepare('SELECT id FROM spaces WHERE name = ?').get(name) as Record<string, unknown> | undefined
    if (existing) return reply.code(409).send({ error: '空间名称已存在' })

    const { ulid } = await import('ulid')
    const id = ulid()
    const now = Date.now()
    db.prepare('INSERT INTO spaces (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, description || '', payload.userId, now)
    db.prepare("INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, 'owner')").run(payload.userId, id)

    logger.info(`Space created: "${name}" by ${payload.username}`)
    return { id, name, description: description || '' }
  })

  app.get('/api/spaces/:id/members', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.post('/api/spaces/:id/members', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.put('/api/spaces/:id/members/:userId', async (req: FastifyRequest, reply: FastifyReply) => {
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

  app.delete('/api/spaces/:id/members/:userId', async (req: FastifyRequest, reply: FastifyReply) => {
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
}
