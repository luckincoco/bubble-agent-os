/**
 * Resonance Tracker — activation path recording + anti-double-emit.
 *
 * Core data structure for Bubble's "共振层": stores which observations
 * were co-activated under a given context, enabling pattern recognition
 * across time without pre-extracting patterns.
 *
 * Also provides anti-double-emit: prevents repeated surfacing of the
 * same pattern to the user within suppression windows.
 *
 * Design decisions (from 4-round discussion):
 * - Signature hash = topic keywords + structure type → hash
 * - Structure types: 模式发现 | 矛盾揭示 | 事实陈述 | 推测 | 自我质疑
 * - Paths never deleted, sorted by time-decayed activation count
 * - Decay: 0-180 days no decay, then 10% monthly reduction
 * - Anti-double-emit shares same signature mechanism
 */

import { createHash } from 'node:crypto'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

// ── Types ──────────────────────────────────────────────────────

export type StructureType =
  | '模式发现'
  | '矛盾揭示'
  | '事实陈述'
  | '推测'
  | '自我质疑'

export interface ActivationPath {
  id: string
  signatureHash: string
  triggerContext: string
  structureType: StructureType
  activatedObservations: string[]
  activationCount: number
  lastActivated: number
  userSignaled: boolean
  spaceId: string | null
  createdAt: number
}

export interface EmissionRecord {
  signatureHash: string
  lastEmitted: number
  userAcknowledged: boolean
  suppressionUntil: number
}

// ── Constants ──────────────────────────────────────────────────

const STRUCTURE_TYPES: StructureType[] = [
  '模式发现', '矛盾揭示', '事实陈述', '推测', '自我质疑',
]

/** Days before decay begins */
const DECAY_GRACE_DAYS = 180
/** Monthly decay rate after grace period */
const DECAY_MONTHLY_RATE = 0.10
/** Suppression window when user acknowledged */
const SUPPRESSION_ACKNOWLEDGED_MS = 7 * 24 * 60 * 60 * 1000  // 7 days
/** Suppression window when user didn't respond */
const SUPPRESSION_SILENT_MS = 24 * 60 * 60 * 1000  // 24 hours

// ── Topic extraction (lightweight, no LLM) ─────────────────────

/**
 * Extract core noun phrases from text using CJK-aware heuristics.
 * Not using LLM — pure regex + frequency-based extraction.
 */
function extractTopicWords(text: string): string[] {
  // Remove markdown formatting
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#*`\[\]()>|_~]/g, '')
    .replace(/https?:\/\/\S+/g, '')

  // Extract CJK noun phrases (2-6 chars that appear as meaningful units)
  const cjkPattern = /[\u4e00-\u9fff]{2,6}/g
  const cjkMatches = clean.match(cjkPattern) || []

  // Extract meaningful English terms (capitalized or technical)
  const engPattern = /[A-Z][a-z]+(?:[A-Z][a-z]+)*|[a-z]{4,}/g
  const engMatches = clean.match(engPattern) || []

  // Count frequency, keep top terms
  const freq = new Map<string, number>()
  for (const word of [...cjkMatches, ...engMatches]) {
    // Skip very common words
    if (isStopWord(word)) continue
    freq.set(word, (freq.get(word) || 0) + 1)
  }

  // Sort by frequency, take top 5
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word)
}

const STOP_WORDS = new Set([
  '这个', '那个', '什么', '怎么', '可以', '应该', '不是', '但是',
  '因为', '所以', '如果', '已经', '需要', '没有', '还是', '一个',
  '我们', '你们', '他们', '自己', '时候', '现在', '这样', '那样',
])

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word) || word.length < 2
}

// ── Structure type inference ───────────────────────────────────

/**
 * Infer structure type from observation content.
 * Uses keyword patterns — no LLM needed.
 */
function inferStructureType(content: string): StructureType {
  // Pattern indicators (ordered by specificity)
  if (/矛盾|冲突|相反|不一致|然而.*却|但.*反而/.test(content)) return '矛盾揭示'
  if (/模式|规律|总是|每次.*都|反复|趋势|倾向/.test(content)) return '模式发现'
  if (/我(觉得|认为|猜|推测|怀疑)|可能是|也许|不确定/.test(content)) return '推测'
  if (/为什么我|我是否|这是不是|自我|审视|质疑自己/.test(content)) return '自我质疑'
  return '事实陈述'
}

