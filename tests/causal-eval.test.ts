import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

const mockStmt = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() }))
const mockDb = vi.hoisted(() => ({ prepare: vi.fn(() => mockStmt) }))

const mockUlid = vi.hoisted(() => vi.fn(() => 'eval-ulid-001'))

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('ulid', () => ({ ulid: mockUlid }))

// ── Imports ────────────────────────────────────────────────

import { runCausalEval } from '../src/observability/eval/causal-eval.js'

// ════════════════════════════════════════════════════════════
//  runCausalEval
// ════════════════════════════════════════════════════════════

describe('runCausalEval', () => {
  const mockWriter = { writeEvalResult: vi.fn() }

  beforeEach(() => {
    vi.clearAllMocks()
    mockStmt.all.mockReset()
    mockStmt.get.mockReset()
    mockUlid.mockReturnValue('eval-ulid-001')
    mockWriter.writeEvalResult.mockReset()
  })

  it('returns null when no urgency events exist', () => {
    mockStmt.all.mockReturnValue([]) // both queries return empty

    const result = runCausalEval(mockWriter as any)

    expect(result).toBeNull()
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no urgency events'),
    )
    expect(mockWriter.writeEvalResult).not.toHaveBeenCalled()
  })

  it('computes contradiction precision correctly', () => {
    const now = Date.now()
    // Urgency events: 2 contradicts
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000, payload: JSON.stringify({ impactType: 'contradicts', bubbleId: 'b1' }) },
        { id: 'u2', timestamp: now - 86400000 * 2, payload: JSON.stringify({ impactType: 'contradicts', bubbleId: 'b2' }) },
      ])
      .mockReturnValueOnce([
        // Both have subsequent weakened events within 7 days
        { type: 'knowledge.observation.weakened', timestamp: now - 43200000, payload: '{}' },
        { type: 'knowledge.observation.weakened', timestamp: now - 86400000 * 2 + 3600000, payload: '{}' },
      ])

    const result = runCausalEval(mockWriter as any)

    expect(result).not.toBeNull()
    expect((result!.scores as any).contradictionPrecision).toBe(1)
    expect((result!.scores as any).confirmationPrecision).toBe(0)
    expect(mockWriter.writeEvalResult).toHaveBeenCalled()
  })

  it('computes contradiction precision as 0 when no subsequent changes', () => {
    const now = Date.now()
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000, payload: JSON.stringify({ impactType: 'contradicts', bubbleId: 'b1' }) },
      ])
      .mockReturnValueOnce([]) // no obs events at all

    const result = runCausalEval(mockWriter as any)

    expect(result).not.toBeNull()
    expect((result!.scores as any).contradictionPrecision).toBe(0)
    expect((result!.scores as any).totalVerdicts).toBe(1)
  })

  it('computes confirmation precision with mixed results', () => {
    const now = Date.now()
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000, payload: JSON.stringify({ impactType: 'confirms', bubbleId: 'b1' }) },
        { id: 'u2', timestamp: now - 86400000 * 2, payload: JSON.stringify({ impactType: 'confirms', bubbleId: 'b2' }) },
      ])
      .mockReturnValueOnce([
        // Only one subsequent strengthened — placed between u2 and u1 so only u2 sees it
        { type: 'knowledge.observation.strengthened', timestamp: now - 86400000 * 2 + 3600000, payload: '{}' },
      ])

    const result = runCausalEval(mockWriter as any)

    expect(result).not.toBeNull()
    expect((result!.scores as any).confirmationPrecision).toBe(0.5)
    expect((result!.scores as any).contradictionPrecision).toBe(0)
  })

  it('skips events with unparseable JSON payload', () => {
    const now = Date.now()
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000, payload: '{invalid}' },
        { id: 'u2', timestamp: now - 86400000, payload: JSON.stringify({ impactType: 'contradicts', bubbleId: 'b1' }) },
      ])
      .mockReturnValueOnce([])

    const result = runCausalEval(mockWriter as any)

    expect(result).not.toBeNull()
    // totalVerdicts counts all urgency events (before parse), so 2 not 1
    expect((result!.scores as any).totalVerdicts).toBe(2)
    // u1 skipped → only u2 counted for precision (no obs events → 0)
    expect((result!.scores as any).contradictionPrecision).toBe(0)
  })

  it('filters subsequent events outside 7-day window', () => {
    const now = Date.now()
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000 * 10, payload: JSON.stringify({ impactType: 'contradicts', bubbleId: 'b1' }) },
      ])
      .mockReturnValueOnce([
        // Within 7 days of u1
        { type: 'knowledge.observation.weakened', timestamp: now - 86400000 * 10 + 3600000, payload: '{}' },
        // Outside 7-day window (too far after u1)
        { type: 'knowledge.observation.weakened', timestamp: now - 86400000 * 10 + SEVEN_DAYS_MS + 1, payload: '{}' },
      ])

    const result = runCausalEval(mockWriter as any)

    expect(result).not.toBeNull()
    // contradiction should be correct (at least one weakened inside window)
    expect((result!.scores as any).contradictionPrecision).toBe(1)
    // totalVerdicts = 1 (only u1 is counted)
    expect((result!.scores as any).totalVerdicts).toBe(1)
  })

  it('passes spaceId through to EvalResult', () => {
    const now = Date.now()
    mockStmt.all
      .mockReturnValueOnce([
        { id: 'u1', timestamp: now - 86400000, payload: JSON.stringify({ impactType: 'confirms', bubbleId: 'b1' }) },
      ])
      .mockReturnValueOnce([])

    const result = runCausalEval(mockWriter as any, 'space-42')

    expect(result).not.toBeNull()
    expect(result!.spaceId).toBe('space-42')
  })
})
