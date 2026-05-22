import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  createBubble,
  getBubble,
  findBubblesByType,
  searchBubbles,
  getAllMemoryBubbles,
  deleteBubble,
  softDeleteBubble,
  updateBubble,
  findCompactionCandidates,
  getChildBubbles,
  findRecentBySource,
  rowToBubble,
  type CreateBubbleInput,
} from '../src/bubble/model.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-md-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_links').run()
  db.prepare('DELETE FROM bubbles').run()
})

function makeInput(overrides: Partial<CreateBubbleInput> = {}): CreateBubbleInput {
  return {
    type: 'entity',
    title: '测试标题',
    content: '测试内容描述',
    ...overrides,
  }
}

// ── createBubble ─────────────────────────────────────────────

describe('createBubble', () => {
  it('creates a bubble with default fields', () => {
    const bubble = createBubble(makeInput())
    expect(bubble.id).toBeTruthy()
    expect(bubble.type).toBe('entity')
    expect(bubble.title).toBe('测试标题')
    expect(bubble.confidence).toBe(1.0)
    expect(bubble.decayRate).toBe(0.1)
    expect(bubble.pinned).toBe(false)
    expect(bubble.source).toBe('system')
    expect(bubble.links).toEqual([])
    expect(bubble.createdAt).toBeGreaterThan(0)
    expect(bubble.updatedAt).toBe(bubble.createdAt)
    expect(bubble.accessedAt).toBe(bubble.createdAt)

    // Verify in DB
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubbles WHERE id = ?').get(bubble.id) as any
    expect(row).toBeTruthy()
    expect(row.title).toBe('测试标题')
  })

  it('auto-generates summary from content when not provided', () => {
    const bubble = createBubble(makeInput({ content: '短内容' }))
    expect(bubble.summary).toBe('短内容')
  })

  it('uses explicit summary when provided', () => {
    const bubble = createBubble(makeInput({ summary: '用户指定摘要' }))
    expect(bubble.summary).toBe('用户指定摘要')
  })

  it('generates summary from title prefix for long content', () => {
    const longContent = 'A'.repeat(200)
    const bubble = createBubble(makeInput({ title: '长文档', content: longContent }))
    // summary = '长文档: ' + first N chars of content
    expect(bubble.summary).toContain('长文档: ')
    expect(bubble.summary!.length).toBeLessThanOrEqual(110) // title + ': ' + up to 100
  })

  it('stores embedding when provided', () => {
    const embedding = [0.1, 0.2, 0.3]
    const bubble = createBubble(makeInput({ embedding }))

    // createBubble stores embedding in DB but doesn't include it in return
    const db = getDatabase()
    const row = db.prepare('SELECT embedding FROM bubbles WHERE id = ?').get(bubble.id) as any
    expect(JSON.parse(row.embedding)).toEqual(embedding)
  })

  it('uses provided source, confidence, decayRate, pinned, spaceId', () => {
    const bubble = createBubble(makeInput({
      source: 'user',
      confidence: 0.5,
      decayRate: 0.3,
      pinned: true,
      spaceId: 'test-space',
    }))
    expect(bubble.source).toBe('user')
    expect(bubble.confidence).toBe(0.5)
    expect(bubble.decayRate).toBe(0.3)
    expect(bubble.pinned).toBe(true)
    expect(bubble.spaceId).toBe('test-space')
  })
})

// ── getBubble ────────────────────────────────────────────────

describe('getBubble', () => {
  it('returns the bubble by ID', () => {
    const created = createBubble(makeInput())
    const found = getBubble(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.title).toBe(created.title)
  })

  it('returns null for non-existent ID', () => {
    expect(getBubble('nonexistent')).toBeNull()
  })

  it('updates accessed_at on read', async () => {
    const created = createBubble(makeInput())
    const beforeAccess = Date.now()
    await new Promise(r => setTimeout(r, 5))
    getBubble(created.id)
    const db = getDatabase()
    const row = db.prepare('SELECT accessed_at FROM bubbles WHERE id = ?').get(created.id) as any
    expect(row.accessed_at).toBeGreaterThanOrEqual(beforeAccess)
  })
})

// ── findBubblesByType ────────────────────────────────────────

describe('findBubblesByType', () => {
  it('finds bubbles by type', () => {
    createBubble(makeInput({ type: 'entity', title: '实体1' }))
    createBubble(makeInput({ type: 'entity', title: '实体2' }))
    createBubble(makeInput({ type: 'memory', title: '记忆1' }))

    const entities = findBubblesByType('entity')
    expect(entities).toHaveLength(2)

    const memories = findBubblesByType('memory')
    expect(memories).toHaveLength(1)
  })

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      createBubble(makeInput({ type: 'entity', title: `实体${i}` }))
    }
    const results = findBubblesByType('entity', 2)
    expect(results).toHaveLength(2)
  })
})

// ── searchBubbles ────────────────────────────────────────────

