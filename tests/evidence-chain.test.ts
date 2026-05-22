import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBubble } from '../src/bubble/model.js'
import { addLink } from '../src/bubble/links.js'
import { buildEvidenceChain } from '../src/memory/evidence-chain.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-evid-'))
  initDatabase(tmpDir, 'test-password-123')
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_links').run()
  db.prepare('DELETE FROM bubbles').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── 基础 ──────────────────────────────────────────────────────────

describe('buildEvidenceChain — 基础', () => {
  it('不存在的 bubble 返回 null', () => {
    expect(buildEvidenceChain('nonexistent')).toBeNull()
  })

  it('无链接的 bubble 返回空 nodes', () => {
    const b = createBubble({ type: 'observation', title: '孤立', content: '无依赖' })
    const tree = buildEvidenceChain(b.id)!
    expect(tree.root.id).toBe(b.id)
    expect(tree.totalCount).toBe(0)
    expect(tree.nodes).toHaveLength(0)
  })

  it('直接 composed_of 链接', () => {
    const parent = createBubble({ type: 'concept', title: '父', content: '父概念' })
    const child = createBubble({ type: 'observation', title: '子', content: '子证据' })
    addLink(child.id, parent.id, 'composed_of')

    const tree = buildEvidenceChain(parent.id)!
    expect(tree.totalCount).toBe(1)
    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0].bubble.id).toBe(child.id)
    expect(tree.nodes[0].relation).toBe('composed_of')
    expect(tree.nodes[0].depth).toBe(1)
  })

  it('references 链接可被追踪', () => {
    const target = createBubble({ type: 'concept', title: '目标', content: '被引用' })
    const ref = createBubble({ type: 'observation', title: '引用者', content: '引用' })
    addLink(ref.id, target.id, 'references')

    const tree = buildEvidenceChain(target.id)!
    expect(tree.totalCount).toBe(1)
    expect(tree.nodes[0].relation).toBe('references')
  })
})

// ── 多层与多人 ─────────────────────────────────────────────────────

describe('buildEvidenceChain — 多层与多子', () => {
  it('supports 链接可被追踪', () => {
    const target = createBubble({ type: 'concept', title: '被支持', content: 'x' })
    const supporter = createBubble({ type: 'observation', title: '支持者', content: 'y' })
    addLink(supporter.id, target.id, 'supports')

    const tree = buildEvidenceChain(target.id)!
    expect(tree.totalCount).toBe(1)
    expect(tree.nodes[0].relation).toBe('supports')
  })

  it('一个 parent 有多个证据子节点', () => {
    const parent = createBubble({ type: 'concept', title: '根', content: '根概念' })
    const c1 = createBubble({ type: 'observation', title: '证据1', content: 'e1' })
    const c2 = createBubble({ type: 'observation', title: '证据2', content: 'e2' })
    const c3 = createBubble({ type: 'observation', title: '证据3', content: 'e3' })
    addLink(c1.id, parent.id, 'composed_of')
    addLink(c2.id, parent.id, 'references')
    addLink(c3.id, parent.id, 'supports')

    const tree = buildEvidenceChain(parent.id)!
    expect(tree.totalCount).toBe(3)
    expect(tree.nodes).toHaveLength(3)
  })

  it('递归多层深度 (A→B→C)', () => {
    const a = createBubble({ type: 'concept', title: 'A', content: '顶层' })
    const b = createBubble({ type: 'concept', title: 'B', content: '中层' })
    const c = createBubble({ type: 'observation', title: 'C', content: '底层' })
    addLink(b.id, a.id, 'composed_of')
    addLink(c.id, b.id, 'composed_of')

    const tree = buildEvidenceChain(a.id)!
    expect(tree.totalCount).toBe(2)
    expect(tree.nodes).toHaveLength(1)       // B at depth 1
    expect(tree.nodes[0].bubble.id).toBe(b.id)
    expect(tree.nodes[0].children).toHaveLength(1) // C at depth 2
    expect(tree.nodes[0].children[0].bubble.id).toBe(c.id)
    expect(tree.nodes[0].children[0].depth).toBe(2)
  })

  it('maxDepth=1 阻止任何子节点展开', () => {
    const a = createBubble({ type: 'concept', title: 'A', content: '' })
    const b = createBubble({ type: 'concept', title: 'B', content: '' })
    addLink(b.id, a.id, 'composed_of')

    // walk(bubbleId, 1), depth(1) >= maxDepth(1) → no expansion
    const tree = buildEvidenceChain(a.id, 1)!
    expect(tree.totalCount).toBe(0)
  })

  it('maxDepth=2 允许一层子节点', () => {
    const a = createBubble({ type: 'concept', title: 'A', content: '' })
    const b = createBubble({ type: 'concept', title: 'B', content: '' })
    const c = createBubble({ type: 'observation', title: 'C', content: '' })
    addLink(b.id, a.id, 'composed_of')
    addLink(c.id, b.id, 'composed_of')

    const tree = buildEvidenceChain(a.id, 2)!
    expect(tree.totalCount).toBe(1) // B is included, C stopped at depth 2 >= 2
    expect(tree.nodes[0].bubble.id).toBe(b.id)
    expect(tree.nodes[0].children).toHaveLength(0) // C not expanded
  })
})

