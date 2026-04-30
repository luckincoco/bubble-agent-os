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
import { executeBubbleCompaction } from './tasks/bubble-compaction.js'
import { executeSteelPrice } from './tasks/steel-price.js'
import { executeQuestionGenerator } from './tasks/question-generator.js'
import { executeReflection } from './tasks/reflection.js'
import { executePressureSim } from './tasks/pressure-sim.js'
import { executeSelfDialogue } from './tasks/self-dialogue.js'
import { executeFeedWatcher } from './tasks/feed-watcher.js'
import { executeInterestSearch } from './tasks/interest-search.js'
import { executeLearningDigest } from './tasks/learning-digest.js'
import { executeSilenceScan } from './tasks/silence-scan.js'
import { executeConcentrationScan } from './tasks/concentration-scan.js'
import { executeCausalEval } from './tasks/causal-eval.js'
import type { ModelRouter } from '../ai/model-router.js'

export type ScheduledTaskType = 'daily_digest' | 'keyword_monitor' | 'memory_decay' | 'bubble_compaction' | 'steel_price' | 'question_generator' | 'reflection' | 'pressure_sim' | 'self_dialogue' | 'feed_watcher' | 'interest_search' | 'learning_digest' | 'silence_scan' | 'concentration_scan' | 'causal_eval'

export interface TaskDeps {
  brain: Brain
  memory: MemoryManager
  tools: ToolRegistry
  llm: LLMProvider
  llmRouter?: ModelRouter
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
  bubble_compaction: executeBubbleCompaction,
  steel_price: executeSteelPrice,
  question_generator: executeQuestionGenerator,
  reflection: executeReflection,
  pressure_sim: executePressureSim,
  self_dialogue: executeSelfDialogue,
  feed_watcher: executeFeedWatcher,
  interest_search: executeInterestSearch,
  learning_digest: executeLearningDigest,
  silence_scan: executeSilenceScan,
  concentration_scan: executeConcentrationScan,
  causal_eval: executeCausalEval,
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