describe('searchBubbles', () => {
  it('finds bubbles by keyword in content', () => {
    createBubble(makeInput({ content: '螺纹钢价格今日报价' }))
    createBubble(makeInput({ content: '无关内容' }))

    const results = searchBubbles('螺纹钢')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].content).toContain('螺纹钢')
  })

  it('uses fallback LIKE query when all keywords are stop words', () => {
    createBubble(makeInput({ content: '今天天气真好' }))
    // '今天' is a stop word, falls back to original query
    const results = searchBubbles('今天')
    expect(results.length).toBeGreaterThanOrEqual(1)
  })

  it('filters by spaceIds', () => {
    createBubble(makeInput({ content: '螺纹钢行情', spaceId: 'space-a' }))
    createBubble(makeInput({ content: '螺纹钢行情', spaceId: 'space-b' }))

    const results = searchBubbles('螺纹钢', 10, ['space-a'])
    expect(results.every(r => r.spaceId === 'space-a')).toBe(true)
  })
})

// ── getAllMemoryBubbles ──────────────────────────────────────

describe('getAllMemoryBubbles', () => {
  it('returns only memory type bubbles', () => {
    createBubble(makeInput({ type: 'memory', title: '记忆1' }))
    createBubble(makeInput({ type: 'memory', title: '记忆2' }))
    createBubble(makeInput({ type: 'entity', title: '实体' }))

    const results = getAllMemoryBubbles()
    expect(results).toHaveLength(2)
    expect(results.every(r => r.type === 'memory')).toBe(true)
  })

  it('filters by spaceIds', () => {
    createBubble(makeInput({ type: 'memory', spaceId: 'space-a', title: 'a' }))
    createBubble(makeInput({ type: 'memory', spaceId: 'space-b', title: 'b' }))

    const results = getAllMemoryBubbles(['space-a'])
    expect(results).toHaveLength(1)
    expect(results[0].spaceId).toBe('space-a')
  })
})

// ── deleteBubble ─────────────────────────────────────────────

describe('deleteBubble', () => {
  it('hard deletes a bubble', () => {
    const created = createBubble(makeInput())
    expect(deleteBubble(created.id)).toBe(true)
    expect(getBubble(created.id)).toBeNull()

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM bubbles WHERE id = ?').get(created.id) as any
    expect(row).toBeUndefined()
  })

  it('returns false for non-existent ID', () => {
    expect(deleteBubble('nonexistent')).toBe(false)
  })
})

// ── softDeleteBubble ─────────────────────────────────────────

describe('softDeleteBubble', () => {
  it('sets deleted_at and delete_reason', () => {
    const created = createBubble(makeInput())
    const result = softDeleteBubble(created.id, '测试删除')
    expect(result).toBe(true)

    const db = getDatabase()
    const row = db.prepare('SELECT deleted_at, delete_reason FROM bubbles WHERE id = ?').get(created.id) as any
    expect(row.deleted_at).toBeGreaterThan(0)
    expect(row.delete_reason).toBe('测试删除')
  })

  it('excludes soft-deleted bubbles from getBubble', () => {
    const created = createBubble(makeInput())
    softDeleteBubble(created.id, '删除原因')
    expect(getBubble(created.id)).toBeNull()
  })

  it('returns false for non-existent ID', () => {
    expect(softDeleteBubble('nonexistent', 'reason')).toBe(false)
  })
})

// ── updateBubble ─────────────────────────────────────────────

describe('updateBubble', () => {
  it('updates specified fields', () => {
    const created = createBubble(makeInput())
    const result = updateBubble(created.id, { title: '新标题', confidence: 0.9 })
    expect(result).toBe(true)

    const updated = getBubble(created.id)!
    expect(updated.title).toBe('新标题')
    expect(updated.confidence).toBe(0.9)
  })

  it('does not change fields not in updates', () => {
    const created = createBubble(makeInput({ content: '原始内容' }))
    updateBubble(created.id, { title: '新标题' })

    const updated = getBubble(created.id)!
    expect(updated.title).toBe('新标题')
    expect(updated.content).toBe('原始内容') // unchanged
  })

  it('returns false for non-existent ID', () => {
    const result = updateBubble('nonexistent', { title: '新标题' })
    expect(result).toBe(false)
  })
})

// ── findCompactionCandidates ─────────────────────────────────

describe('findCompactionCandidates', () => {
  it('finds bubbles at the given abstraction level without composed_of links', () => {
    createBubble(makeInput({ title: '候选1', abstractionLevel: 0 }))
    createBubble(makeInput({ title: '候选2', abstractionLevel: 0 }))
    createBubble(makeInput({ title: '高层', abstractionLevel: 1 }))

    const candidates = findCompactionCandidates(0)
    expect(candidates.length).toBeGreaterThanOrEqual(2)
    expect(candidates.every(c => c.abstractionLevel === 0)).toBe(true)
  })

  it('excludes bubbles that are already composed_of targets', () => {
    const parent = createBubble(makeInput({ title: '父级' }))
    const child = createBubble(makeInput({ title: '子级', abstractionLevel: 0 }))
    const alone = createBubble(makeInput({ title: '独立', abstractionLevel: 0 }))

    // Link child to parent via composed_of
    const db = getDatabase()
    db.prepare('INSERT INTO bubble_links (source_id, target_id, relation, created_at) VALUES (?, ?, ?, ?)').run(
      parent.id, child.id, 'composed_of', Date.now(),
    )

    const candidates = findCompactionCandidates(0)
    const ids = candidates.map(c => c.id)
    expect(ids).not.toContain(child.id) // has composed_of link
    expect(ids).toContain(alone.id) // no composed_of link
  })
})

