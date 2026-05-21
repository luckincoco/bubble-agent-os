import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { ulid } from 'ulid'
import {
  createLedger, getLedger, getActiveLedger, updateLedgerStatus,
  addCheckpoint, setPendingAction, updateEpisodeWindow, updatePlanSteps,
  buildLedgerContext, detectResumption,
} from '../src/temporal/task-ledger.js'
import type { PlanStep } from '../src/temporal/task-ledger.js'

let tmpDir: string
let spaceId: string
let userId: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-ledger-'))
  initDatabase(tmpDir, 'test-password-123')

  const db = getDatabase()
  const now = Date.now()
  const hash = bcrypt.hashSync('test-password-123', 10)
  userId = ulid()
  spaceId = ulid()
  db.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(spaceId, '测试空间', '测试空间', now)
  db.prepare('INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(userId, 'testuser', hash, '测试用户', 'admin', now)
  db.prepare('INSERT INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(userId, spaceId)
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('TaskLedger — 创建与查询', () => {
  it('创建 ledger', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '测试任务' })
    expect(ledger.id).toBeTruthy()
    expect(ledger.goal).toBe('测试任务')
    expect(ledger.status).toBe('active')
    expect(ledger.planSteps).toEqual([])
    expect(ledger.checkpoints).toEqual([])
    expect(ledger.pendingAction).toBeNull()
    expect(ledger.ttl).toBeGreaterThan(0)
  })

  it('通过 id 获取 ledger', () => {
    const created = createLedger({ spaceId, actorId: userId, goal: '查询任务' })
    const found = getLedger(created.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.goal).toBe('查询任务')
  })

  it('不存在的 id 返回 null', () => {
    expect(getLedger('NONEXISTENT')).toBeNull()
  })

  it('创建时支持初始 plan steps', () => {
    const steps: PlanStep[] = [
      { id: 's1', description: '第一步', status: 'pending' },
      { id: 's2', description: '第二步', status: 'pending', dependsOn: ['s1'] },
    ]
    const ledger = createLedger({ spaceId, actorId: userId, goal: '多步骤任务', planSteps: steps })
    expect(ledger.planSteps.length).toBe(2)
    expect(ledger.planSteps[0].description).toBe('第一步')
    expect(ledger.planSteps[1].dependsOn).toEqual(['s1'])
  })

  it('获取活跃 ledger 返回最近更新的那条', () => {
    createLedger({ spaceId, actorId: userId, goal: '旧任务' })
    // 短暂延时确保时间戳不同
    const newer = createLedger({ spaceId, actorId: userId, goal: '新任务' })
    const active = getActiveLedger(spaceId, userId)
    expect(active).not.toBeNull()
    expect(active!.goal).toBe('新任务')
  })

  it('不存在活跃 ledger 返回 null', () => {
    const result = getActiveLedger('nonexistent-space', userId)
    expect(result).toBeNull()
  })
})

describe('TaskLedger — 状态管理', () => {
  it('更新状态', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '状态测试' })
    updateLedgerStatus(ledger.id, 'paused')
    expect(getLedger(ledger.id)!.status).toBe('paused')
  })

  it('设为 completed 后不再出现在活跃查询', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '完成测试' })
    updateLedgerStatus(ledger.id, 'completed')
    const active = getActiveLedger(spaceId, userId)
    if (active) {
      expect(active.id).not.toBe(ledger.id)
    }
  })

  it('状态流转：active → paused → completed', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '流转测试' })
    expect(ledger.status).toBe('active')
    updateLedgerStatus(ledger.id, 'paused')
    expect(getLedger(ledger.id)!.status).toBe('paused')
    updateLedgerStatus(ledger.id, 'completed')
    expect(getLedger(ledger.id)!.status).toBe('completed')
  })

  it('过期 TTL 后不再活跃', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '过期任务', ttl: -1 })
    const active = getActiveLedger(spaceId, userId)
    if (active) {
      expect(active.id).not.toBe(ledger.id)
    }
    expect(getLedger(ledger.id)!.status).toBe('expired')
  })
})

