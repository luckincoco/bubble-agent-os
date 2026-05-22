import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

const mockStmt = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() }))
const mockDb = vi.hoisted(() => ({ prepare: vi.fn(() => mockStmt) }))

const mockUlid = vi.hoisted(() => vi.fn(() => 'eval-ulid-obs'))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('ulid', () => ({ ulid: mockUlid }))

// ── Imports ────────────────────────────────────────────────

import { runObservationEval } from '../src/observability/eval/observation-eval.js'

// ════════════════════════════════════════════════════════════
//  runObservationEval
// ════════════════════════════════════════════════════════════

describe('runObservationEval', () => {
  const mockWriter = { writeEvalResult: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    mockStmt.all.mockReset()
    mockStmt.get.mockReset()
    mockUlid.mockReturnValue('eval-ulid-obs')
    mockWriter.writeEvalResult.mockReset()
  })

  it('returns null when no observations exist', () => {
    mockStmt.all.mockReturnValue([])

    const result = runObservationEval(mockWriter as any)

    expect(result).toBeNull()
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no observations'),
    )
  })

  it('counts mixed trends correctly', () => {
    const now = Date.now()
    mockStmt.all.mockReturnValue([
      { id: 'o1', metadata: JSON.stringify({ trend: 'stable' }), created_at: now - 86400000, updated_at: now },
      { id: 'o2', metadata: JSON.stringify({ trend: 'stale' }), created_at: now - 86400000 * 2, updated_at: now - 86400000 },
      { id: 'o3', metadata: JSON.stringify({ trend: 'new' }), created_at: now - 86400000, updated_at: now },
      { id: 'o4', metadata: JSON.stringify({ trend: 'strengthening' }), created_at: now - 86400000, updated_at: now },
      { id: 'o5', metadata: JSON.stringify({ trend: 'weakening' }), created_at: now - 86400000, updated_at: now },
    ])

    const result = runObservationEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.totalDiscovered).toBe(5)
    expect(s.reachedStable).toBe(1)   // o1
    expect(s.reachedStale).toBe(1)    // o2
    expect(s.currentActive).toBe(4)   // o1 + o3 + o4 + o5
  })

  it('counts older observations that are still active', () => {
    const now = Date.now()
    const longAgo = now - 60 * 24 * 60 * 60 * 1000 // 60 days ago (before periodStart)
    mockStmt.all.mockReturnValue([
      // Within period
      { id: 'o1', metadata: JSON.stringify({ trend: 'stable' }), created_at: now - 86400000, updated_at: now },
      // Before period, still active
      { id: 'o2', metadata: JSON.stringify({ trend: 'stable' }), created_at: longAgo, updated_at: now },
      // Before period, stale (should NOT be counted)
      { id: 'o3', metadata: JSON.stringify({ trend: 'stale' }), created_at: longAgo, updated_at: longAgo },
    ])

    const result = runObservationEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.totalDiscovered).toBe(1)          // only o1 in period
    expect(s.currentActive).toBe(2)            // o1 + o2
    expect(s.reachedStale).toBe(0)             // no period-row is stale
  })

  it('calculates lifespan from metadata firstSeen/lastSeen', () => {
    const now = Date.now()
    const firstSeen = now - 10 * 24 * 60 * 60 * 1000 // 10 days ago
    const lastSeen = now - 2 * 24 * 60 * 60 * 1000   // 2 days ago
    mockStmt.all.mockReturnValue([
      { id: 'o1', metadata: JSON.stringify({ trend: 'stable', firstSeen, lastSeen }), created_at: now - 86400000, updated_at: now },
    ])

    const result = runObservationEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // lifespan = (lastSeen - firstSeen) in days = 8 days
    expect(s.avgLifespanDays).toBe(8)
  })

  it('applies spaceId filter in SQL query', () => {
    mockStmt.all.mockReturnValue([]) // no data, just check query routing

    runObservationEval(mockWriter as any, 'space-99')

    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('AND space_id = ?'),
    )
    expect(mockStmt.all).toHaveBeenCalledWith('space-99')
  })

  it('falls back on unparseable metadata JSON', () => {
    const now = Date.now()
    mockStmt.all.mockReturnValue([
      { id: 'o1', metadata: '{bad json}', created_at: now - 86400000, updated_at: now },
    ])

    const result = runObservationEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    // Unparseable → trend defaults to 'new' → counted as active
    expect(s.totalDiscovered).toBe(1)
    expect(s.currentActive).toBe(1)
  })

  it('returns survivalRate = 0 when all observations are stale', () => {
    const now = Date.now()
    mockStmt.all.mockReturnValue([
      { id: 'o1', metadata: JSON.stringify({ trend: 'stale' }), created_at: now - 86400000, updated_at: now },
      { id: 'o2', metadata: JSON.stringify({ trend: 'stale' }), created_at: now - 86400000 * 2, updated_at: now },
    ])

    const result = runObservationEval(mockWriter as any)

    expect(result).not.toBeNull()
    const s = result!.scores as any
    expect(s.reachedStable).toBe(0)
    expect(s.reachedStale).toBe(2)
    expect(s.survivalRate).toBe(0)
  })
})
