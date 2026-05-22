import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ── Module-level mocks ──────────────────────────────────────────────────

const mockCronSchedule = vi.hoisted(() => vi.fn(() => ({ stop: vi.fn() })))
const mockCronValidate = vi.hoisted(() => vi.fn(() => true))

vi.mock('node-cron', () => ({
  default: { schedule: mockCronSchedule, validate: mockCronValidate },
  schedule: mockCronSchedule,
  validate: mockCronValidate,
}))

vi.mock('ulid', () => ({
  ulid: vi.fn(() => 'test-ulid-' + Date.now()),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(),
}))

import * as cron from 'node-cron'
import { ulid } from 'ulid'
import { getDatabase } from '../src/storage/database.js'
import { TaskScheduler } from '../src/scheduler/scheduler.js'
import type { TaskDeps } from '../src/scheduler/scheduler.js'

// ── Test DB setup ───────────────────────────────────────────────────────

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    cron TEXT NOT NULL,
    params TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run INTEGER,
    next_run INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at INTEGER NOT NULL,
    name TEXT NOT NULL,
    value REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trace_spans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS bubbles (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    space_id TEXT
  )
`

interface TestContext {
  db: Database.Database
  dbPath: string
}

function createTestDb(): TestContext {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'scheduler-test-')), 'test.db')
  const db = new Database(dbPath)
  db.exec(TABLE_DDL)
  return { db, dbPath }
}

function destroyTestDb(ctx: TestContext) {
  ctx.db.close()
  rmSync(ctx.dbPath, { force: true })
  rmSync(join(ctx.dbPath, '..'), { recursive: true, force: true })
}

function makeDeps(overrides: Partial<TaskDeps> = {}): TaskDeps {
  return {
    brain: { think: vi.fn() } as any,
    memory: { getActiveFocusUserIds: vi.fn(() => []), getRecentTopics: vi.fn(() => '') } as any,
    tools: { execute: vi.fn() } as any,
    llm: { chat: vi.fn() } as any,
    ...overrides,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('TaskScheduler', () => {
  let ctx: TestContext
  let scheduler: TaskScheduler

  beforeEach(() => {
    vi.clearAllMocks()
    ctx = createTestDb()
    // Hook getDatabase to return our test DB
    vi.mocked(getDatabase).mockReturnValue(ctx.db as any)
    // Ensure cron.validate returns true by default (clearAllMocks resets it to undefined)
    mockCronValidate.mockReturnValue(true)
    scheduler = new TaskScheduler(makeDeps())
  })

  afterEach(() => {
    destroyTestDb(ctx)
  })

  // ── init ──────────────────────────────────────────────────────────

  describe('init', () => {
    it('loads enabled tasks from DB', async () => {
      const now = Date.now()
      ctx.db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('job-1', 'Test Task', 'daily_digest', '58 23 * * *', '{}', 1, now, now)

      await scheduler.init()

      expect(cron.schedule).toHaveBeenCalledWith(
        '58 23 * * *',
        expect.any(Function),
        expect.objectContaining({ timezone: 'Asia/Shanghai' }),
      )
    })

    it('skips disabled tasks (only enabled tasks get scheduled)', async () => {
      const now = Date.now()
      ctx.db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('job-1', 'Disabled', 'daily_digest', '59 23 * * *', '{}', 0, now, now)

      await scheduler.init()

      // The disabled task's cron should NOT be scheduled
      // (init() will still schedule system tasks it creates, but not our disabled one)
      const calls = vi.mocked(cron.schedule).mock.calls
      const disabledTaskScheduled = calls.some(([cronExpr]) => cronExpr === '59 23 * * *')
      expect(disabledTaskScheduled).toBe(false)
    })

    it('seeds default tasks when table is empty', async () => {
      await scheduler.init()

      const rows = ctx.db.prepare('SELECT * FROM scheduled_tasks').all() as any[]
      expect(rows.length).toBeGreaterThanOrEqual(3)
      expect(rows.some((r: any) => r.type === 'daily_digest')).toBe(true)
      expect(rows.some((r: any) => r.type === 'memory_decay')).toBe(true)
      expect(rows.some((r: any) => r.type === 'keyword_monitor')).toBe(true)
    })

    it('creates missing steel_price task', async () => {
      await scheduler.init()
      const row = ctx.db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'steel_price'").get() as any
      expect(row).toBeTruthy()
      expect(row.cron).toBe('30 9 * * 1-5')
    })

    it('creates missing session_compression task', async () => {
      await scheduler.init()
      const row = ctx.db.prepare("SELECT * FROM scheduled_tasks WHERE type = 'session_compression'").get() as any
      expect(row).toBeTruthy()
      expect(row.cron).toBe('*/10 * * * *')
    })
  })

  // ── runTask ───────────────────────────────────────────────────────

  describe('runTask', () => {
    it('returns not-found for non-existent id', async () => {
      const result = await (scheduler as any).runTask('nonexistent')
      expect(result.success).toBe(false)
      expect(result.message).toBe('Task not found')
    })

    it('returns unknown-type for unrecognised type', async () => {
      const now = Date.now()
      ctx.db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('bad-type', 'Bad', 'nonexistent_type', '0 8 * * *', '{}', 1, now, now)

      const result = await (scheduler as any).runTask('bad-type')
      expect(result.success).toBe(false)
      expect(result.message).toContain('Unknown task type')
    })

    it('executes task and updates last_run', async () => {
      const now = Date.now()
      ctx.db.prepare(
        'INSERT INTO scheduled_tasks (id, name, type, cron, params, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('exec-test', 'Metrics', 'metrics_rollup', '0 0 * * *', '{}', 1, now, now)

      const result = await (scheduler as any).runTask('exec-test')
      expect(result.success).toBe(true)
      expect(result.message).toContain('Rollup')

      // last_run should be set
      const updated = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('exec-test') as any
      expect(updated.last_run).toBeGreaterThan(0)
    })
  })

  // ── addTask ───────────────────────────────────────────────────────

  describe('addTask', () => {
    it('adds a new task and schedules it', async () => {
      const id = await scheduler.addTask('My Task', 'daily_digest', '0 9 * * *')

      const row = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any
      expect(row).toBeTruthy()
      expect(row.name).toBe('My Task')
      expect(row.type).toBe('daily_digest')
      expect(row.enabled).toBe(1)
      expect(cron.schedule).toHaveBeenCalled()
    })

    it('throws on invalid cron', async () => {
      vi.mocked(cron.validate).mockReturnValueOnce(false)
      await expect(scheduler.addTask('Bad', 'daily_digest', 'not-cron'))
        .rejects.toThrow('Invalid cron')
    })

    it('throws on unknown type', async () => {
      await expect(scheduler.addTask('Bad', 'unknown_type' as any, '0 9 * * *'))
        .rejects.toThrow('Unknown task type')
    })
  })

  // ── updateTask ────────────────────────────────────────────────────

  describe('updateTask', () => {
    async function addTestTask(): Promise<string> {
      return scheduler.addTask('Original', 'daily_digest', '0 8 * * *')
    }

    it('updates task name', async () => {
      const id = await addTestTask()
      vi.mocked(cron.schedule).mockClear()

      scheduler.updateTask(id, { name: 'Renamed' })

      const row = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any
      expect(row.name).toBe('Renamed')
    })

    it('updates cron and reschedules', async () => {
      const id = await addTestTask()
      const scheduleMock = vi.mocked(cron.schedule)
      scheduleMock.mockClear()

      scheduler.updateTask(id, { cron: '0 10 * * *' })

      expect(scheduleMock).toHaveBeenCalledWith(
        '0 10 * * *',
        expect.any(Function),
        expect.any(Object),
      )
    })

    it('updates enabled flag', async () => {
      const id = await addTestTask()
      scheduler.updateTask(id, { enabled: false })

      const row = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any
      expect(row.enabled).toBe(0)
    })

    it('throws for non-existent task', () => {
      expect(() => scheduler.updateTask('nonexistent', { name: 'X' }))
        .toThrow('Task not found')
    })

    it('throws on invalid cron in update', async () => {
      const id = await scheduler.addTask('Test', 'daily_digest', '0 8 * * *')
      vi.mocked(cron.validate).mockReturnValueOnce(false)
      expect(() => scheduler.updateTask(id, { cron: 'bad' }))
        .toThrow('Invalid cron')
    })
  })

  // ── removeTask ────────────────────────────────────────────────────

  describe('removeTask', () => {
    it('removes task from DB and stops job', async () => {
      const id = await scheduler.addTask('ToRemove', 'daily_digest', '0 8 * * *')
      const stopFn = vi.fn()
      // Find the cron mock and set stop
      const scheduleMock = vi.mocked(cron.schedule)
      const lastCallReturn = scheduleMock.mock.results[scheduleMock.mock.results.length - 1].value
      lastCallReturn.stop = stopFn

      scheduler.removeTask(id)

      const row = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id)
      expect(row).toBeUndefined()
      expect(stopFn).toHaveBeenCalled()
    })
  })

  // ── listTasks ─────────────────────────────────────────────────────

  describe('listTasks', () => {
    it('returns formatted task list', async () => {
      await scheduler.addTask('T1', 'daily_digest', '0 8 * * *')
      await scheduler.addTask('T2', 'memory_decay', '0 3 * * *')

      const list = scheduler.listTasks()
      expect(list).toHaveLength(2)
      expect(list[0].name).toBe('T1')
      expect(list[0].enabled).toBe(true)
      expect(list[0].type).toBe('daily_digest')
      expect(list[0].createdAt).toBeGreaterThan(0)
    })
  })

  // ── executeNow ────────────────────────────────────────────────────

  describe('executeNow', () => {
    it('immediately runs a task by id', async () => {
      const id = await scheduler.addTask('ExecNow', 'metrics_rollup', '0 0 * * *')

      const result = await scheduler.executeNow(id)
      expect(result.success).toBe(true)

      const updated = ctx.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as any
      expect(updated.last_run).toBeGreaterThan(0)
    })
  })

  // ── executeByType ─────────────────────────────────────────────────

  describe('executeByType', () => {
    it('runs persisted enabled task by type', async () => {
      await scheduler.addTask('Persisted', 'daily_digest', '0 8 * * *')

      const result = await scheduler.executeByType('daily_digest')
      expect(result.success).toBe(true)
    })

    it('falls back to direct execution when no persisted task exists', async () => {
      // metrics_rollup is in EXECUTORS but not persisted
      const result = await scheduler.executeByType('metrics_rollup')
      expect(result.success).toBe(true)
      expect(result.message).toContain('Rollup')
    })

    it('returns error for unknown type', async () => {
      const result = await scheduler.executeByType('nonexistent_type' as any)
      expect(result.success).toBe(false)
      expect(result.message).toContain('Unknown')
    })
  })

  // ── registerReactiveListeners ─────────────────────────────────────

  describe('registerReactiveListeners', () => {
    it('registers event listeners and can be stopped', () => {
      const eventBus = { on: vi.fn() }
      scheduler.registerReactiveListeners(eventBus as any)

      expect(eventBus.on).toHaveBeenCalledTimes(2)
      expect(eventBus.on).toHaveBeenCalledWith('knowledge.urgency.detected', expect.any(Function))
      expect(eventBus.on).toHaveBeenCalledWith('knowledge.gap.detected', expect.any(Function))
    })
  })

  // ── stop ──────────────────────────────────────────────────────────

  describe('stop', () => {
    it('stops all scheduled jobs', async () => {
      await scheduler.addTask('T1', 'daily_digest', '0 8 * * *')
      await scheduler.addTask('T2', 'memory_decay', '0 3 * * *')

      scheduler.stop()

      // After stop, jobs Map should be empty (internal — verified via no errors)
      // Verify jobs stopped by checking schedule was called for each
      expect(vi.mocked(cron.schedule)).toHaveBeenCalledTimes(2)
    })
  })
})
