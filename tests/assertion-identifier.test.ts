import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssertionIdentifier } from '../src/memory/assertion-identifier.js'
import type { LLMProvider, AssertionTag } from '../src/shared/types.js'

let tmpDir: string
let spaceId: string
let mockLLM: LLMProvider
let identifier: AssertionIdentifier

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-ai-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM conversation_assertions').run()
  db.prepare('DELETE FROM conversation_turns').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeLongResponse(text?: string): string {
  return (text || '这是一个足够长的回复内容，用于测试断言识别功能，确保长度超过300字符的阈值。'.repeat(20)).slice(0, 350)
}

function makeMockLLM(assertions: unknown[]): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      content: JSON.stringify({ assertions }),
    }),
    chatStream: vi.fn(),
  }
}

// ── identify — 跳过条件 ──────────────────────────────────────────

describe('identify — 跳过条件', () => {
  it('短回复 < 300 字符跳过', async () => {
    mockLLM = makeMockLLM([])
    identifier = new AssertionIdentifier(mockLLM)
    const result = await identifier.identify('你好', '好的', 't1', 'u1')
    expect(result).toHaveLength(0)
    expect(mockLLM.chat).not.toHaveBeenCalled()
  })

  it('错误信息（抱歉 + < 400）跳过', async () => {
    mockLLM = makeMockLLM([])
    identifier = new AssertionIdentifier(mockLLM)
    const result = await identifier.identify('测试', '抱歉，我无法处理这个请求。', 't1', 'u1')
    expect(result).toHaveLength(0)
    expect(mockLLM.chat).not.toHaveBeenCalled()
  })

  it('LLM 返回空 assertions 跳过', async () => {
    mockLLM = makeMockLLM([])
    identifier = new AssertionIdentifier(mockLLM)
    const result = await identifier.identify('用户消息内容', makeLongResponse(), 't1', 'u1')
    expect(result).toHaveLength(0)
    expect(mockLLM.chat).toHaveBeenCalled()
  })

  it('LLM 抛出异常不报错返回空数组', async () => {
    mockLLM = {
      chat: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      chatStream: vi.fn(),
    }
    identifier = new AssertionIdentifier(mockLLM)
    await expect(identifier.identify('用户消息', makeLongResponse(), 't1', 'u1'))
      .resolves.toHaveLength(0)
  })
})

// ── identify — 成功路径 ──────────────────────────────────────────

describe('identify — 成功路径', () => {
  it('正常识别并存储断言到 DB', async () => {
    mockLLM = makeMockLLM([
      { textSnippet: '库存量是500', assertionType: 'fact', source: 'user_statement', confidence: 0.9 },
      { textSnippet: '价格可能上涨', assertionType: 'speculation', source: 'self_inference', confidence: 0.6 },
    ])
    identifier = new AssertionIdentifier(mockLLM)

    const tags = await identifier.identify('库存信息', makeLongResponse(), 't1', 'u1', spaceId)
    expect(tags).toHaveLength(2)
    expect(tags[0].assertionType).toBe('fact')
    expect(tags[0].source).toBe('user_statement')
    expect(tags[1].assertionType).toBe('speculation')

    // Verify stored in DB
    const stored = identifier.getAssertionsByTurn('t1')
    expect(stored).toHaveLength(2)
    expect(stored[0].textSnippet).toBe('库存量是500')
  })

  it('超过 8 条截断到 MAX_ASSERTIONS_PER_TURN', async () => {
    const manyAssertions = Array.from({ length: 12 }, (_, i) => ({
      textSnippet: `断言第${i + 1}条内容`,
      assertionType: i % 2 === 0 ? 'fact' : 'judgment',
      source: 'self_inference',
      confidence: 0.8,
    }))
    mockLLM = makeMockLLM(manyAssertions)
    identifier = new AssertionIdentifier(mockLLM)

    const tags = await identifier.identify('测试', makeLongResponse(), 't1', 'u1')
    expect(tags).toHaveLength(8)
  })

  it('更新 conversation_turns.assertion_count', async () => {
    const db = getDatabase()
    db.prepare(`INSERT INTO conversation_turns (id, user_id, space_id, user_input, assistant_response, created_at)
      VALUES ('t1', 'u1', ?, '输入', '回复', ?)`).run(spaceId, Date.now())

    mockLLM = makeMockLLM([
      { textSnippet: '断言1', assertionType: 'fact', source: 'user_statement', confidence: 0.9 },
      { textSnippet: '断言2', assertionType: 'judgment', source: 'self_inference', confidence: 0.8 },
    ])
    identifier = new AssertionIdentifier(mockLLM)

    await identifier.identify('输入', makeLongResponse(), 't1', 'u1', spaceId)
    const row = db.prepare('SELECT assertion_count FROM conversation_turns WHERE id = ?').get('t1') as { assertion_count: number }
    expect(row.assertion_count).toBe(2)
  })
})

// ── getAssertionsByTurn ───────────────────────────────────────────

