import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { ulid } from 'ulid'
import { shouldUsePlanMode, classifyFailure, generatePlan, startPlan } from '../src/workflow/planner.js'
import { executePlan, formatExecutorReport } from '../src/workflow/executor.js'
import { createFixtureLLM } from './fixture-llm.js'
import type { ExecutionPlan } from '../src/workflow/planner.js'

let tmpDir: string
let spaceId: string
let userId: string

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-planner-'))
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

describe('shouldUsePlanMode — 计划模式检测', () => {
  it('明确请求分步触发', () => {
    expect(shouldUsePlanMode('帮我分步完成')).toBe(true)
    expect(shouldUsePlanMode('制定计划')).toBe(true)
    expect(shouldUsePlanMode('计划一下这个任务')).toBe(true)
    expect(shouldUsePlanMode('帮我拆解')).toBe(true)
    expect(shouldUsePlanMode('分步骤处理')).toBe(true)
  })

  it('多步骤标记触发', () => {
    expect(shouldUsePlanMode('查找A然后创建B再导入C最后导出报表')).toBe(true)
  })

  it('3 个以上动作动词触发', () => {
    expect(shouldUsePlanMode('帮我查找资料创建记录生成报告')).toBe(true)
    expect(shouldUsePlanMode('搜索信息下载文件统计分析')).toBe(true)
  })

  it('2 个或更少动作动词不触发', () => {
    expect(shouldUsePlanMode('帮我搜索一下')).toBe(false)
    expect(shouldUsePlanMode('查一下价格')).toBe(false)
    expect(shouldUsePlanMode('你好')).toBe(false)
  })

  it('普通查询不触发', () => {
    expect(shouldUsePlanMode('今天天气怎么样')).toBe(false)
    expect(shouldUsePlanMode('螺纹钢价格多少')).toBe(false)
    expect(shouldUsePlanMode('帮我查一下张三的付款记录')).toBe(false)
  })

  it('空文本不触发', () => {
    expect(shouldUsePlanMode('')).toBe(false)
  })

  it('边界：刚好 3 个动词触发', () => {
    expect(shouldUsePlanMode('查找A创建B更新C')).toBe(true)
  })
})

describe('classifyFailure — 失败策略分类', () => {
  it('超时错误 → retry', () => {
    expect(classifyFailure('request timeout', { id: 's1', description: '查询', status: 'pending' })).toBe('retry')
    expect(classifyFailure('ECONNRESET', { id: 's1', description: '查询', status: 'pending' })).toBe('retry')
    expect(classifyFailure('rate limit exceeded', { id: 's1', description: '查询', status: 'pending' })).toBe('retry')
    expect(classifyFailure('ETIMEDOUT', { id: 's1', description: '查询', status: 'pending' })).toBe('retry')
  })

  it('数据异常 → halt_report', () => {
    expect(classifyFailure('not found', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
    expect(classifyFailure('404', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
    expect(classifyFailure('无数据', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
    expect(classifyFailure('不存在', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
  })

  it('不可逆操作失败 → halt_absolute', () => {
    expect(classifyFailure('错误', { id: 's1', description: '删除记录', status: 'pending' })).toBe('halt_absolute')
    expect(classifyFailure('错误', { id: 's1', description: 'delete data', status: 'pending' })).toBe('halt_absolute')
    expect(classifyFailure('错误', { id: 's1', description: 'drop table', status: 'pending' })).toBe('halt_absolute')
    expect(classifyFailure('错误', { id: 's1', description: 'remove file', status: 'pending' })).toBe('halt_absolute')
  })

  it('其他错误默认 halt_report', () => {
    expect(classifyFailure('未知错误', { id: 's1', description: '普通操作', status: 'pending' })).toBe('halt_report')
    expect(classifyFailure('permission denied', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
  })

  it('空错误字符串', () => {
    expect(classifyFailure('', { id: 's1', description: '查询', status: 'pending' })).toBe('halt_report')
  })
})

describe('generatePlan — LLM 计划生成（fixture stub 模式）', () => {
  it('LLM 返回无效 JSON 时回退为单步计划', async () => {
    const llm = createFixtureLLM('planner-fallback')
    // 在 fixture stub 模式下，LLM 返回非 JSON 文本
    // generatePlan 应优雅降级为单步 fallback
    const plan = await generatePlan('测试任务', llm)
    expect(plan.goal).toBe('测试任务')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
    expect(plan.steps[0].status).toBe('pending')
    expect(['sequential', 'parallel']).toContain(plan.execution)
  })

  it('带上下文信息不报错', async () => {
    const llm = createFixtureLLM('planner-context')
    const plan = await generatePlan('分析数据', llm, '现有数据：上月销售额100万')
    expect(plan.goal).toBe('分析数据')
    expect(plan.steps.length).toBeGreaterThanOrEqual(1)
  })
})

describe('startPlan — 创建 TaskLedger', () => {
  it('创建包含计划的 ledger', async () => {
    const plan: ExecutionPlan = {
      goal: '集成测试计划',
      steps: [
        { id: 'step_1', description: '第一步', status: 'pending' },
        { id: 'step_2', description: '第二步', status: 'pending', dependsOn: ['step_1'] },
      ],
      execution: 'sequential',
    }

    const result = await startPlan(plan, { userId, activeSpaceId: spaceId, displayName: 'test' })
    expect(result.ledgerId).toBeTruthy()
    expect(result.plan.goal).toBe('集成测试计划')
    expect(result.plan.steps.length).toBe(2)
  })

  it('空计划创建成功', async () => {
    const plan: ExecutionPlan = {
      goal: '空计划',
      steps: [],
      execution: 'sequential',
    }
    const result = await startPlan(plan, { userId, activeSpaceId: spaceId, displayName: 'test' })
    expect(result.ledgerId).toBeTruthy()
  })
})

describe('formatExecutorReport — 执行报告格式化', () => {
  it('全部完成', () => {
    const plan: ExecutionPlan = {
      goal: '测试',
      steps: [
        { id: 's1', description: '步骤1', status: 'completed' },
        { id: 's2', description: '步骤2', status: 'completed' },
      ],
      execution: 'sequential',
    }
    const report = formatExecutorReport(
      { completed: true, stepsExecuted: 2, results: [
        { stepId: 's1', success: true, output: 'ok' },
        { stepId: 's2', success: true, output: 'ok' },
      ]},
      plan,
    )
    expect(report).toContain('已完成')
    expect(report).toContain('步骤1')
    expect(report).toContain('步骤2')
  })

  it('部分失败', () => {
    const plan: ExecutionPlan = {
      goal: '失败测试',
      steps: [
        { id: 's1', description: '成功步骤', status: 'completed' },
        { id: 's2', description: '失败步骤', status: 'failed' },
      ],
      execution: 'sequential',
    }
    const report = formatExecutorReport(
      { completed: false, stepsExecuted: 2, results: [
        { stepId: 's1', success: true, output: 'ok' },
        { stepId: 's2', success: false, output: '', error: '出错了' },
      ], abortReason: '数据异常' },
      plan,
    )
    expect(report).toContain('已暂停')
    expect(report).toContain('数据异常')
    expect(report).toContain('[FAIL]')
  })

  it('空步骤列表', () => {
    const plan: ExecutionPlan = {
      goal: '空',
      steps: [],
      execution: 'sequential',
    }
    const report = formatExecutorReport(
      { completed: true, stepsExecuted: 0, results: [] },
      plan,
    )
    expect(report).toContain('已完成')
  })
})
