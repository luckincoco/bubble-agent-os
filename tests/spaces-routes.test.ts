import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

// In-memory DB for testing (hoisted to be available when module runs)
let mockDb: Database.Database
vi.mock('../src/storage/database.js', () => ({
  getDatabase: () => mockDb,
}))

// ── Imports ────────────────────────────────────────────────

import { registerSpaceRoutes } from '../src/server/routes/spaces.js'

// ════════════════════════════════════════════════════════════
//  registerSpaceRoutes
// ════════════════════════════════════════════════════════════

describe('registerSpaceRoutes', () => {
  const defaultUser = { userId: 'test-user', username: 'test', role: 'admin', spaceIds: ['space-1'] }
  const mockGetSpaceRole = vi.fn()

  const mockDeps = {
    brain: {} as any,
    memory: {} as any,
    modules: {} as any,
    router: {} as any,
    requireAdmin: vi.fn(),
    getUserCtx: vi.fn(),
    getBizCtx: vi.fn(),
    getSpaceRole: mockGetSpaceRole,
  }

  function buildApp() {
    const app = Fastify()
    app.addHook('onRequest', async (req) => {
      (req as any).user = defaultUser
    })
    registerSpaceRoutes(app, mockDeps as any)
    return app
  }

  beforeAll(() => {
    mockDb = new Database(':memory:')
    mockDb.exec(`
      CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT, description TEXT, creator_id TEXT, created_at INTEGER);
      CREATE TABLE user_spaces (user_id TEXT, space_id TEXT, role TEXT);
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, display_name TEXT);
    `)
  })

  afterAll(() => {
    mockDb.close()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb.exec('DELETE FROM spaces; DELETE FROM user_spaces; DELETE FROM users;')
    // Seed the test user so member-lookup queries work
    mockDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('test-user', 'test', 'Test User')
  })

  // ── POST /api/spaces ─────────────────────────────────────

  it('POST / creates a space', async () => {
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'My Space', description: 'A test space' },
    })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveProperty('id')
    expect(body.name).toBe('My Space')
    expect(body.description).toBe('A test space')
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Space created'))

    // Verify DB has the record
    const row = mockDb.prepare('SELECT * FROM spaces WHERE id = ?').get(body.id) as any
    expect(row).toBeTruthy()
    expect(row.name).toBe('My Space')
    expect(row.creator_id).toBe('test-user')
  })

  it('POST / returns 400 when name missing', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { description: 'no name' },
    })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  it('POST / returns 409 when name already exists', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Duplicate' },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Duplicate' },
    })

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  // ── GET /api/spaces/:id/members ──────────────────────────

  it('GET /:id/members returns members list', async () => {
    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Team Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    const res = await app.inject({ method: 'GET', url: `/api/spaces/${spaceId}/members` })

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.payload)
    expect(body).toHaveProperty('members')
    expect(Array.isArray(body.members)).toBe(true)
    // Should include the creator
    expect(body.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: 'test-user' })]),
    )
  })

  it('GET /:id/members returns 403 when no access', async () => {
    mockGetSpaceRole.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/spaces/some-space/members' })

    expect(res.statusCode).toBe(403)
  })

  // ── POST /api/spaces/:id/members ─────────────────────────

  it('POST /:id/members adds a member', async () => {
    // Add another user to the DB (not the space creator)
    mockDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('user-2', 'alice', 'Alice')

    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Member Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    const res = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      payload: { username: 'alice', role: 'editor' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })

    // Verify DB has the record
    const row = mockDb.prepare('SELECT * FROM user_spaces WHERE user_id = ? AND space_id = ?').get('user-2', spaceId) as any
    expect(row).toBeTruthy()
    expect(row.role).toBe('editor')
  })

  it('POST /:id/members returns 403 when not owner', async () => {
    mockGetSpaceRole.mockReturnValue('editor')
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/some-space/members',
      payload: { username: 'someone', role: 'editor' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('POST /:id/members returns 400 when username missing', async () => {
    mockGetSpaceRole.mockReturnValue('owner')
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/some-space/members',
      payload: { role: 'editor' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('POST /:id/members returns 404 when user not found', async () => {
    mockGetSpaceRole.mockReturnValue('owner')
    const app = buildApp()

    const res = await app.inject({
      method: 'POST',
      url: '/api/spaces/some-space/members',
      payload: { username: 'nonexistent-user', role: 'editor' },
    })

    expect(res.statusCode).toBe(404)
  })

  it('POST /:id/members returns 409 when user already in space', async () => {
    // Add another user first
    mockDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run('user-3', 'bob', 'Bob')

    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Double Member Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    // First add succeeds (bob → editor)
    const addRes = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      payload: { username: 'bob', role: 'editor' },
    })
    expect(addRes.statusCode).toBe(200)

    // Second add with same user → 409
    const res = await app.inject({
      method: 'POST',
      url: `/api/spaces/${spaceId}/members`,
      payload: { username: 'bob', role: 'viewer' },
    })

    expect(res.statusCode).toBe(409)
  })

  // ── PUT /api/spaces/:id/members/:userId ──────────────────

  it('PUT /:id/members/:userId updates member role', async () => {
    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Role Update Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    // First, add test-user as editor (spaces post automatically inserts as owner too, but we're using a different path)
    // The post handler automatically adds creator as owner, so test-user is already in space as owner
    // Now update to viewer
    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${spaceId}/members/test-user`,
      payload: { role: 'viewer' },
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })

    // Verify DB updated
    const row = mockDb.prepare('SELECT role FROM user_spaces WHERE user_id = ? AND space_id = ?').get('test-user', spaceId) as any
    expect(row.role).toBe('viewer')
  })

  it('PUT /:id/members/:userId returns 403 when not owner', async () => {
    mockGetSpaceRole.mockReturnValue('editor')
    const app = buildApp()

    const res = await app.inject({
      method: 'PUT',
      url: '/api/spaces/some-space/members/some-user',
      payload: { role: 'viewer' },
    })

    expect(res.statusCode).toBe(403)
  })

  it('PUT /:id/members/:userId returns 404 when member not in space', async () => {
    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Missing Member Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    const res = await app.inject({
      method: 'PUT',
      url: `/api/spaces/${spaceId}/members/non-member-user`,
      payload: { role: 'viewer' },
    })

    expect(res.statusCode).toBe(404)
  })

  // ── DELETE /api/spaces/:id/members/:userId ───────────────

  it('DELETE /:id/members/:userId removes a member', async () => {
    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Remove Member Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    // First add another member
    const otherUserId = 'other-user'
    mockDb.prepare('INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)').run(otherUserId, 'other', 'Other User')
    mockDb.prepare('INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, ?)').run(otherUserId, spaceId, 'editor')

    // Remove the other member
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/spaces/${spaceId}/members/${otherUserId}`,
    })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ ok: true })

    // Verify DB updated
    const row = mockDb.prepare('SELECT * FROM user_spaces WHERE user_id = ? AND space_id = ?').get(otherUserId, spaceId)
    expect(row).toBeUndefined()
  })

  it('DELETE /:id/members/:userId returns 403 when not owner', async () => {
    mockGetSpaceRole.mockReturnValue('editor')
    const app = buildApp()

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/spaces/some-space/members/some-user',
    })

    expect(res.statusCode).toBe(403)
  })

  it('DELETE /:id/members/:userId returns 400 when removing self', async () => {
    const app = buildApp()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/spaces',
      payload: { name: 'Self Remove Space' },
    })
    const spaceId = JSON.parse(createRes.payload).id

    mockGetSpaceRole.mockReturnValue('owner')

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/spaces/${spaceId}/members/test-user`,
    })

    expect(res.statusCode).toBe(400)
  })
})
