import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDraft, listDrafts, confirmDraft, rejectDraft, countDrafts } from '../src/memory/draft-observations.js'
import { getBubble } from '../src/bubble/model.js'
import { ulid } from 'ulid'

let tmpDir: string
let spaceId: string
let spaceId2: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-draft-'))
  initDatabase(tmpDir, 'test-password-123')
  // Grab real space IDs for FK constraints
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
  // Create a second space for filtering tests
  spaceId2 = ulid()
  db.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(spaceId2, '测试空间2', '二区', Date.now())
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM draft_observations').run()
  db.prepare('DELETE FROM bubbles').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── createDraft ───────────────────────────────────────────────────

describe('createDraft', () => {
  it('创建并返回 draft', () => {
    const draft = createDraft({ content: '测试观察', source: 'reflector', spaceId })
    expect(draft.id).toBeTruthy()
    expect(draft.content).toBe('测试观察')
    expect(draft.source).toBe('reflector')
    expect(draft.spaceId).toBe(spaceId)
    expect(draft.createdAt).toBeGreaterThan(0)
    expect(draft.context).toBe('')
  })

  it('支持 context 参数', () => {
    const draft = createDraft({ content: 'C', source: 'S', context: '会话上下文', spaceId })
    expect(draft.context).toBe('会话上下文')
  })

  it('实际写入数据库', () => {
    const draft = createDraft({ content: 'DB 测试', source: 'test', spaceId })
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM draft_observations WHERE id = ?').get(draft.id) as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row!.content).toBe('DB 测试')
  })
})

// ── listDrafts ────────────────────────────────────────────────────

describe('listDrafts', () => {
  it('返回全部 drafts 按创建时间倒序', async () => {
    createDraft({ content: '旧', source: 's', spaceId })
    await new Promise(r => setTimeout(r, 5))
    createDraft({ content: '新', source: 's', spaceId })

    const list = listDrafts()
    expect(list).toHaveLength(2)
    expect(list[0].content).toBe('新') // DESC
    expect(list[1].content).toBe('旧')
  })

  it('按 spaceId 过滤', () => {
    createDraft({ content: '空间A', source: 's', spaceId })
    createDraft({ content: '空间B', source: 's', spaceId: spaceId2 })

    const list = listDrafts(spaceId)
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('空间A')
  })

  it('空表返回空数组', () => {
    expect(listDrafts()).toEqual([])
  })
})

// ── confirmDraft ──────────────────────────────────────────────────

describe('confirmDraft', () => {
  it('确认后创建 observation bubble 并删除 draft', () => {
    const draft = createDraft({ content: '待确认的观察内容', source: 'reflector', spaceId })
    const obsId = confirmDraft(draft.id)

    expect(obsId).not.toBeNull()
    // Draft deleted
    expect(listDrafts()).toHaveLength(0)
    // Bubble created with correct content
    const bubble = getBubble(obsId!)
    expect(bubble).not.toBeNull()
    expect(bubble!.type).toBe('observation')
    expect(bubble!.content).toBe('待确认的观察内容')
    expect(bubble!.tags).toContain('auto-draft-reviewed')
    expect(bubble!.source).toBe('auto-draft-reviewed')
    expect(bubble!.spaceId).toBe(spaceId)
  })

  it('draft 不存在返回 null', () => {
    expect(confirmDraft('nonexistent')).toBeNull()
  })
})

// ── rejectDraft ───────────────────────────────────────────────────

describe('rejectDraft', () => {
  it('拒绝并删除 draft 返回 true', () => {
    const draft = createDraft({ content: '待拒绝', source: 's', spaceId })
    expect(rejectDraft(draft.id)).toBe(true)
    expect(listDrafts()).toHaveLength(0)
  })

  it('draft 不存在返回 false', () => {
    expect(rejectDraft('nonexistent')).toBe(false)
  })
})

// ── countDrafts ───────────────────────────────────────────────────

describe('countDrafts', () => {
  it('返回正确数量', () => {
    createDraft({ content: 'a', source: 's', spaceId })
    createDraft({ content: 'b', source: 's', spaceId })
    expect(countDrafts()).toBe(2)
  })

  it('按 spaceId 过滤计数', () => {
    createDraft({ content: 'a', source: 's', spaceId })
    createDraft({ content: 'b', source: 's', spaceId: spaceId2 })
    expect(countDrafts(spaceId)).toBe(1)
    expect(countDrafts(spaceId2)).toBe(1)
    expect(countDrafts()).toBe(2)
  })

  it('空表返回 0', () => {
    expect(countDrafts()).toBe(0)
  })
})
