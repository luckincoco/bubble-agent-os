import cron, { type ScheduledTask } from 'node-cron'
import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import type { ToolRegistry } from '../connector/registry.js'
import type { LLMProvider } from '../shared/types.js'
import type { FeishuConnector } from '../connector/feishu.js'
import { executeDailyDigest } from './tasks/daily-digest.js'
import { executeKeywordMonitor } from './tasks/keyword-monitor.js'
import { executeMemoryDecay } from './tasks/memory-decay.js'

export type ScheduledTaskType = 'daily_digest' | 'keyword_monitor' | 'memory_decay'

export interface TaskDeps {
  brain: Brain
  memory: MemoryManager
  tools: ToolRegistry
  llm: LLMProvider
  feishu?: FeishuConnector
}

export interface TaskResult {
  success: boolean
  message: string
  bubbleIds?: string[]
}

interface ScheduledTaskRow {
  id: string
  name: string
  type: string
  cron: string
  params: string
  enabled: number
  last_run: number | null
  next_run: number | null
  created_at: number
  updated_at: number
}

type TaskExecutor = (params: Record<string, unknown>, deps: TaskDeps) => Promise<TaskResult>

const EXECUTORS: Record<ScheduledTaskType, TaskExecutor> = {
  daily_digest: executeDailyDigest,
  keyword_monitor: executeKeywordMonitor,
  memory_decay: executeMemoryDecay,
}

export class TaskScheduler {
  private deps: TaskDeps
  private jobs = new Map<string, ScheduledTask>()

  constructor(deps: TaskDeps) {
    this.deps = deps
  }

  async init(): Promise<void> {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM scheduled_tasks WHERE enabled = 1').all() as ScheduledTaskRow[]

    for (const row of rows) {
      this.scheduleJob(row)
    }

    // Seed default tasks if table is empty
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM scheduled_tasks').get() as { cnt: number }).cnt
    if (count === 0) {
      this.seedDefaults()
    }

    logger.info(`Scheduler: ${this.jobs.size} active jobs loaded`)
  }

  private seedDefaults() {
    const db = getDatabase()
    const now = Date.now()
    const defaults = [
      { name: '每日数据摘要', type: 'daily_digest', cron: '0 8 * * *', params: '{}', enabled: 0 },
      { name: '记忆衰减清理', type: 'memory_decay', cron: '0 3 * * *', params: '{}', enabled: 0 },
      { name: '关键词监控', type: 'keyword_monitor', cron: '0 */6 * * *', params: '{"keywords":[]}', enabled: 0 },
    ]

    const stmt = db.prepare(
      'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const d of defaults) {
      stmt.run(ulid(), d.name, d.type, d.cron, d.params, d.enabled, now, now)
    }
    logger.info('Scheduler: seeded 3 default tasks (disabled)')
  }

  private scheduleJob(row: ScheduledTaskRow) {
    if (!cron.validate(row.cron)) {
      logger.warn(`Scheduler: invalid cron "${row.cron}" for task ${row.name}, skipping`)
      return
    }

    const job = cron.schedule(row.cron, () => {
      this.runTask(row.id).catch(err =>
        logger.error(`Scheduler task ${row.name} failed:`, err instanceof Error ? err.message : String(err)),
      )
    }, { timezone: 'Asia/Shanghai' })

    this.jobs.set(row.id, job)
  }

  private async runTask(id: string): Promise<TaskResult> {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow | undefined
    if (!row) return { success: false, message: 'Task not found' }

    const executor = EXECUTORS[row.type as ScheduledTaskType]
    if (!executor) return { success: false, message: `Unknown task type: ${row.type}` }

    const params = JSON.parse(row.params || '{}')
    logger.info(`Scheduler: running task "${row.name}" (${row.type})`)

    const result = await executor(params, this.deps)

    db.prepare('UPDATE scheduled_tasks SET last_run = ?, updated_at = ? WHERE id = ?')
      .run(Date.now(), Date.now(), id)

    logger.info(`Scheduler: task "${row.name}" ${result.success ? 'succeeded' : 'failed'}: ${result.message}`)
    return result
  }

  async addTask(name: string, type: ScheduledTaskType, cronExpr: string, params: Record<string, unknown> = {}): Promise<string> {
    if (!cron.validate(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`)
    if (!EXECUTORS[type]) throw new Error(`Unknown task type: ${type}`)

    const db = getDatabase()
    const id = ulid()
    const now = Date.now()

    db.prepare(
      'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, type, cronExpr, JSON.stringify(params), 1, now, now)

    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow
    this.scheduleJob(row)

    return id
  }

  updateTask(id: string, updates: { name?: string; cron?: string; params?: Record<string, unknown>; enabled?: boolean }) {
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow | undefined
    if (!row) throw new Error('Task not found')

    if (updates.cron && !cron.validate(updates.cron)) {
      throw new Error(`Invalid cron expression: ${updates.cron}`)
    }

    const sets: string[] = []
    const vals: unknown[] = []

    if (updates.name != null) { sets.push('name = ?'); vals.push(updates.name) }
    if (updates.cron != null) { sets.push('cron = ?'); vals.push(updates.cron) }
    if (updates.params != null) { sets.push('params = ?'); vals.push(JSON.stringify(updates.params)) }
    if (updates.enabled != null) { sets.push('enabled = ?'); vals.push(updates.enabled ? 1 : 0) }
    sets.push('updated_at = ?'); vals.push(Date.now())
    vals.push(id)

    db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals)

    // Re-schedule
    const existing = this.jobs.get(id)
    if (existing) { existing.stop(); this.jobs.delete(id) }

    const updated = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as ScheduledTaskRow
    if (updated.enabled) this.scheduleJob(updated)
  }

  removeTask(id: string) {
    const existing = this.jobs.get(id)
    if (existing) { existing.stop(); this.jobs.delete(id) }

    const db = getDatabase()
    db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
  }

  listTasks() {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at').all() as ScheduledTaskRow[]
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      type: r.type,
      cron: r.cron,
      params: JSON.parse(r.params || '{}'),
      enabled: r.enabled === 1,
      lastRun: r.last_run,
      nextRun: r.next_run,
      createdAt: r.created_at,
    }))
  }

  async executeNow(id: string): Promise<TaskResult> {
    return this.runTask(id)
  }

  stop() {
    for (const [id, job] of this.jobs) {
      job.stop()
      this.jobs.delete(id)
    }
    logger.info('Scheduler: all jobs stopped')
  }
}
