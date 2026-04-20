/**
 * API Smoke Tests
 *
 * Spins up a real server instance with an in-memory/temp database,
 * then validates all major endpoints end-to-end.
 *
 * No LLM calls are made – uses fixture-backed LLM (replay mode by default).
 * Set LLM_FIXTURE_MODE=record to record real responses for future replay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, closeDatabase, getDatabase } from '../src/storage/database.js'
import { MemoryManager } from '../src/memory/manager.js'
import { Brain } from '../src/kernel/brain.js'
import { ToolRegistry } from '../src/connector/registry.js'
import { startServer } from '../src/server/api.js'
import { createFixtureLLM } from './fixture-llm.js'

let tmpDir: string
let baseUrl: string
let server: any  // Fastify instance returned from startServer
let token: string

// Fixture-backed LLM (replay by default, record with LLM_FIXTURE_MODE=record)
const fixtureLLM = createFixtureLLM('api-smoke')

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-smoke-'))
  initDatabase(tmpDir, 'test123')

  const registry = new ToolRegistry()
  registry.register({
    name: 'test_tool',
    description: 'A test tool',
    parameters: { input: { type: 'string', description: 'input' } },
    execute: async (args) => `tool result: ${args.input}`,
  })

  const brain = new Brain(fixtureLLM, registry)
  const memory = new MemoryManager(fixtureLLM, false)

  // startServer returns the Fastify app after listen
  const port = 0  // let OS pick a free port
  server = await startServer(brain, memory, port, 'test-jwt-secret', {})

  // Extract the actual port
  const addr = server.server.address()
  const actualPort = typeof addr === 'object' ? addr.port : addr
  baseUrl = `http://127.0.0.1:${actualPort}`
})

afterAll(async () => {
  if (server) await server.close()
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// Helper
async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as Record<string, string> || {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${baseUrl}${path}`, { ...opts, headers })
}

describe('Health Check', () => {
  it('GET /api/health returns ok', async () => {
    const res = await api('/api/health')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.status).toBe('ok')
    expect(data.version).toBeTruthy()
  })
})

describe('Authentication', () => {
  it('POST /api/login with wrong password returns 401', async () => {
    const res = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bobi', password: 'wrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/login with correct credentials returns token', async () => {
    // initDatabase creates bobi as first user (via migration)
    const res = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bobi', password: 'test123' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.token).toBeTruthy()
    expect(data.user.username).toBe('bobi')
    expect(data.user.role).toBe('admin')
    token = data.token
  })

  it('accessing protected route without token returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/memories`, {
      headers: { 'Content-Type': 'application/json' },
    })
    expect(res.status).toBe(401)
  })
})

describe('Memories API', () => {
  it('GET /api/memories returns array', async () => {
    const res = await api('/api/memories')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Array.isArray(data.memories)).toBe(true)
  })

  it('GET /api/search returns results', async () => {
    const res = await api('/api/search?q=test')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Array.isArray(data.results)).toBe(true)
  })
})

describe('Batch Import', () => {
  it('POST /api/import creates bubbles', async () => {
    const res = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({
        bubbles: [
          { ref: 'test:1', type: 'entity', title: '测试实体', content: '测试内容A', tags: ['test'] },
          { ref: 'test:2', type: 'entity', title: '测试实体2', content: '测试内容B', tags: ['test'] },
        ],
        links: [
          { sourceRef: 'test:1', targetRef: 'test:2', relation: 'related' },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.created).toBe(2)
    expect(data.linked).toBe(1)
  })

  it('POST /api/import with empty bubbles returns 400', async () => {
    const res = await api('/api/import', {
      method: 'POST',
      body: JSON.stringify({ bubbles: [] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('Space Management (P2-4)', () => {
  let newSpaceId: string

  it('POST /api/spaces creates a space', async () => {
    const res = await api('/api/spaces', {
      method: 'POST',
      body: JSON.stringify({ name: '测试空间', description: '自动化测试创建' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.id).toBeTruthy()
    expect(data.name).toBe('测试空间')
    newSpaceId = data.id
  })

  it('GET /api/spaces/:id/members returns members', async () => {
    const res = await api(`/api/spaces/${newSpaceId}/members`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Array.isArray(data.members)).toBe(true)
    // Creator should be in the list as owner
    expect(data.members.length).toBeGreaterThan(0)
    expect(data.members[0].role).toBe('owner')
  })
})

describe('Custom Agents (P2-3)', () => {
  let agentId: string

  it('POST /api/agents creates an agent', async () => {
    const res = await api('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: '测试分析师',
        description: '自动化测试Agent',
        systemPrompt: '你是一名测试分析师',
        tools: ['test_tool'],
      }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.agent.id).toBeTruthy()
    expect(data.agent.name).toBe('测试分析师')
    agentId = data.agent.id
  })

  it('GET /api/agents lists agents', async () => {
    const res = await api('/api/agents')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Array.isArray(data.agents)).toBe(true)
    expect(data.agents.some((a: any) => a.id === agentId)).toBe(true)
  })

  it('PUT /api/agents/:id updates agent', async () => {
    const res = await api(`/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '高级测试分析师' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.agent.name).toBe('高级测试分析师')
  })

  it('POST /api/agents/:id/activate sets active agent', async () => {
    const res = await api(`/api/agents/${agentId}/activate`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })

  it('DELETE /api/agents/:id deletes agent', async () => {
    const res = await fetch(`${baseUrl}/api/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })
})

describe('Change Password', () => {
  it('POST /api/change-password validates old password', async () => {
    const res = await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'newpass123' }),
    })
    expect(res.status).toBe(401)
  })

  it('POST /api/change-password rejects short password', async () => {
    const res = await api('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: 'test123', newPassword: '123' }),
    })
    expect(res.status).toBe(400)
  })
})

// ─── User Management (admin) ───────────────────────────────

describe('User Management (admin)', () => {
  let createdUserId: string

  it('POST /api/users creates a new user with personal space', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser', password: 'test456', displayName: '测试用户' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.user.username).toBe('testuser')
    expect(data.user.displayName).toBe('测试用户')
    expect(data.user.role).toBe('user')
    expect(data.user.id).toBeTruthy()
    expect(data.space.id).toBeTruthy()
    expect(data.space.name).toBe('测试用户')
    createdUserId = data.user.id
  })

  it('POST /api/users rejects duplicate username', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser', password: 'test456', displayName: '测试用户2' }),
    })
    expect(res.status).toBe(409)
  })

  it('POST /api/users rejects missing fields', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/users rejects short password', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser', password: '12', displayName: 'Test' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/users rejects invalid username', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: '用户!@#', password: 'test456', displayName: 'Test' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/users rejects reserved username', async () => {
    const res = await api('/api/users', {
      method: 'POST',
      body: JSON.stringify({ username: 'service', password: 'test456', displayName: 'Service' }),
    })
    expect(res.status).toBe(400)
  })

  it('GET /api/users lists all users', async () => {
    const res = await api('/api/users')
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(Array.isArray(data.users)).toBe(true)
    const usernames = data.users.map((u: any) => u.username)
    expect(usernames).toContain('bobi')
    expect(usernames).toContain('testuser')
  })

  it('GET /api/users never exposes password_hash', async () => {
    const res = await api('/api/users')
    const data = await res.json() as any
    for (const u of data.users) {
      expect(u.password_hash).toBeUndefined()
      expect(u.passwordHash).toBeUndefined()
    }
  })

  it('GET /api/users/:id returns user detail with spaces', async () => {
    const res = await api(`/api/users/${createdUserId}`)
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.user.username).toBe('testuser')
    expect(data.user.displayName).toBe('测试用户')
    expect(Array.isArray(data.user.spaces)).toBe(true)
    expect(data.user.spaces.length).toBeGreaterThanOrEqual(1)
    expect(data.user.spaces[0].name).toBe('测试用户')
  })

  it('GET /api/users/:id returns 404 for non-existent user', async () => {
    const res = await api('/api/users/nonexistent_id')
    expect(res.status).toBe(404)
  })

  it('PUT /api/users/:id updates displayName', async () => {
    const res = await api(`/api/users/${createdUserId}`, {
      method: 'PUT',
      body: JSON.stringify({ displayName: '盈赟会计' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })

  it('PUT /api/users/:id rejects changing own role', async () => {
    // bobi is the current admin logged in — get their userId from JWT
    const meRes = await api('/api/users')
    const meData = await meRes.json() as any
    const bobiId = meData.users.find((u: any) => u.username === 'bobi')?.id
    expect(bobiId).toBeTruthy()

    const res = await api(`/api/users/${bobiId}`, {
      method: 'PUT',
      body: JSON.stringify({ role: 'user' }),
    })
    expect(res.status).toBe(400)
  })

  it('POST /api/users/:id/reset-password succeeds', async () => {
    const res = await api(`/api/users/${createdUserId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: 'newpass789' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
  })

  it('POST /api/users/:id/reset-password rejects short password', async () => {
    const res = await api(`/api/users/${createdUserId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword: '12' }),
    })
    expect(res.status).toBe(400)
  })

  it('login with new password works after reset', async () => {
    const res = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser', password: 'newpass789' }),
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.user.username).toBe('testuser')
    expect(data.user.role).toBe('user')
    expect(data.user.spaceIds.length).toBeGreaterThanOrEqual(1)
  })

  it('non-admin user cannot access user management', async () => {
    // Login as testuser (regular user)
    const loginRes = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'testuser', password: 'newpass789' }),
    })
    const loginData = await loginRes.json() as any
    const userToken = loginData.token

    const res = await fetch(`${baseUrl}/api/users`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`,
      },
    })
    expect(res.status).toBe(403)
  })

  it('DELETE /api/users/:id rejects deleting self', async () => {
    const meRes = await api('/api/users')
    const meData = await meRes.json() as any
    const bobiId = meData.users.find((u: any) => u.username === 'bobi')?.id

    const res = await fetch(`${baseUrl}/api/users/${bobiId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(res.status).toBe(400)
  })

  it('DELETE /api/users/:id returns 404 for non-existent user', async () => {
    const res = await fetch(`${baseUrl}/api/users/nonexistent_id`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
  })

  it('DELETE /api/users/:id deletes user', async () => {
    const res = await fetch(`${baseUrl}/api/users/${createdUserId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)

    // Verify user is gone
    const checkRes = await api(`/api/users/${createdUserId}`)
    expect(checkRes.status).toBe(404)
  })
})
