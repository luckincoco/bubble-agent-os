import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockScheduler = vi.hoisted(() => ({
  listTasks: vi.fn(),
  addTask: vi.fn(),
  updateTask: vi.fn(),
  removeTask: vi.fn(),
  executeNow: vi.fn(),
}))

// ── Imports ────────────────────────────────────────────────

import { registerTaskRoutes } from '../src/server/routes/tasks.js'

// ════════════════════════════════════════════════════════════
//  registerTaskRoutes
// ════════════════════════════════════════════════════════════

describe('registerTaskRoutes', () => {
  const defaultUser = { userId: 'test-admin', username: 'admin', role: 'admin', spaceIds: ['space-1'] }
  const mockRequireAdmin = vi.fn()

  const mockDeps = {
    brain: {} as any,
    memory: {} as any,
    modules: { scheduler: mockScheduler },
    router: {} as any,
    requireAdmin: mockRequireAdmin,
    getUserCtx: vi.fn(),
    getBizCtx: vi.fn(),
    getSpaceRole: vi.fn(),
  }

  function buildApp() {
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerTaskRoutes(app, mockDeps as any)
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── GET /api/tasks ───────────────────────────────────────

  it('GET / returns tasks list', async () => {
    const fakeTasks = [{ id: 't1', name: 'Digest', enabled: true }]
    mockScheduler.listTasks.mockReturnValue(fakeTasks)
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/tasks' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ tasks: fakeTasks })
    expect(mockScheduler.listTasks).toHaveBeenCalledOnce()
  })

  it('GET / returns empty tasks when scheduler unavailable', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerTaskRoutes(app, { ...mockDeps, modules: {} } as any)

    const res = await app.inject({ method: 'GET', url: '/api/tasks' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ tasks: [] })
  })

  // ── POST /api/tasks ──────────────────────────────────────

  it('POST / creates a task', async () => {
    mockScheduler.addTask.mockResolvedValue('new-task-id')
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { name: 'Daily Digest', type: 'daily-digest', cron: '0 9 * * *' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ id: 'new-task-id' })
    expect(mockScheduler.addTask).toHaveBeenCalledWith('Daily Digest', 'daily-digest', '0 9 * * *', undefined)
  })

  it('POST / returns 400 when name missing', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { type: 'daily-digest', cron: '0 9 * * *' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST / returns 400 when type missing', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { name: 'Digest', cron: '0 9 * * *' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST / returns 400 when cron missing', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { name: 'Digest', type: 'daily-digest' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST / returns 503 when scheduler unavailable', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerTaskRoutes(app, { ...mockDeps, modules: {} } as any)

    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { name: 'Digest', type: 'daily-digest', cron: '0 9 * * *' },
    })

    expect(res.statusCode).toBe(503)
  })

  // ── PUT /api/tasks/:id ───────────────────────────────────

  it('PUT /:id updates a task', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/t1',
      payload: { name: 'Updated', cron: '0 8 * * *' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
    expect(mockScheduler.updateTask).toHaveBeenCalledWith('t1', { name: 'Updated', cron: '0 8 * * *' })
  })

  it('PUT /:id returns 503 when scheduler unavailable', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerTaskRoutes(app, { ...mockDeps, modules: {} } as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/tasks/t1',
      payload: { name: 'Nope' },
    })

    expect(res.statusCode).toBe(503)
  })

  // ── DELETE /api/tasks/:id ────────────────────────────────

  it('DELETE /:id removes a task', async () => {
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({ method: 'DELETE', url: '/api/tasks/t1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
    expect(mockScheduler.removeTask).toHaveBeenCalledWith('t1')
  })

  // ── POST /api/tasks/:id/run ──────────────────────────────

  it('POST /:id/run executes a task', async () => {
    mockScheduler.executeNow.mockResolvedValue({ success: true, message: 'Done' })
    mockRequireAdmin.mockReturnValue(false)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/api/tasks/t1/run' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ success: true, message: 'Done' })
    expect(mockScheduler.executeNow).toHaveBeenCalledWith('t1')
  })

  // ── Admin gating ─────────────────────────────────────────

  it('returns 403 when not admin (requireAdmin returns true)', async () => {
    mockRequireAdmin.mockImplementation((_payload: any, reply: any) => {
      reply.code(403).send({ error: '权限不足' })
      return true
    })
    const app = buildApp()

    // Test all routes return 403
    const getRes = await app.inject({ method: 'GET', url: '/api/tasks' })
    expect(getRes.statusCode).toBe(403)

    const postRes = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { name: 'X', type: 'x', cron: '* * * * *' },
    })
    expect(postRes.statusCode).toBe(403)

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/tasks/x',
      payload: { name: 'Y' },
    })
    expect(putRes.statusCode).toBe(403)

    const delRes = await app.inject({ method: 'DELETE', url: '/api/tasks/x' })
    expect(delRes.statusCode).toBe(403)

    const runRes = await app.inject({ method: 'POST', url: '/api/tasks/x/run' })
    expect(runRes.statusCode).toBe(403)
  })
})