// ── getChildBubbles ──────────────────────────────────────────

describe('getChildBubbles', () => {
  it('returns children linked via composed_of', () => {
    const parent = createBubble(makeInput({ title: '父级' }))
    const child1 = createBubble(makeInput({ title: '子1' }))
    const child2 = createBubble(makeInput({ title: '子2' }))
    const unrelated = createBubble(makeInput({ title: '无关' }))

    const db = getDatabase()
    db.prepare('INSERT INTO bubble_links (source_id, target_id, relation, created_at) VALUES (?, ?, ?, ?)').run(parent.id, child1.id, 'composed_of', Date.now())
    db.prepare('INSERT INTO bubble_links (source_id, target_id, relation, created_at) VALUES (?, ?, ?, ?)').run(parent.id, child2.id, 'composed_of', Date.now())

    const children = getChildBubbles(parent.id)
    expect(children).toHaveLength(2)
    const ids = children.map(c => c.id)
    expect(ids).toContain(child1.id)
    expect(ids).toContain(child2.id)
    expect(ids).not.toContain(unrelated.id)
  })

  it('returns empty array when no children exist', () => {
    const parent = createBubble(makeInput())
    expect(getChildBubbles(parent.id)).toHaveLength(0)
  })
})

// ── findRecentBySource ───────────────────────────────────────

describe('findRecentBySource', () => {
  it('finds recent bubbles by source within time window', () => {
    createBubble(makeInput({ source: 'import', title: '最近导入' }))
    createBubble(makeInput({ source: 'user', title: '用户创建' }))

    const results = findRecentBySource('import', Date.now() - 60000)
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].source).toBe('import')
  })

  it('returns empty when all records are older than sinceMs', async () => {
    const created = createBubble(makeInput({ source: 'import' }))
    // Query with sinceMs after creation time
    const recent = Date.now() + 10000
    const results = findRecentBySource('import', recent)
    expect(results).toHaveLength(0)
  })
})

// ── rowToBubble (pure function, no DB) ───────────────────────

describe('rowToBubble', () => {
  it('maps all fields correctly from a raw row', () => {
    const row = {
      id: 'test-id',
      type: 'entity' as const,
      title: '测试',
      content: '内容',
      metadata: JSON.stringify({ key: 'val' }),
      tags: JSON.stringify(['tag1']),
      embedding: JSON.stringify([0.1, 0.2]),
      source: 'user',
      confidence: 0.8,
      decay_rate: 0.2,
      pinned: 1,
      created_at: 1000,
      updated_at: 2000,
      accessed_at: 1500,
      space_id: 'space-1',
      abstraction_level: 1,
      summary: '摘要',
    }

    const bubble = rowToBubble(row as any)
    expect(bubble.id).toBe('test-id')
    expect(bubble.type).toBe('entity')
    expect(bubble.title).toBe('测试')
    expect(bubble.content).toBe('内容')
    expect(bubble.metadata).toEqual({ key: 'val' })
    expect(bubble.tags).toEqual(['tag1'])
    expect(bubble.embedding).toEqual([0.1, 0.2])
    expect(bubble.source).toBe('user')
    expect(bubble.confidence).toBe(0.8)
    expect(bubble.decayRate).toBe(0.2)
    expect(bubble.pinned).toBe(true)
    expect(bubble.createdAt).toBe(1000)
    expect(bubble.updatedAt).toBe(2000)
    expect(bubble.accessedAt).toBe(1500)
    expect(bubble.spaceId).toBe('space-1')
    expect(bubble.abstractionLevel).toBe(1)
    expect(bubble.summary).toBe('摘要')
    expect(bubble.links).toEqual([])
  })

  it('handles null embedding and null spaceId', () => {
    const row = {
      id: 'test-id',
      type: 'entity' as const,
      title: '测试',
      content: '内容',
      metadata: '{}',
      tags: '[]',
      embedding: null,
      source: 'system',
      confidence: 1.0,
      decay_rate: 0.1,
      pinned: 0,
      created_at: 1000,
      updated_at: 1000,
      accessed_at: 1000,
      space_id: null,
      abstraction_level: 0,
      summary: null,
    }

    const bubble = rowToBubble(row as any)
    expect(bubble.embedding).toBeUndefined()
    expect(bubble.spaceId).toBeUndefined()
    expect(bubble.summary).toBeUndefined()
    expect(bubble.pinned).toBe(false)
  })
})
