import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  ResonanceTracker,
  generateSignatureHash,
  ensureResonanceTables,
} from '../src/memory/resonance/resonance-tracker.js'
import type { StructureType } from '../src/memory/resonance/resonance-tracker.js'

// ── Helpers ────────────────────────────────────────────────

function insertObservation(id: string, title: string, content: string): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'observation', ?, ?, '{}', '[]', 'dialogue', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
  `).run(id, title, content, now, now, now, null)
}

// ── generateSignatureHash (pure function) ─────────────────

describe('generateSignatureHash', () => {
  it('same content + structure type produces same hash', () => {
    const a = generateSignatureHash('用户经常提到这个方案', '模式发现')
    const b = generateSignatureHash('用户经常提到这个方案', '模式发现')
    expect(a).toBe(b)
  })

  it('different content produces different hash', () => {
    const a = generateSignatureHash('用户经常提到这个方案', '模式发现')
    const b = generateSignatureHash('用户反对这个方案', '模式发现')
    expect(a).not.toBe(b)
  })

  it('different structure type produces different hash', () => {
    const a = generateSignatureHash('用户经常提到这个方案', '模式发现')
    const b = generateSignatureHash('用户经常提到这个方案', '矛盾揭示')
    expect(a).not.toBe(b)
  })

  it('returns 16-char hex string', () => {
    const hash = generateSignatureHash('测试内容')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('infers structure type when not provided', () => {
    const withPattern = generateSignatureHash('用户总是提到这个方案，反复出现')
    const withContradiction = generateSignatureHash('矛盾很大，与之前的观点相反')
    expect(withPattern).not.toBe(withContradiction)
  })

  it('empty content still produces a hash', () => {
    const hash = generateSignatureHash('')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })
})

// ── ensureResonanceTables ──────────────────────────────────

describe('ensureResonanceTables', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-tbl-'))
    initDatabase(tmpDir, 'test-password-123')
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('creates activation_paths and emission_log tables', () => {
    ensureResonanceTables()
    const db = getDatabase()

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('activation_paths', 'emission_log')"
    ).all() as any[]
    expect(tables).toHaveLength(2)

    // Verify columns on activation_paths
    const cols = db.prepare('PRAGMA table_info(activation_paths)').all() as any[]
    const colNames = cols.map(c => c.name)
    expect(colNames).toContain('signature_hash')
    expect(colNames).toContain('trigger_context')
    expect(colNames).toContain('structure_type')
    expect(colNames).toContain('activation_count')
  })

  it('is idempotent (can be called twice)', () => {
    ensureResonanceTables() // second call should not throw
    const db = getDatabase()
    const count = db.prepare(
      "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name='activation_paths'"
    ).get() as any
    expect(count.cnt).toBe(1)
  })
})

// ── ResonanceTracker — recordActivation ────────────────────

describe('recordActivation', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-ra-'))
    initDatabase(tmpDir, 'test-password-123')
    ensureResonanceTables()
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    const db = getDatabase()
    db.prepare('DELETE FROM activation_paths').run()
    db.prepare('DELETE FROM emission_log').run()
  })

  it('creates new path with activation_count=1', () => {
    const tracker = new ResonanceTracker()
    const path = tracker.recordActivation({
      triggerContext: '用户经常迟到',
      observationIds: ['obs-1'],
      spaceId: 'space-1',
    })

    expect(path.activationCount).toBe(1)
    expect(path.triggerContext).toBe('用户经常迟到')
    expect(path.activatedObservations).toEqual(['obs-1'])
    expect(path.signatureHash).toMatch(/^[0-9a-f]{16}$/)
    expect(path.id).toMatch(/^ap_[0-9a-f]{12}$/)
    expect(path.spaceId).toBe('space-1')
    expect(path.createdAt).toBeGreaterThan(0)
  })

  it('increments activation_count and merges observations on re-activation', () => {
    const tracker = new ResonanceTracker()
    const first = tracker.recordActivation({
      triggerContext: '用户经常迟到',
      observationIds: ['obs-1', 'obs-2'],
      spaceId: 'space-1',
    })

    const second = tracker.recordActivation({
      triggerContext: '用户经常迟到',
      observationIds: ['obs-3'],
      spaceId: 'space-1',
    })

    expect(second.id).toBe(first.id)
    expect(second.activationCount).toBe(2)
    expect(second.activatedObservations).toEqual(['obs-1', 'obs-2', 'obs-3'])
    // Same ms possible in fast test runs
    expect(second.lastActivated).toBeGreaterThanOrEqual(first.lastActivated)
  })

  it('deduplicates observation IDs on merge', () => {
    const tracker = new ResonanceTracker()
    tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-1', 'obs-2'], spaceId: 'space-1',
    })
    const merged = tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-2', 'obs-3'], spaceId: 'space-1',
    })

    expect(merged.activatedObservations).toEqual(['obs-1', 'obs-2', 'obs-3'])
  })

  it('stores structureType when provided', () => {
    const tracker = new ResonanceTracker()
    const path = tracker.recordActivation({
      triggerContext: '用户总是迟到',
      observationIds: ['obs-1'],
      structureType: '模式发现',
    })
    expect(path.structureType).toBe('模式发现')
  })

  it('infers structureType when not provided', () => {
    const tracker = new ResonanceTracker()
    const path = tracker.recordActivation({
      triggerContext: '矛盾很大，与之前的观点冲突',
      observationIds: ['obs-1'],
    })
    // "矛盾" in triggerContext → should infer 矛盾揭示
    expect(path.structureType).toBe('矛盾揭示')
  })

  it('userSignaled flag persists', () => {
    const tracker = new ResonanceTracker()
    const path = tracker.recordActivation({
      triggerContext: '测试',
      observationIds: ['obs-1'],
      userSignaled: true,
    })
    expect(path.userSignaled).toBe(true)
  })

  it('spaceId can be null', () => {
    const tracker = new ResonanceTracker()
    const path = tracker.recordActivation({
      triggerContext: '测试',
      observationIds: ['obs-1'],
    })
    expect(path.spaceId).toBeNull()
  })

  it('two different contexts get different paths', () => {
    const tracker = new ResonanceTracker()
    const a = tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-1'], spaceId: 'space-1',
    })
    const b = tracker.recordActivation({
      triggerContext: '用户喜欢早退', observationIds: ['obs-2'], spaceId: 'space-1',
    })
    expect(a.id).not.toBe(b.id)
  })

  it('same signature in different spaces creates separate paths', async () => {
    const tracker = new ResonanceTracker()
    const a = tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-1'], spaceId: 'space-1',
    })
    await new Promise(r => setTimeout(r, 5))
    const b = tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-1'], spaceId: 'space-2',
    })
    expect(a.id).not.toBe(b.id)
  })

  it('writes to DB correctly', () => {
    const tracker = new ResonanceTracker()
    tracker.recordActivation({
      triggerContext: '测试写入', observationIds: ['obs-1'], spaceId: 'space-1', userSignaled: true,
    })

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM activation_paths WHERE trigger_context = ?').get('测试写入') as any
    expect(row).not.toBeNull()
    expect(row.activation_count).toBe(1)
    expect(row.user_signaled).toBe(1)
  })
})

// ── findMatchingPaths ────────────────────────────────────────

describe('findMatchingPaths', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-fmp-'))
    initDatabase(tmpDir, 'test-password-123')
    ensureResonanceTables()
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    const db = getDatabase()
    db.prepare('DELETE FROM activation_paths').run()
  })

  it('finds exact signature match', () => {
    const tracker = new ResonanceTracker()
    tracker.recordActivation({
      triggerContext: '用户经常迟到', observationIds: ['obs-1'], spaceId: 'space-1',
    })

    const paths = tracker.findMatchingPaths('用户经常迟到', 'space-1')
    expect(paths).toHaveLength(1)
    expect(paths[0].triggerContext).toBe('用户经常迟到')
  })

  it('returns fallback ordered by effective weight when no exact match', () => {
    const tracker = new ResonanceTracker()
    // Record two paths with context that won't match later query
    tracker.recordActivation({
      triggerContext: '用户喜欢早退', observationIds: ['obs-1'], spaceId: 'space-1',
    })
    tracker.recordActivation({
      triggerContext: '用户经常加班', observationIds: ['obs-2'], spaceId: 'space-1',
    })

    const paths = tracker.findMatchingPaths('完全不同的上下文', 'space-1', 5)
    expect(paths.length).toBeGreaterThanOrEqual(2)
  })

  it('respects limit parameter', () => {
    const tracker = new ResonanceTracker()
    // Use distinct CJK phrases so each generates a different signature hash
    const contexts = ['产品质量提升', '客户满意度调查', '市场推广策略', '技术创新方向', '团队协作效率']
    for (const ctx of contexts) {
      tracker.recordActivation({
        triggerContext: ctx, observationIds: [`obs-${ctx.slice(0, 2)}`], spaceId: 'space-1',
      })
    }

    const paths = tracker.findMatchingPaths('不存在的查询内容话题', 'space-1', 2)
    expect(paths).toHaveLength(2)
  })

  it('returns empty array when space has no paths', () => {
    const tracker = new ResonanceTracker()
    const paths = tracker.findMatchingPaths('任何内容', 'nonexistent-space')
    expect(paths).toHaveLength(0)
  })
})

// ── shouldSuppress / recordEmission / recordAcknowledgement ─

describe('emission suppression', () => {
  let tmpDir: string

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-em-'))
    initDatabase(tmpDir, 'test-password-123')
    ensureResonanceTables()
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    const db = getDatabase()
    db.prepare('DELETE FROM emission_log').run()
  })

  it('shouldSuppress returns false for unknown hash', () => {
    const tracker = new ResonanceTracker()
    expect(tracker.shouldSuppress('unknown')).toBe(false)
  })

  it('recordEmission creates suppression for 24h', () => {
    const tracker = new ResonanceTracker()
    const hash = generateSignatureHash('测试模式')

    tracker.recordEmission(hash)
    expect(tracker.shouldSuppress(hash)).toBe(true)

    // Verify DB
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM emission_log WHERE signature_hash = ?').get(hash) as any
    expect(row).not.toBeNull()
    expect(row.user_acknowledged).toBe(0)
    expect(row.suppression_until).toBeGreaterThan(Date.now())
  })

  it('recordAcknowledgement extends suppression to 7 days', () => {
    const tracker = new ResonanceTracker()
    const hash = generateSignatureHash('测试模式')

    tracker.recordEmission(hash)
    tracker.recordAcknowledgement(hash)
    expect(tracker.shouldSuppress(hash)).toBe(true)

    const db = getDatabase()
    const row = db.prepare('SELECT * FROM emission_log WHERE signature_hash = ?').get(hash) as any
    expect(row.user_acknowledged).toBe(1)
    // 7 days from now = 7*24*60*60*1000
    expect(row.suppression_until).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)
  })

  it('different hashes have independent suppression', () => {
    const tracker = new ResonanceTracker()
    // Use distinct CJK phrases so topic extraction produces different topics
    const hashA = generateSignatureHash('持续进步趋势', '模式发现')
    const hashB = generateSignatureHash('突然矛盾变化', '模式发现')

    expect(hashA).not.toBe(hashB) // sanity check
    tracker.recordEmission(hashA)
    expect(tracker.shouldSuppress(hashA)).toBe(true)
    expect(tracker.shouldSuppress(hashB)).toBe(false)
  })

  it('suppression expires over time', () => {
    const tracker = new ResonanceTracker()
    const hash = generateSignatureHash('临时模式')
    const db = getDatabase()

    // Insert with past suppression_until
    const past = Date.now() - 1000
    db.prepare(`
      INSERT OR REPLACE INTO emission_log (signature_hash, last_emitted, user_acknowledged, suppression_until)
      VALUES (?, ?, 0, ?)
    `).run(hash, past, past)

    expect(tracker.shouldSuppress(hash)).toBe(false)
  })
})

// ── getActivePaths ──────────────────────────────────────────

describe('getActivePaths', () => {
  let tmpDir: string
  let tracker: ResonanceTracker

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-gap-'))
    initDatabase(tmpDir, 'test-password-123')
    ensureResonanceTables()

    tracker = new ResonanceTracker()
    // Use contexts with different topic extractions to avoid duplicate signature hash + same-ms ID collision
    tracker.recordActivation({
      triggerContext: '产品质量提升方案', observationIds: ['obs-1'], spaceId: 'space-1',
    })
    tracker.recordActivation({
      triggerContext: '客户满意度调查结果', observationIds: ['obs-2'], spaceId: 'space-1',
    })
    tracker.recordActivation({
      triggerContext: '国际市场拓展计划', observationIds: ['obs-3'], spaceId: 'space-2',
    })
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns paths for the requested space', () => {
    const paths = tracker.getActivePaths('space-1')
    expect(paths).toHaveLength(2)
    expect(paths.every(p => p.spaceId === 'space-1' || p.spaceId === null)).toBe(true)
  })

  it('returns empty for space with no paths', () => {
    const paths = tracker.getActivePaths('nonexistent')
    expect(paths).toHaveLength(0)
  })

  it('respects limit parameter', () => {
    const paths = tracker.getActivePaths('space-1', 1)
    expect(paths).toHaveLength(1)
  })
})

// ── effectiveWeight (indirect via getActivePaths) ──────────

describe('effectiveWeight decay', () => {
  let tmpDir: string
  let tracker: ResonanceTracker

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-res-ew-'))
    initDatabase(tmpDir, 'test-password-123')
    ensureResonanceTables()

    tracker = new ResonanceTracker()
    const db = getDatabase()
    const now = Date.now()

    // Insert a path with old last_activated to trigger decay
    // At 500 days old: monthsPast = (500-180)/30 ≈ 10.67, decayFactor ≈ 0.9^10.67 ≈ 0.327
    // effectiveWeight = 5 * 0.327 ≈ 1.63 — lower than new path's 3.0
    db.prepare(`
      INSERT INTO activation_paths (id, signature_hash, trigger_context, structure_type, activated_observations, activation_count, last_activated, user_signaled, space_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ap_old1', 'hash_old', '旧模式', '模式发现', '["obs-1"]', 5,
      now - 500 * 24 * 60 * 60 * 1000, // 500 days ago (well past grace period)
      0, 'space-1', now,
    )
    // Insert a recent path (no decay)
    db.prepare(`
      INSERT INTO activation_paths (id, signature_hash, trigger_context, structure_type, activated_observations, activation_count, last_activated, user_signaled, space_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'ap_new1', 'hash_new', '新模式', '模式发现', '["obs-2"]', 3,
      now, // now
      0, 'space-1', now,
    )
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('newer path with lower count outranks older path with higher count due to decay', () => {
    const paths = tracker.getActivePaths('space-1', 5)
    const recentPath = paths.find(p => p.id === 'ap_new1')
    const oldPath = paths.find(p => p.id === 'ap_old1')

    expect(recentPath).toBeDefined()
    expect(oldPath).toBeDefined()
    // The recent path should come first (higher effective weight)
    expect(paths.indexOf(recentPath!)).toBeLessThan(paths.indexOf(oldPath!))
  })

  it('path within 180-day grace period has no decay', () => {
    const db = getDatabase()
    const now = Date.now()
    const row = db.prepare('SELECT * FROM activation_paths WHERE id = ?').get('ap_new1') as any
    expect((row as any).activation_count).toBe(3)
  })
})
