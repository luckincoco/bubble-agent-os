import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createView, getViewById, getViewByName, getViewByRole, getAllViews, updateView, bindEntityToView, unbindEntityFromView, getViewsForEntity, resolveEffectiveView } from '../src/memory/view-registry.js'

let tmpDir: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-vreg-'))
  initDatabase(tmpDir, 'test-password-123')
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM view_bindings').run()
  db.prepare('DELETE FROM memory_views').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── CRUD ──────────────────────────────────────────────────────────

describe('View CRUD', () => {
  it('createView 创建并返回视图', () => {
    const v = createView({ name: '供应商视图', rolePattern: 'supplier', filters: { types: ['purchase'] }, priority: 10 })
    expect(v.id).toBeTruthy()
    expect(v.name).toBe('供应商视图')
    expect(v.rolePattern).toBe('supplier')
    expect(v.filters).toEqual({ types: ['purchase'] })
    expect(v.priority).toBe(10)
    expect(v.createdAt).toBeGreaterThan(0)
  })

  it('getViewById 返回视图', () => {
    const created = createView({ name: 'test', rolePattern: 'admin', filters: {} })
    const found = getViewById(created.id)
    expect(found).not.toBeNull()
    expect(found!.name).toBe('test')
  })

  it('getViewById 不存在返回 null', () => {
    expect(getViewById('nonexistent')).toBeNull()
  })

  it('getViewByName 返回视图', () => {
    createView({ name: '财务视图', rolePattern: 'finance', filters: { types: ['payment'] }, priority: 5 })
    const found = getViewByName('财务视图')
    expect(found).not.toBeNull()
    expect(found!.rolePattern).toBe('finance')
  })

  it('getViewByRole 返回最高优先级视图', () => {
    createView({ name: '低优先级', rolePattern: 'admin', filters: {}, priority: 1 })
    createView({ name: '高优先级', rolePattern: 'admin', filters: {}, priority: 100 })
    const found = getViewByRole('admin')
    expect(found!.name).toBe('高优先级')
  })

  it('getAllViews 返回全部视图按优先级排序', () => {
    createView({ name: 'B', rolePattern: 'b', filters: {}, priority: 50 })
    createView({ name: 'A', rolePattern: 'a', filters: {}, priority: 100 })
    const all = getAllViews()
    expect(all).toHaveLength(2)
    expect(all[0].name).toBe('A') // highest priority first
    expect(all[1].name).toBe('B')
  })

  it('updateView 更新字段', () => {
    const v = createView({ name: '旧名', rolePattern: 'x', filters: { types: ['a'] } })
    updateView(v.id, { name: '新名', priority: 99 })
    const updated = getViewById(v.id)!
    expect(updated.name).toBe('新名')
    expect(updated.priority).toBe(99)
    // Unchanged fields remain
    expect(updated.rolePattern).toBe('x')
  })

  it('updateView 空更新不报错', () => {
    const v = createView({ name: 'test', rolePattern: 'x', filters: {} })
    expect(() => updateView(v.id, {})).not.toThrow()
  })
})

// ── Bindings ──────────────────────────────────────────────────────

describe('View Bindings', () => {
  it('bindEntityToView 创建绑定', () => {
    const v = createView({ name: '视图', rolePattern: 'x', filters: {} })
    bindEntityToView('user', 'u1', v.id)
    const views = getViewsForEntity('user', 'u1')
    expect(views).toHaveLength(1)
    expect(views[0].id).toBe(v.id)
  })

  it('unbindEntityFromView 移除绑定', () => {
    const v = createView({ name: '视图', rolePattern: 'x', filters: {} })
    bindEntityToView('user', 'u1', v.id)
    unbindEntityFromView('user', 'u1', v.id)
    expect(getViewsForEntity('user', 'u1')).toHaveLength(0)
  })

  it('绑定按实体类型隔离', () => {
    const v = createView({ name: '视图', rolePattern: 'x', filters: {} })
    bindEntityToView('user', 'u1', v.id)
    // external_contact 看不到 user 的绑定
    expect(getViewsForEntity('external_contact', 'u1')).toHaveLength(0)
  })
})

// ── resolveEffectiveView ──────────────────────────────────────────

describe('resolveEffectiveView', () => {
  it('显式绑定优先于角色匹配', () => {
    createView({ name: '角色视图', rolePattern: 'supplier', filters: {}, priority: 50 })
    const bound = createView({ name: '绑定视图', rolePattern: 'supplier', filters: {}, priority: 10 })
    bindEntityToView('external_contact', 'ec1', bound.id)

    const result = resolveEffectiveView('external_contact', 'ec1', 'supplier')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('绑定视图') // bound view wins despite lower priority
  })

  it('无绑定回退到角色视图', () => {
    createView({ name: 'supplier 默认', rolePattern: 'supplier', filters: {}, priority: 1 })
    const result = resolveEffectiveView('external_contact', 'ec1', 'supplier')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('supplier 默认')
  })

  it('无绑无角色回退到 admin', () => {
    createView({ name: 'admin', rolePattern: 'admin', filters: {} })
    const result = resolveEffectiveView('user', 'u1')
    expect(result).not.toBeNull()
    expect(result!.name).toBe('admin')
  })
})

// ── snake_case → camelCase 转换 ───────────────────────────────────

describe('列名转换', () => {
  it('getAllViews 返回 camelCase 字段', () => {
    createView({ name: '测试', rolePattern: 'test', filters: { types: ['a'] } })
    const all = getAllViews()
    expect(all[0]).toHaveProperty('rolePattern')
    expect(all[0]).not.toHaveProperty('role_pattern')
    expect(all[0]).toHaveProperty('createdAt')
    expect(all[0]).not.toHaveProperty('created_at')
  })
})