    // Ensure bubble_compaction task exists and is enabled (migration for existing installations)
    const compactionRow = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'bubble_compaction'").get() as ScheduledTaskRow | undefined
    if (!compactionRow) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '泡泡蒸馏引擎', 'bubble_compaction', '0 4 * * *', '{}', 1, now, now)
      const newRow = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'bubble_compaction'").get() as ScheduledTaskRow
      this.scheduleJob(newRow)
      logger.info('Scheduler: seeded bubble_compaction task (enabled, daily 4:00)')
    } else if (!compactionRow.enabled) {
      // Migration: enable previously disabled compaction task
      db.prepare('UPDATE scheduled_tasks SET enabled = 1, name = ?, updated_at = ? WHERE id = ?')
        .run('泡泡蒸馏引擎', Date.now(), compactionRow.id)
      const updatedRow = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(compactionRow.id) as ScheduledTaskRow
      this.scheduleJob(updatedRow)
      logger.info('Scheduler: migration — enabled bubble_compaction task')
    }

    // Ensure steel_price task exists (Mon-Fri 8:30 AM)
    const hasSteelPrice = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'steel_price'").get()
    if (!hasSteelPrice) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '钢材价格抓取', 'steel_price', '30 9 * * 1-5', '{}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'steel_price'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded steel_price task (Mon-Fri 9:30)')
    }

    // Ensure question_generator task exists (daily 8:00 AM)
    const hasQuestionGen = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'question_generator'").get()
    if (!hasQuestionGen) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '问题发现引擎', 'question_generator', '0 8 * * *', '{"lookbackDays":7,"silenceDays":14}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'question_generator'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded question_generator task (daily 8:00)')
    }

    // Ensure reflection task exists (daily 5:00 AM — runs after compaction at 4:00)
    const hasReflection = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'reflection'").get()
    if (!hasReflection) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '反思引擎', 'reflection', '0 5 * * *', '{}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'reflection'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded reflection task (daily 5:00)')
    }

    // Ensure causal_eval task exists (daily 4:30 AM — between compaction and reflection)
    const hasCausalEval = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'causal_eval'").get()
    if (!hasCausalEval) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '因果评估器', 'causal_eval', '30 4 * * *', '{}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'causal_eval'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded causal_eval task (daily 4:30)')
    }

    // Ensure pressure_sim task exists (disabled, manual-only)
    const hasPressureSim = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'pressure_sim'").get()
    if (!hasPressureSim) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '压力模拟器', 'pressure_sim', '0 0 31 2 *', '{}', 0, now, now)
      logger.info('Scheduler: seeded pressure_sim task (disabled, manual-only)')
    }

    // Ensure self_dialogue task exists (every 6 hours)
    const hasSelfDialogue = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'self_dialogue'").get()
    if (!hasSelfDialogue) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '自对话引擎', 'self_dialogue', '0 */6 * * *', '{"maxQuestions":3}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'self_dialogue'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded self_dialogue task (every 6h)')
    }

    // Ensure feed_watcher task exists (every 4 hours)
    const hasFeedWatcher = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'feed_watcher'").get()
    if (!hasFeedWatcher) {
      const now = Date.now()
      const feedParams = JSON.stringify({
        feeds: [
          { id: 'arxiv-ai', name: 'arXiv AI 论文', type: 'rss', url: 'https://rss.arxiv.org/rss/cs.AI', tags: ['ai', 'research'], enabled: true },
          { id: 'arxiv-cl', name: 'arXiv NLP 论文', type: 'rss', url: 'https://rss.arxiv.org/rss/cs.CL', tags: ['ai', 'nlp'], enabled: true },
          { id: 'hf-blog', name: 'Hugging Face 博客', type: 'rss', url: 'https://huggingface.co/blog/feed.xml', tags: ['ai', 'opensource'], enabled: true },
          { id: 'hn-best', name: 'Hacker News 精选', type: 'rss', url: 'https://hnrss.org/best', tags: ['tech', 'community'], enabled: true },
          { id: 'aeon', name: 'Aeon 思想散文', type: 'rss', url: 'https://aeon.co/feed.rss', tags: ['philosophy', 'essay'], enabled: true },
          { id: 'marginalian', name: 'The Marginalian', type: 'rss', url: 'https://www.themarginalian.org/feed/', tags: ['philosophy', 'interdisciplinary'], enabled: true },
          { id: 'sep', name: '斯坦福哲学百科', type: 'rss', url: 'https://plato.stanford.edu/rss/sep.xml', tags: ['philosophy', 'academic'], enabled: true },
        ],
        maxItemsPerFeed: 10,
        maxContentLength: 2000,
        surpriseThreshold: 0.3,
      })
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '外部信息订阅', 'feed_watcher', '0 */4 * * *', feedParams, 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'feed_watcher'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded feed_watcher task (every 4h)')
    }

    // Ensure interest_search task exists (every 6 hours at :30)
    const hasInterestSearch = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'interest_search'").get()
    if (!hasInterestSearch) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '兴趣驱动搜索', 'interest_search', '30 */6 * * *', '{}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'interest_search'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded interest_search task (every 6h at :30)')
    }

    // Ensure learning_digest task exists (daily 21:00)
    const hasLearningDigest = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'learning_digest'").get()
    if (!hasLearningDigest) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '学习日报', 'learning_digest', '0 21 * * *', '{}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'learning_digest'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded learning_digest task (daily 21:00)')
    }

    // Ensure silence_scan task exists (daily 8:30 — after question_generator at 8:00)
    const hasSilenceScan = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'silence_scan'").get()
    if (!hasSilenceScan) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '沉默扫描', 'silence_scan', '30 8 * * *', '{"silenceMultiplier":2.0,"minTransactions":3}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'silence_scan'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded silence_scan task (daily 8:30)')
    }

    // Ensure concentration_scan task exists (1st of month 09:00)
    const hasConcentrationScan = db.prepare("SELECT id FROM scheduled_tasks WHERE type = 'concentration_scan'").get()
    if (!hasConcentrationScan) {
      const now = Date.now()
      db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(ulid(), '集中度扫描', 'concentration_scan', '0 9 1 * *', '{"topN":3,"threshold":60}', 1, now, now)
      const row = db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'concentration_scan'").get() as ScheduledTaskRow
      this.scheduleJob(row)
      logger.info('Scheduler: seeded concentration_scan task (monthly 1st 9:00)')
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
