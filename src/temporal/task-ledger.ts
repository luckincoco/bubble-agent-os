/**
 * TaskLedger — 轻量级跨轮任务状态持久化。
 *
 * 设计原则：
 * - 只存摘要快照（checkpoints、pendingAction、关键引用），不存推理链和变量
 * - 恢复时先报告状态 → 等用户确认，避免数据过时/优先级变更导致误操作
 * - 与 Episode 单向弱引用，使用 episodeWindow 区间
 * - Router 检测到回指词时主动注入到 Brain.think() 前的上下文
 *
 * ADR: docs/adr-architecture-hardening-2026-05-18.md
 */

import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

// ── Types ─────────────────────────────────────────────────────────

export type LedgerStatus = 'active' | 'paused' | 'completed' | 'expired'

export interface PlanStep {
  id: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
  dependsOn?: string[]
  fallback?: string
}

export interface Checkpoint {
  stepId: string
  completedAt: number
  summary: string
}

export interface PendingAction {
  stepId: string
  description: string
  requiresConfirmation: boolean
  createdAt: number
}

export interface TaskLedger {
  id: string
  spaceId: string
  actorId: string
  goal: string
  status: LedgerStatus
  planSteps: PlanStep[]
  checkpoints: Checkpoint[]
  pendingAction: PendingAction | null
  episodeWindow: { from: string; to: string } | null
  ttl: number  // ms from creation, default 24h
  createdAt: number
  updatedAt: number
}

