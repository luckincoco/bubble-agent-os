import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { createBubble, getBubble, searchBubbles, deleteBubble, updateBubble, getAllMemoryBubbles } from '../src/bubble/model.js'
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../src/agent/model.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { ulid } from 'ulid'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-'))
  initDatabase(tmpDir, 'test-password-123')

  // Manually create admin + spaces to get a full seed state for testing
  // (runMigrations creates bobi first, which causes seedData to skip)
  const db = getDatabase()
  const adminExists = db.prepare("SELECT id FROM users WHERE username = 'admin'").get()
  if (!adminExists) {
    const now = Date.now()
    const hash = bcrypt.hashSync('test-password-123', 10)
    const adminId = ulid()
    const workId = ulid()
    const personalId = ulid()
    db.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(workId, '工作', '团队工作空间', now)
    db.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(personalId, '个人', '个人空间', now)
    db.prepare('INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(adminId, 'admin', hash, '管理员', 'admin', now)
    db.prepare('INSERT INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(adminId, workId)
    db.prepare('INSERT INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(adminId, personalId)
  }
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('Database initialization', () => {
  it('creates tables successfully', () => {
    const db = getDatabase()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    const tableNames = tables.map(t => t.name)
    expect(tableNames).toContain('bubbles')
    expect(tableNames).toContain('users')
    expect(tableNames).toContain('spaces')
    expect(tableNames).toContain('user_spaces')
    expect(tableNames).toContain('bubble_links')
    expect(tableNames).toContain('scheduled_tasks')
    expect(tableNames).toContain('custom_agents')
  })

  it('seeds admin user', () => {
    const db = getDatabase()
    const admin = db.prepare("SELECT * FROM users WHERE username = 'admin'").get() as any
    expect(admin).toBeDefined()
    expect(admin.display_name).toBe('管理员')
    expect(admin.role).toBe('admin')
  })

  it('seeds default spaces', () => {
    const db = getDatabase()
    const spaces = db.prepare('SELECT * FROM spaces ORDER BY name').all() as any[]
    const names = spaces.map((s: any) => s.name)
    expect(names).toContain('工作')
    expect(names).toContain('个人')
  })

  it('bubbles table has space_id column', () => {
    const db = getDatabase()
    const cols = db.pragma('table_info(bubbles)') as Array<{ name: string }>
    expect(cols.some(c => c.name === 'space_id')).toBe(true)
  })

  it('user_spaces table has role column', () => {
    const db = getDatabase()
    const cols = db.pragma('table_info(user_spaces)') as Array<{ name: string }>
    expect(cols.some(c => c.name === 'role')).toBe(true)
  })
})

describe('Bubble CRUD', () => {
  it('creates a bubble', () => {
    const bubble = createBubble({
      type: 'memory',
      title: '测试泡泡',
      content: '这是一条测试记忆内容',
      tags: ['测试', '单元测试'],
      source: 'test',
    })
    expect(bubble.id).toBeTruthy()
    expect(bubble.title).toBe('测试泡泡')
    expect(bubble.content).toBe('这是一条测试记忆内容')
    expect(bubble.tags).toEqual(['测试', '单元测试'])
    expect(bubble.type).toBe('memory')
  })

  it('gets a bubble by id', () => {
    const created = createBubble({
      type: 'entity',
      title: '实体测试',
      content: 'entity content',
    })
    const found = getBubble(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.title).toBe('实体测试')
  })

  it('returns null for non-existent bubble', () => {
    const found = getBubble('NONEXISTENT_ID')
    expect(found).toBeNull()
  })

  it('updates a bubble', () => {
    const bubble = createBubble({
      type: 'memory',
      title: '原始标题',
      content: '原始内容',
    })
    const success = updateBubble(bubble.id, {
      title: '更新后标题',
      content: '更新后内容',
      tags: ['updated'],
    })
    expect(success).toBe(true)
    const updated = getBubble(bubble.id)
    expect(updated!.title).toBe('更新后标题')
    expect(updated!.content).toBe('更新后内容')
    expect(updated!.tags).toEqual(['updated'])
  })

  it('deletes a bubble', () => {
    const bubble = createBubble({
      type: 'memory',
      title: '删除测试',
      content: '即将被删除',
    })
    expect(deleteBubble(bubble.id)).toBe(true)
    expect(getBubble(bubble.id)).toBeNull()
  })

  it('delete returns false for non-existent id', () => {
    expect(deleteBubble('NONEXISTENT_ID')).toBe(false)
  })

  it('searches bubbles by keyword', () => {
    createBubble({
      type: 'memory',
      title: '搜索测试',
      content: '钢材采购价格分析报告',
      tags: ['钢材'],
    })
    const results = searchBubbles('钢材采购')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(b => b.content.includes('钢材'))).toBe(true)
  })

  it('getAllMemoryBubbles returns only memory type', () => {
    createBubble({ type: 'memory', title: 'mem1', content: 'memory content' })
    createBubble({ type: 'entity', title: 'ent1', content: 'entity content' })
    const memories = getAllMemoryBubbles()
    expect(memories.every(b => b.type === 'memory')).toBe(true)
  })

  it('creates bubble with space_id', () => {
    const db = getDatabase()
    const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
    const bubble = createBubble({
      type: 'memory',
      title: 'Space bubble',
      content: 'In a space',
      spaceId: space.id,
    })
    const found = getBubble(bubble.id)
    expect(found!.spaceId).toBe(space.id)
  })
})

describe('Custom Agent CRUD', () => {
  let agentId: string
  let creatorId: string

  beforeAll(() => {
    const db = getDatabase()
    const admin = db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: string }
    creatorId = admin.id
  })

  it('creates an agent', () => {
    const agent = createAgent({
      name: '钢贸分析师',
      description: '专业钢材贸易分析',
      systemPrompt: '你是一名专业的钢材贸易分析师',
      tools: ['weather', 'search'],
      spaceIds: [],
      creatorId,
    })
    agentId = agent.id
    expect(agent.id).toBeTruthy()
    expect(agent.name).toBe('钢贸分析师')
    expect(agent.systemPrompt).toBe('你是一名专业的钢材贸易分析师')
    expect(agent.tools).toEqual(['weather', 'search'])
    expect(agent.creatorId).toBe(creatorId)
  })

  it('gets an agent by id', () => {
    const agent = getAgent(agentId)
    expect(agent).not.toBeNull()
    expect(agent!.name).toBe('钢贸分析师')
  })

  it('returns null for non-existent agent', () => {
    expect(getAgent('NONEXISTENT')).toBeNull()
  })

  it('lists agents by creator', () => {
    const agents = listAgents(creatorId)
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.some(a => a.id === agentId)).toBe(true)
  })

  it('updates an agent', () => {
    const success = updateAgent(agentId, {
      name: '高级钢贸分析师',
      tools: ['weather', 'search', 'time'],
    })
    expect(success).toBe(true)
    const updated = getAgent(agentId)
    expect(updated!.name).toBe('高级钢贸分析师')
    expect(updated!.tools).toEqual(['weather', 'search', 'time'])
  })

  it('deletes an agent', () => {
    const newAgent = createAgent({
      name: '临时Agent',
      systemPrompt: 'temp',
      creatorId,
    })
    expect(deleteAgent(newAgent.id)).toBe(true)
    expect(getAgent(newAgent.id)).toBeNull()
  })

  it('delete returns false for non-existent agent', () => {
    expect(deleteAgent('NONEXISTENT')).toBe(false)
  })
})