describe('getAssertionsByTurn', () => {
  it('返回指定 turn 的断言', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const db = getDatabase()
    const now = Date.now()
    db.prepare(`INSERT INTO conversation_assertions
      (id, user_id, space_id, turn_id, text_snippet, assertion_type, source_type,
       verification_status, confidence, user_calibrated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('a1', 'u1', spaceId, 't1', '断言内容', 'fact', 'user_statement', 'pending', 0.9, 0, now, now)

    const tags = identifier.getAssertionsByTurn('t1')
    expect(tags).toHaveLength(1)
    expect(tags[0].id).toBe('a1')
    expect(tags[0].assertionType).toBe('fact')
  })

  it('无断言时返回空数组', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    expect(identifier.getAssertionsByTurn('ghost')).toHaveLength(0)
  })
})

// ── getAssertionsByUser ───────────────────────────────────────────

describe('getAssertionsByUser', () => {
  beforeEach(() => {
    const db = getDatabase()
    const now = Date.now()
    // Insert 3 assertions for u1, 1 for u2
    const insert = db.prepare(`INSERT INTO conversation_assertions
      (id, user_id, space_id, turn_id, text_snippet, assertion_type, source_type,
       verification_status, confidence, user_calibrated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('a1', 'u1', spaceId, 't1', '事实陈述', 'fact', 'user_statement', 'pending', 0.9, 0, now, now)
    insert.run('a2', 'u1', spaceId, 't2', '判断内容', 'judgment', 'self_inference', 'verified', 0.8, 0, now + 1, now + 1)
    insert.run('a3', 'u1', spaceId, 't3', '推测内容', 'speculation', 'self_inference', 'unverifiable', 0.5, 1, now + 2, now + 2)
    insert.run('a4', 'u2', spaceId, 't4', '其他用户', 'fact', 'external_source', 'pending', 0.7, 0, now, now)
  })

  it('返回用户全部断言', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const tags = identifier.getAssertionsByUser('u1')
    expect(tags).toHaveLength(3)
  })

  it('按 assertionType 过滤', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const tags = identifier.getAssertionsByUser('u1', { assertionType: 'fact' })
    expect(tags).toHaveLength(1)
    expect(tags[0].assertionType).toBe('fact')
  })

  it('按 verificationStatus + since + limit 组合过滤', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const tags = identifier.getAssertionsByUser('u1', {
      verificationStatus: 'pending',
      since: Date.now() - 10000,
      limit: 1,
    })
    expect(tags).toHaveLength(1)
    expect(tags[0].id).toBe('a1')
  })
})

// ── calibrateAssertion ────────────────────────────────────────────

describe('calibrateAssertion', () => {
  beforeEach(() => {
    const db = getDatabase()
    const now = Date.now()
    db.prepare(`INSERT INTO conversation_assertions
      (id, user_id, space_id, turn_id, text_snippet, assertion_type, source_type,
       verification_status, confidence, user_calibrated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run('a1', 'u1', spaceId, 't1', '旧断言', 'fact', 'user_statement', 'pending', 0.9, 0, now, now)
  })

  it('更新 assertionType 和 verificationStatus', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const result = identifier.calibrateAssertion('a1', {
      assertionType: 'judgment',
      verificationStatus: 'verified',
    })
    expect(result).toBe(true)

    const tags = identifier.getAssertionsByTurn('t1')
    expect(tags[0].assertionType).toBe('judgment')
    expect(tags[0].verificationStatus).toBe('verified')
    expect(tags[0].userCalibrated).toBe(true)
  })

  it('不存在的 id 返回 false', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const result = identifier.calibrateAssertion('ghost', { verificationStatus: 'verified' })
    expect(result).toBe(false)
  })
})

// ── getAssertionSummary ──────────────────────────────────────────

describe('getAssertionSummary', () => {
  beforeEach(() => {
    const db = getDatabase()
    const now = Date.now()
    const insert = db.prepare(`INSERT INTO conversation_assertions
      (id, user_id, space_id, turn_id, text_snippet, assertion_type, source_type,
       verification_status, confidence, user_calibrated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    insert.run('a1', 'u1', spaceId, 't1', '事实', 'fact', 'user_statement', 'pending', 0.9, 0, now, now)
    insert.run('a2', 'u1', spaceId, 't2', '判断', 'judgment', 'self_inference', 'verified', 0.8, 0, now, now)
    insert.run('a3', 'u1', spaceId, 't3', '推测', 'speculation', 'self_inference', 'unverifiable', 0.5, 1, now, now)

    // Different space
    insert.run('a4', 'u1', 'other-space', 't4', '其他', 'fact', 'external_source', 'pending', 0.7, 0, now, now)
  })

  it('返回全部统计', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const summary = identifier.getAssertionSummary()
    expect(summary.total).toBe(4)
    expect(summary.byType).toEqual({ fact: 2, judgment: 1, speculation: 1 })
    expect(summary.byStatus).toEqual({ pending: 2, verified: 1, unverifiable: 1 })
    expect(summary.userCalibrated).toBe(1)
  })

  it('按 spaceId 过滤统计', () => {
    identifier = new AssertionIdentifier(makeMockLLM([]))
    const summary = identifier.getAssertionSummary(spaceId)
    expect(summary.total).toBe(3)
    expect(summary.byType).toEqual({ fact: 1, judgment: 1, speculation: 1 })
  })
})