export interface CreateLedgerInput {
  spaceId: string
  actorId: string
  goal: string
  planSteps?: PlanStep[]
  ttl?: number
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000  // 24 hours

// ── Row mapping ───────────────────────────────────────────────────

interface LedgerRow {
  id: string
  space_id: string
  actor_id: string
  goal: string
  status: string
  plan_steps: string
  checkpoints: string
  pending_action: string | null
  episode_window: string | null
  ttl: number
  created_at: number
  updated_at: number
}

function rowToLedger(row: LedgerRow): TaskLedger {
  return {
    id: row.id,
    spaceId: row.space_id,
    actorId: row.actor_id,
    goal: row.goal,
    status: row.status as LedgerStatus,
    planSteps: JSON.parse(row.plan_steps),
    checkpoints: JSON.parse(row.checkpoints),
    pendingAction: row.pending_action ? JSON.parse(row.pending_action) : null,
    episodeWindow: row.episode_window ? JSON.parse(row.episode_window) : null,
    ttl: row.ttl,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

// ── CRUD ──────────────────────────────────────────────────────────

export function createLedger(input: CreateLedgerInput): TaskLedger {
  const db = getDatabase()
  const now = Date.now()
  const id = ulid()

  const ledger: TaskLedger = {
    id,
    spaceId: input.spaceId,
    actorId: input.actorId,
    goal: input.goal,
    status: 'active',
    planSteps: input.planSteps ?? [],
    checkpoints: [],
    pendingAction: null,
    episodeWindow: null,
    ttl: input.ttl ?? DEFAULT_TTL_MS,
    createdAt: now,
    updatedAt: now,
  }

  db.prepare(`
    INSERT INTO task_ledgers (id, space_id, actor_id, goal, status, plan_steps, checkpoints, pending_action, episode_window, ttl, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ledger.id,
    ledger.spaceId,
    ledger.actorId,
    ledger.goal,
    ledger.status,
    JSON.stringify(ledger.planSteps),
    JSON.stringify(ledger.checkpoints),
    null,
    null,
    ledger.ttl,
    ledger.createdAt,
    ledger.updatedAt,
  )

  logger.info(`TaskLedger: created "${ledger.goal}" (${id})`)
  return ledger
}

export function getLedger(id: string): TaskLedger | null {
  const db = getDatabase()
  const row = db.prepare('SELECT * FROM task_ledgers WHERE id = ?').get(id) as LedgerRow | undefined
  return row ? rowToLedger(row) : null
}

/**
 * Get the active ledger for a given actor in a space.
 * Returns the most recently updated active ledger.
 */
export function getActiveLedger(spaceId: string, actorId: string): TaskLedger | null {
  const db = getDatabase()
  const row = db.prepare(
    `SELECT * FROM task_ledgers WHERE space_id = ? AND actor_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1`
  ).get(spaceId, actorId) as LedgerRow | undefined
  if (!row) return null

  const ledger = rowToLedger(row)

  // Check TTL expiry
  if (Date.now() - ledger.createdAt > ledger.ttl) {
    updateLedgerStatus(ledger.id, 'expired')
    return null
  }

  return ledger
}

export function updateLedgerStatus(id: string, status: LedgerStatus): void {
  const db = getDatabase()
  db.prepare('UPDATE task_ledgers SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, Date.now(), id)
}

export function addCheckpoint(id: string, checkpoint: Checkpoint): void {
  const db = getDatabase()
  const row = db.prepare('SELECT checkpoints, plan_steps FROM task_ledgers WHERE id = ?').get(id) as { checkpoints: string; plan_steps: string } | undefined
  if (!row) return

  const checkpoints: Checkpoint[] = JSON.parse(row.checkpoints)
  checkpoints.push(checkpoint)

  // Also update the step status
  const planSteps: PlanStep[] = JSON.parse(row.plan_steps)
  const step = planSteps.find(s => s.id === checkpoint.stepId)
  if (step) step.status = 'completed'

  db.prepare('UPDATE task_ledgers SET checkpoints = ?, plan_steps = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(checkpoints), JSON.stringify(planSteps), Date.now(), id)
}

export function setPendingAction(id: string, action: PendingAction | null): void {
  const db = getDatabase()
  db.prepare('UPDATE task_ledgers SET pending_action = ?, updated_at = ? WHERE id = ?')
    .run(action ? JSON.stringify(action) : null, Date.now(), id)
}

export function updateEpisodeWindow(id: string, episodeId: string): void {
  const db = getDatabase()
  const row = db.prepare('SELECT episode_window FROM task_ledgers WHERE id = ?').get(id) as { episode_window: string | null } | undefined
  if (!row) return

  const window = row.episode_window ? JSON.parse(row.episode_window) as { from: string; to: string } : { from: episodeId, to: episodeId }
  window.to = episodeId

  db.prepare('UPDATE task_ledgers SET episode_window = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(window), Date.now(), id)
}

export function updatePlanSteps(id: string, planSteps: PlanStep[]): void {
  const db = getDatabase()
  db.prepare('UPDATE task_ledgers SET plan_steps = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(planSteps), Date.now(), id)
}

// ── Context Injection ─────────────────────────────────────────────

/**
 * Generate a structured summary of the active ledger for system prompt injection.
 * Called by Router when resumption is detected.
 */
export function buildLedgerContext(ledger: TaskLedger): string {
  const completedSteps = ledger.checkpoints.length
  const totalSteps = ledger.planSteps.length
  const progress = totalSteps > 0 ? `${completedSteps}/${totalSteps}` : '无明确步骤'

  const pendingDesc = ledger.pendingAction
    ? `\n待执行: ${ledger.pendingAction.description}${ledger.pendingAction.requiresConfirmation ? ' (需用户确认)' : ''}`
    : ''

  const nextSteps = ledger.planSteps
    .filter(s => s.status === 'pending' || s.status === 'in_progress')
    .slice(0, 3)
    .map(s => `  - ${s.description} [${s.status}]`)
    .join('\n')

  return [
    `[任务恢复上下文]`,
    `目标: ${ledger.goal}`,
    `进度: ${progress}`,
    pendingDesc,
    nextSteps ? `接下来:\n${nextSteps}` : '',
    `\n请先简要报告任务当前状态，等待用户确认后再继续。`,
  ].filter(Boolean).join('\n')
}

// ── Resumption Detection ──────────────────────────────────────────

/** Keywords that indicate the user wants to resume a previous task */
const RESUMPTION_PATTERNS = [
  /继续/, /接着/, /上次/, /刚才/, /之前/, /还没.*完/,
  /做到哪/, /进度/, /接上/, /回到/,
  /还在.*吗/, /完成了吗/, /搞定了吗/,
]

/**
 * Check if user input contains resumption indicators.
 */
export function detectResumption(text: string): boolean {
  return RESUMPTION_PATTERNS.some(re => re.test(text))
}