// ── Signature hash generation ──────────────────────────────────

/**
 * Generate a signature hash from content.
 * Same content under same context → same hash → anti-double-emit works.
 */
export function generateSignatureHash(content: string, structureType?: StructureType): string {
  const topics = extractTopicWords(content)
  const type = structureType || inferStructureType(content)
  const raw = `${topics.sort().join('|')}::${type}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

// ── Database setup ─────────────────────────────────────────────

export function ensureResonanceTables(): void {
  const db = getDatabase()

  db.exec(`
    CREATE TABLE IF NOT EXISTS activation_paths (
      id TEXT PRIMARY KEY,
      signature_hash TEXT NOT NULL,
      trigger_context TEXT NOT NULL,
      structure_type TEXT NOT NULL,
      activated_observations TEXT NOT NULL DEFAULT '[]',
      activation_count INTEGER NOT NULL DEFAULT 1,
      last_activated INTEGER NOT NULL,
      user_signaled INTEGER NOT NULL DEFAULT 0,
      space_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_signature ON activation_paths(signature_hash)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_last_activated ON activation_paths(last_activated)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_ap_space ON activation_paths(space_id)')

  db.exec(`
    CREATE TABLE IF NOT EXISTS emission_log (
      signature_hash TEXT PRIMARY KEY,
      last_emitted INTEGER NOT NULL,
      user_acknowledged INTEGER NOT NULL DEFAULT 0,
      suppression_until INTEGER NOT NULL
    )
  `)

  logger.info('Migration: activation_paths + emission_log tables ready')
}

// ── Resonance Tracker class ────────────────────────────────────

export class ResonanceTracker {
  constructor() {
    ensureResonanceTables()
  }

  /**
   * Record an activation: a set of observations were co-activated under
   * a specific trigger context.
   */
  recordActivation(opts: {
    triggerContext: string
    observationIds: string[]
    structureType?: StructureType
    userSignaled?: boolean
    spaceId?: string
  }): ActivationPath {
    const db = getDatabase()
    const now = Date.now()

    const structureType = opts.structureType || inferStructureType(opts.triggerContext)
    const signatureHash = generateSignatureHash(opts.triggerContext, structureType)

    // Check if path with same signature already exists
    const existing = db.prepare(
      'SELECT * FROM activation_paths WHERE signature_hash = ? AND space_id IS ?'
    ).get(signatureHash, opts.spaceId ?? null) as any | undefined

    if (existing) {
      // Update existing path
      const existingObs: string[] = JSON.parse(existing.activated_observations)
      const mergedObs = [...new Set([...existingObs, ...opts.observationIds])]

      db.prepare(`
        UPDATE activation_paths
        SET activation_count = activation_count + 1,
            last_activated = ?,
            activated_observations = ?,
            user_signaled = CASE WHEN ? = 1 THEN 1 ELSE user_signaled END
        WHERE id = ?
      `).run(now, JSON.stringify(mergedObs), opts.userSignaled ? 1 : 0, existing.id)

      return {
        id: existing.id,
        signatureHash,
        triggerContext: existing.trigger_context,
        structureType: existing.structure_type as StructureType,
        activatedObservations: mergedObs,
        activationCount: existing.activation_count + 1,
        lastActivated: now,
        userSignaled: opts.userSignaled || existing.user_signaled === 1,
        spaceId: opts.spaceId ?? null,
        createdAt: existing.created_at,
      }
    }

    // Create new path
    const id = `ap_${createHash('sha256').update(`${signatureHash}:${now}`).digest('hex').slice(0, 12)}`

    db.prepare(`
      INSERT INTO activation_paths (id, signature_hash, trigger_context, structure_type, activated_observations, activation_count, last_activated, user_signaled, space_id, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, signatureHash, opts.triggerContext, structureType,
      JSON.stringify(opts.observationIds), now,
      opts.userSignaled ? 1 : 0, opts.spaceId ?? null, now,
    )

    return {
      id, signatureHash, triggerContext: opts.triggerContext,
      structureType, activatedObservations: opts.observationIds,
      activationCount: 1, lastActivated: now,
      userSignaled: opts.userSignaled ?? false,
      spaceId: opts.spaceId ?? null, createdAt: now,
    }
  }

  /**
   * Find activation paths matching a given context.
   * Returns paths sorted by effective weight (activation_count * decay_factor).
   */
  findMatchingPaths(context: string, spaceId?: string, limit = 5): ActivationPath[] {
    const db = getDatabase()
    const signatureHash = generateSignatureHash(context)

    // First try exact signature match
    const exact = db.prepare(
      'SELECT * FROM activation_paths WHERE signature_hash = ? AND (space_id IS ? OR space_id IS NULL) ORDER BY last_activated DESC'
    ).all(signatureHash, spaceId ?? null) as any[]

    if (exact.length > 0) {
      return exact.map(row => this.rowToPath(row))
    }

    // Fallback: get most recently activated paths in this space
    const recent = db.prepare(
      'SELECT * FROM activation_paths WHERE (space_id IS ? OR space_id IS NULL) ORDER BY last_activated DESC LIMIT ?'
    ).all(spaceId ?? null, limit * 2) as any[]

    // Sort by effective weight
    const now = Date.now()
    return recent
      .map(row => ({ path: this.rowToPath(row), weight: this.effectiveWeight(row, now) }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(item => item.path)
  }

  /**
   * Check if a pattern should be suppressed (anti-double-emit).
   * Returns true if the pattern was recently emitted and should NOT be shown.
   */
  shouldSuppress(signatureHash: string): boolean {
    const db = getDatabase()
    const now = Date.now()

    const record = db.prepare(
      'SELECT * FROM emission_log WHERE signature_hash = ?'
    ).get(signatureHash) as any | undefined

    if (!record) return false
    return now < record.suppression_until
  }

  /**
   * Record that a pattern was emitted to the user.
   */
  recordEmission(signatureHash: string): void {
    const db = getDatabase()
    const now = Date.now()
    const suppressionUntil = now + SUPPRESSION_SILENT_MS  // default: 24h

    db.prepare(`
      INSERT OR REPLACE INTO emission_log (signature_hash, last_emitted, user_acknowledged, suppression_until)
      VALUES (?, ?, 0, ?)
    `).run(signatureHash, now, suppressionUntil)
  }

  /**
   * Record that the user acknowledged a pattern emission.
   * Extends suppression window to 7 days.
   */
  recordAcknowledgement(signatureHash: string): void {
    const db = getDatabase()
    const now = Date.now()
    const suppressionUntil = now + SUPPRESSION_ACKNOWLEDGED_MS

    db.prepare(`
      UPDATE emission_log SET user_acknowledged = 1, suppression_until = ? WHERE signature_hash = ?
    `).run(suppressionUntil, signatureHash)
  }

  /**
   * Get all paths for a space (for diagnostics / reporting).
   */
  getActivePaths(spaceId?: string, limit = 20): ActivationPath[] {
    const db = getDatabase()
    const now = Date.now()

    const rows = db.prepare(
      'SELECT * FROM activation_paths WHERE (space_id IS ? OR space_id IS NULL) ORDER BY last_activated DESC LIMIT ?'
    ).all(spaceId ?? null, limit) as any[]

    return rows
      .map(row => ({ path: this.rowToPath(row), weight: this.effectiveWeight(row, now) }))
      .sort((a, b) => b.weight - a.weight)
      .map(item => item.path)
  }

  // ── Internal ─────────────────────────────────────────────────

  private effectiveWeight(row: any, now: number): number {
    const daysSinceActivation = (now - row.last_activated) / (1000 * 60 * 60 * 24)

    if (daysSinceActivation <= DECAY_GRACE_DAYS) {
      return row.activation_count
    }

    // Months past grace period
    const monthsPast = (daysSinceActivation - DECAY_GRACE_DAYS) / 30
    const decayFactor = Math.pow(1 - DECAY_MONTHLY_RATE, monthsPast)
    return row.activation_count * decayFactor
  }

  private rowToPath(row: any): ActivationPath {
    return {
      id: row.id,
      signatureHash: row.signature_hash,
      triggerContext: row.trigger_context,
      structureType: row.structure_type as StructureType,
      activatedObservations: JSON.parse(row.activated_observations),
      activationCount: row.activation_count,
      lastActivated: row.last_activated,
      userSignaled: row.user_signaled === 1,
      spaceId: row.space_id,
      createdAt: row.created_at,
    }
  }
}
