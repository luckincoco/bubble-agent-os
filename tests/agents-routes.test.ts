import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockListAgents = vi.hoisted(() => vi.fn())
const mockGetAgent = vi.hoisted(() => vi.fn())
const mockCreateAgent = vi.hoisted(() => vi.fn())
const mockUpdateAgent = vi.hoisted(() => vi.fn())
const mockDeleteAgent = vi.hoisted(() => vi.fn())
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))
const mockBrain = vi.hoisted(() => ({
  setActiveAgent: vi.fn(),
}))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/agent/model.js', () => ({
  listAgents: mockListAgents,
  getAgent: mockGetAgent,
  createAgent: mockCreateAgent,
  updateAgent: mockUpdateAgent,
  deleteAgent: mockDeleteAgent,
}))
vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

// ── Imports ────────────────────────────────────────────────

import { registerAgentRoutes } from '../src/server/routes/agents.js'

// ════════════════════════════════════════════════════════════
//  registerAgentRoutes
// ════════════════════════════════════════════════════════════

describe('registerAgentRoutes', () => {
  const defaultUser = { userId: 'test-user', username: 'test', role: 'admin', spaceIds: ['space-1'] }

  const mockDeps = {
    brain: mockBrain,
    requireAdmin: vi.fn(),
    memory: {} as any,
    modules: {} as any,
    router: {} as any,
    getUserCtx: vi.fn(),
    getBizCtx: vi.fn(),
    getSpaceRole: vi.fn(),
  }

  function buildApp() {
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerAgentRoutes(app, mockDeps as any)
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  // ── GET /api/agents ──────────────────────────────────────

  it('GET / returns agents list', async () => {
    const fakeAgents = [{ id: 'a1', name: 'Agent1' }]
    mockListAgents.mockReturnValue(fakeAgents)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/agents' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ agents: fakeAgents })
    expect(mockListAgents).toHaveBeenCalledWith('test-user', ['space-1'])
  })

  // ── POST /api/agents ─────────────────────────────────────

  it('POST / creates agent', async () => {
    const fakeAgent = { id: 'new-id', name: 'Test Agent' }
    mockCreateAgent.mockReturnValue(fakeAgent)
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Test Agent', systemPrompt: 'You are helpful' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ agent: fakeAgent })
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Test Agent', systemPrompt: 'You are helpful', creatorId: 'test-user' }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Test Agent'))
  })

  it('POST / returns 400 when name missing', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { systemPrompt: 'You are helpful' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  it('POST / returns 400 when systemPrompt missing', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Test Agent' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  // ── PUT /api/agents/:id ──────────────────────────────────

  it('PUT /:id updates agent', async () => {
    const agent = { id: 'a1', creatorId: 'test-user', name: 'Old', description: '' }
    const updated = { id: 'a1', creatorId: 'test-user', name: 'Updated', description: '' }
    mockGetAgent.mockReturnValueOnce(agent).mockReturnValueOnce(updated)
    const app = buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/agents/a1',
      payload: { name: 'Updated' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload).agent.name).toBe('Updated')
    expect(mockUpdateAgent).toHaveBeenCalledWith('a1', { name: 'Updated' })
  })

  it('PUT /:id returns 404 when not found', async () => {
    mockGetAgent.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/agents/missing',
      payload: { name: 'Nope' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('PUT /:id returns 403 when not owner nor admin', async () => {
    mockGetAgent.mockReturnValue({ id: 'a1', creatorId: 'other-user', name: 'Test' })
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = { ...defaultUser, role: 'user' }
    })
    registerAgentRoutes(app, mockDeps as any)

    const res = await app.inject({
      method: 'PUT',
      url: '/api/agents/a1',
      payload: { name: 'Nope' },
    })

    expect(res.statusCode).toBe(403)
  })

  // ── DELETE /api/agents/:id ───────────────────────────────

  it('DELETE /:id deletes agent', async () => {
    mockGetAgent.mockReturnValue({ id: 'a1', creatorId: 'test-user', name: 'Agent1' })
    const app = buildApp()

    const res = await app.inject({ method: 'DELETE', url: '/api/agents/a1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })
    expect(mockDeleteAgent).toHaveBeenCalledWith('a1')
    expect(mockBrain.setActiveAgent).toHaveBeenCalledWith('test-user', null)
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('deleted'))
  })

  it('DELETE /:id returns 404 when not found', async () => {
    mockGetAgent.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'DELETE', url: '/api/agents/missing' })

    expect(res.statusCode).toBe(404)
  })

  it('DELETE /:id returns 403 when not owner nor admin', async () => {
    mockGetAgent.mockReturnValue({ id: 'a1', creatorId: 'other-user', name: 'Agent1' })
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = { ...defaultUser, role: 'user' }
    })
    registerAgentRoutes(app, mockDeps as any)

    const res = await app.inject({ method: 'DELETE', url: '/api/agents/a1' })

    expect(res.statusCode).toBe(403)
  })

  // ── POST /api/agents/:id/activate ────────────────────────

  it('POST /:id/activate activates agent', async () => {
    const agent = { id: 'a1', name: 'Helper' }
    mockGetAgent.mockReturnValue(agent)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/api/agents/a1/activate' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true, agentId: 'a1' })
    expect(mockBrain.setActiveAgent).toHaveBeenCalledWith('test-user', agent)
  })

  it('POST /:id/activate with id=none deactivates', async () => {
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/api/agents/none/activate' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true, agentId: null })
    expect(mockBrain.setActiveAgent).toHaveBeenCalledWith('test-user', null)
  })

  it('POST /:id/activate returns 404 when not found', async () => {
    mockGetAgent.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'POST', url: '/api/agents/missing/activate' })

    expect(res.statusCode).toBe(404)
  })
})