// ── 边界 ──────────────────────────────────────────────────────────

describe('buildEvidenceChain — 边界', () => {
  it('链接指向不存在的 bubble 被跳过', () => {
    const parent = createBubble({ type: 'concept', title: '父', content: '' })
    const db = getDatabase()
    // Disable FK to simulate orphan link (e.g. bubble was deleted)
    db.prepare('PRAGMA foreign_keys = OFF').run()
    db.prepare('INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('ghost', parent.id, 'composed_of', 1.0, 'system', Date.now())
    db.prepare('PRAGMA foreign_keys = ON').run()

    const tree = buildEvidenceChain(parent.id)!
    // ghost bubble doesn't exist → getBubble returns null → skipped
    expect(tree.totalCount).toBe(0)
  })

  it('环形链接不会死循环 (A→B→A)', () => {
    const a = createBubble({ type: 'concept', title: 'A', content: '' })
    const b = createBubble({ type: 'concept', title: 'B', content: '' })
    addLink(b.id, a.id, 'composed_of') // A ← B
    addLink(a.id, b.id, 'composed_of') // B ← A (cycle)

    const tree = buildEvidenceChain(a.id)!
    // B is found as child of A, but when walking B, A is in visited → skipped
    expect(tree.totalCount).toBe(1)
    expect(tree.nodes).toHaveLength(1)
    expect(tree.nodes[0].bubble.id).toBe(b.id)
    expect(tree.nodes[0].children).toHaveLength(0) // A already visited
  })
})

// ── 元数据 ────────────────────────────────────────────────────────

describe('buildEvidenceChain — 元数据', () => {
  it('sourceBreakdown 按 source 聚合', () => {
    const parent = createBubble({ type: 'concept', title: '根', content: '' })
    const s1 = createBubble({ type: 'observation', title: 's1', content: '', source: 'user' })
    const s2 = createBubble({ type: 'observation', title: 's2', content: '', source: 'user' })
    const s3 = createBubble({ type: 'observation', title: 's3', content: '', source: 'llm' })
    addLink(s1.id, parent.id, 'composed_of')
    addLink(s2.id, parent.id, 'references')
    addLink(s3.id, parent.id, 'supports')

    const tree = buildEvidenceChain(parent.id)!
    expect(tree.sourceBreakdown).toEqual({ user: 2, llm: 1 })
  })

  it('oldestEvidence / newestEvidence 正确', () => {
    const parent = createBubble({ type: 'concept', title: '根', content: '' })
    const old = createBubble({ type: 'observation', title: '旧', content: '' })
    const young = createBubble({ type: 'observation', title: '新', content: '' })

    // Override createdAt by direct DB insert for precise control
    const db = getDatabase()
    db.prepare('UPDATE bubbles SET created_at = ? WHERE id = ?').run(1000, old.id)
    db.prepare('UPDATE bubbles SET created_at = ? WHERE id = ?').run(9999, young.id)

    addLink(old.id, parent.id, 'composed_of')
    addLink(young.id, parent.id, 'references')

    const tree = buildEvidenceChain(parent.id)!
    expect(tree.oldestEvidence).toBe(1000)
    expect(tree.newestEvidence).toBe(9999)
  })

  it('无子节点时 oldestEvidence = root.createdAt', () => {
    const root = createBubble({ type: 'concept', title: '孤', content: '' })
    const db = getDatabase()
    db.prepare('UPDATE bubbles SET created_at = ? WHERE id = ?').run(5000, root.id)

    const tree = buildEvidenceChain(root.id)!
    expect(tree.oldestEvidence).toBe(5000)
    expect(tree.newestEvidence).toBe(5000)
  })
})
