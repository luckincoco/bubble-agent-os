import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── vi.hoisted: shared mock objects for vi.mock factories ────────

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

const mockCreateAgent = vi.hoisted(() => vi.fn(() => ({ id: 'agent-new' })))

const mockStmt = vi.hoisted(() => ({ get: vi.fn() }))
const mockDb = vi.hoisted(() => ({ prepare: vi.fn(() => mockStmt) }))

// ── Module-level mocks ──────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/agent/model.js', () => ({ createAgent: mockCreateAgent }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

// ── Imports ─────────────────────────────────────────────────────

import { seedAskAgent } from '../src/agent/seed-agents.js'

// ══════════════════════════════════════════════════════════════════
//  Seed Agents
// ══════════════════════════════════════════════════════════════════

describe('seedAskAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStmt.get.mockReset()
    mockCreateAgent.mockReset()
    mockCreateAgent.mockReturnValue({ id: 'agent-new' })
  })

  it('skips when agent already exists in DB', () => {
    mockStmt.get.mockReturnValue({ id: 'existing-id' })

    seedAskAgent()

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('already exists'),
    )
    expect(mockCreateAgent).not.toHaveBeenCalled()
  })

  it('creates agent when not found in DB', () => {
    mockStmt.get.mockReturnValue(undefined)

    seedAskAgent()

    expect(mockCreateAgent).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('created'),
    )
  })

  it('passes correct agent configuration to createAgent', () => {
    mockStmt.get.mockReturnValue(undefined)

    seedAskAgent()

    expect(mockCreateAgent).toHaveBeenCalledWith({
      name: '问',
      description: expect.any(String),
      systemPrompt: expect.any(String),
      avatar: '?',
      tools: [],
      spaceIds: [],
      creatorId: 'system',
    })
  })

  it('uses correct DB query to check for existing agent', () => {
    mockStmt.get.mockReturnValue(undefined)

    seedAskAgent()

    expect(mockDb.prepare).toHaveBeenCalledWith(
      expect.stringContaining('SELECT id FROM custom_agents'),
    )
    expect(mockStmt.get).toHaveBeenCalledWith('问')
  })

  it('logs the existing agent ID on skip', () => {
    mockStmt.get.mockReturnValue({ id: 'existing-abc-123' })

    seedAskAgent()

    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.stringContaining('existing-abc-123'),
    )
  })
})