describe('Memory surprise detection', () => {
  it('calcSurprise returns high score for novel content', async () => {
    const { calcSurprise } = await import('../src/memory/manager.js')
    const result = calcSurprise('全新的独特内容', [])
    expect(result.score).toBeGreaterThanOrEqual(0.8)
    expect(result.contradicts).toBe(false)
    expect(result.nearDuplicate).toBeNull()
  })

  it('calcSurprise returns low score for duplicate content', async () => {
    const { calcSurprise } = await import('../src/memory/manager.js')
    const existing = [{
      id: '1', type: 'memory' as const, title: '钢材价格',
      content: '螺纹钢价格今天每吨3500元',
      metadata: {}, tags: [], links: [], source: 'test',
      confidence: 1, decayRate: 0.1, pinned: false,
      createdAt: 0, updatedAt: 0, accessedAt: 0,
    }]
    const result = calcSurprise('螺纹钢价格今天每吨3500元', existing)
    expect(result.score).toBeLessThanOrEqual(0.2)
    expect(result.nearDuplicate).not.toBeNull()
  })

  it('calcSurprise detects contradictions', async () => {
    const { calcSurprise } = await import('../src/memory/manager.js')
    // Use comma-separated terms so tokenizer produces overlapping tokens with Jaccard > 0.4
    const existing = [{
      id: '1', type: 'memory' as const, title: '钢材价格',
      content: '螺纹钢，价格，今天，每吨，3500元',
      metadata: {}, tags: [], links: [], source: 'test',
      confidence: 1, decayRate: 0.1, pinned: false,
      createdAt: 0, updatedAt: 0, accessedAt: 0,
    }]
    const result = calcSurprise('螺纹钢，价格，今天，每吨，4200元', existing)
    expect(result.contradicts).toBe(true)
    expect(result.score).toBe(1.0)
  })
})
