import { describe, it, expect } from 'vitest'
import { classifyRisk } from '../src/scheduler/tasks/evolution-risk.js'
import type { EvolutionPlan } from '../src/scheduler/tasks/evolution-risk.js'

// ════════════════════════════════════════════════════════════
//  classifyRisk — pure function, zero dependencies
// ════════════════════════════════════════════════════════════

describe('classifyRisk', () => {
  const makePlan = (overrides: Partial<EvolutionPlan> = {}): EvolutionPlan => ({
    summary: 'test',
    changes: [],
    sourceBubbleId: 'b1',
    ...overrides,
  })

  it('returns low for empty changes', () => {
    expect(classifyRisk(makePlan({ changes: [] }))).toBe('low')
  })

  it('does not auto-return high for a single change', () => {
    // A single change in a safe path should NOT be auto-high
    const result = classifyRisk(makePlan({
      changes: [{ file: 'src/connector/tools/foo.ts', action: 'create', description: 'new tool' }],
    }))
    expect(result).toBe('low')
  })

  it('returns high for multiple changes', () => {
    expect(classifyRisk(makePlan({
      changes: [
        { file: 'src/connector/tools/a.ts', action: 'create', description: '' },
        { file: 'src/connector/tools/b.ts', action: 'create', description: '' },
      ],
    }))).toBe('high')
  })

  it('returns high for modify action', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/connector/tools/foo.ts', action: 'modify', description: '' }],
    }))).toBe('high')
  })

  it('returns low for create in LOW_RISK_CREATE_PATHS', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/connector/tools/my-tool.ts', action: 'create', description: '' }],
    }))).toBe('low')
  })

  it('returns low for create in scheduler tasks path', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/scheduler/tasks/my-task.ts', action: 'create', description: '' }],
    }))).toBe('low')
  })

  it('returns high for create outside safe paths', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/anywhere/else.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns high when file touches HIGH_RISK_PATH (src/kernel/)', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/kernel/brain.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns high when file touches HIGH_RISK_PATH (src/server/)', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/server/routes/agents.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns high when file touches HIGH_RISK_PATH (src/shared/)', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/shared/types.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns high when file touches HIGH_RISK_PATH (src/storage/)', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/storage/database.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns high when file touches HIGH_RISK_PATH (src/ai/)', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/ai/model.ts', action: 'create', description: '' }],
    }))).toBe('high')
  })

  it('returns low for append to .env', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: '.env', action: 'append', description: 'add DEBUG=true' }],
    }))).toBe('low')
  })

  it('returns high for append to non-.env file', () => {
    expect(classifyRisk(makePlan({
      changes: [{ file: 'src/config.json', action: 'append', description: '' }],
    }))).toBe('high')
  })

  it('returns high as default fallback when no rules match', () => {
    // Append to a non-.env file that's not in HIGH_RISK_PATHS
    expect(classifyRisk(makePlan({
      changes: [{ file: 'docs/readme.md', action: 'append', description: '' }],
    }))).toBe('high')
  })
})