describe('TaskLedger — Checkpoint 与 PendingAction', () => {
  it('添加 checkpoint 并更新步骤状态', () => {
    const steps: PlanStep[] = [
      { id: 'cp_step_1', description: '可检查的步骤', status: 'pending' },
    ]
    const ledger = createLedger({ spaceId, actorId: userId, goal: '检查点测试', planSteps: steps })

    addCheckpoint(ledger.id, { stepId: 'cp_step_1', completedAt: Date.now(), summary: '完成' })

    const updated = getLedger(ledger.id)!
    expect(updated.checkpoints.length).toBe(1)
    expect(updated.checkpoints[0].stepId).toBe('cp_step_1')
    expect(updated.planSteps[0].status).toBe('completed')
  })

  it('设置和清除 pending action', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '待办测试' })

    setPendingAction(ledger.id, {
      stepId: 'pa_1',
      description: '需要确认的操作',
      requiresConfirmation: true,
      createdAt: Date.now(),
    })

    let updated = getLedger(ledger.id)!
    expect(updated.pendingAction).not.toBeNull()
    expect(updated.pendingAction!.requiresConfirmation).toBe(true)
    expect(updated.pendingAction!.description).toBe('需要确认的操作')

    setPendingAction(ledger.id, null)
    updated = getLedger(ledger.id)!
    expect(updated.pendingAction).toBeNull()
  })

  it('不存在的 ledger 添加 checkpoint 不报错', () => {
    expect(() => addCheckpoint('NONEXISTENT', { stepId: 'x', completedAt: 0, summary: '' })).not.toThrow()
  })
})

describe('TaskLedger — EpisodeWindow', () => {
  it('首次更新设置 from 和 to 相同', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '时段测试' })
    updateEpisodeWindow(ledger.id, 'ep_1')
    const updated = getLedger(ledger.id)!
    expect(updated.episodeWindow).not.toBeNull()
    expect(updated.episodeWindow!.from).toBe('ep_1')
    expect(updated.episodeWindow!.to).toBe('ep_1')
  })

  it('后续更新只改变 to', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '时段测试2' })
    updateEpisodeWindow(ledger.id, 'ep_1')
    updateEpisodeWindow(ledger.id, 'ep_2')
    const updated = getLedger(ledger.id)!
    expect(updated.episodeWindow!.from).toBe('ep_1')
    expect(updated.episodeWindow!.to).toBe('ep_2')
  })
})

describe('TaskLedger — PlanSteps 更新', () => {
  it('替换 plan steps', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '步骤更新测试' })
    const newSteps: PlanStep[] = [
      { id: 'ns1', description: '新步骤1', status: 'pending' },
      { id: 'ns2', description: '新步骤2', status: 'pending' },
    ]
    updatePlanSteps(ledger.id, newSteps)
    const updated = getLedger(ledger.id)!
    expect(updated.planSteps.length).toBe(2)
    expect(updated.planSteps[0].description).toBe('新步骤1')
  })
})

describe('TaskLedger — 恢复检测', () => {
  it('检测继续意图', () => {
    expect(detectResumption('继续')).toBe(true)
    expect(detectResumption('接着做')).toBe(true)
    expect(detectResumption('上次的进度到哪里了')).toBe(true)
    expect(detectResumption('完成了吗')).toBe(true)
  })

  it('普通消息不触发', () => {
    expect(detectResumption('今天天气怎么样')).toBe(false)
    expect(detectResumption('查一下价格')).toBe(false)
    expect(detectResumption('你好')).toBe(false)
  })
})

describe('TaskLedger — 上下文注入', () => {
  it('构建含步骤的上下文', () => {
    const steps: PlanStep[] = [
      { id: 's1', description: '搜索资料', status: 'completed' },
      { id: 's2', description: '分析数据', status: 'completed' },
      { id: 's3', description: '生成报告', status: 'pending' },
    ]
    const ledger = createLedger({ spaceId, actorId: userId, goal: '报告生成', planSteps: steps })
    addCheckpoint(ledger.id, { stepId: 's1', completedAt: 1000, summary: '资料已搜' })
    addCheckpoint(ledger.id, { stepId: 's2', completedAt: 2000, summary: '数据已分析' })

    const context = buildLedgerContext(getLedger(ledger.id)!)
    expect(context).toContain('报告生成')
    expect(context).toContain('2/3')
    expect(context).toContain('生成报告')
  })

  it('构建含 pending action 的上下文', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '待确认任务' })
    setPendingAction(ledger.id, {
      stepId: 's1',
      description: '删除数据',
      requiresConfirmation: true,
      createdAt: Date.now(),
    })

    const context = buildLedgerContext(getLedger(ledger.id)!)
    expect(context).toContain('删除数据')
    expect(context).toContain('需用户确认')
  })

  it('无步骤的 ledger 上下文标记无明确步骤', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '简单任务' })
    const context = buildLedgerContext(getLedger(ledger.id)!)
    expect(context).toContain('无明确步骤')
  })

  it('空步骤上下文不报错', () => {
    const ledger = createLedger({ spaceId, actorId: userId, goal: '' })
    const context = buildLedgerContext(getLedger(ledger.id)!)
    expect(context).toBeTruthy()
  })
})
