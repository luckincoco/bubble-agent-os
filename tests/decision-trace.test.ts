import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../src/storage/database.js'
import { recordDecisionTrace, queryDecisionTraces, getTraceStats } from '../src/memory/decision-trace.js'

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-trace-'))
  initDatabase(dir)
})

describe('recordDecisionTrace', () => {
  it('records a trace with matched items', () => {
    const trace = recordDecisionTrace({
      sourceType: 'steel_price',
      triggerId: 'bubble-1',
      matchedItems: [
        { label: '沙钢 螺纹钢 Φ25 ¥3,420/吨', matchReason: '库存 50 吨匹配', confidence: 0.9 },
      ],
      pushed: true,
      executionMs: 1234,
    })
    expect(trace.id).toBeTruthy()
    expect(trace.sourceType).toBe('steel_price')
    expect(trace.triggerId).toBe('bubble-1')
    expect(trace.matchedItems).toHaveLength(1)
    expect(trace.matchedItems[0].label).toContain('沙钢')
    expect(trace.pushed).toBe(true)
    expect(trace.executionMs).toBe(1234)
    expect(trace.createdAt).toBeGreaterThan(0)
  })

  it('records a trace with empty matched items', () => {
    const trace = recordDecisionTrace({
      sourceType: 'daily_briefing',
      pushed: false,
      executionMs: 0,
    })
    expect(trace.matchedItems).toEqual([])
    expect(trace.pushed).toBe(false)
  })
})

describe('queryDecisionTraces', () => {
  beforeAll(() => {
    recordDecisionTrace({ sourceType: 'steel_price', triggerId: 'b-1', matchedItems: [{ label: 'A', matchReason: 'r1', confidence: 0.8 }], pushed: true, executionMs: 100 })
    recordDecisionTrace({ sourceType: 'steel_price', triggerId: 'b-2', matchedItems: [{ label: 'B', matchReason: 'r2', confidence: 0.9 }], pushed: true, executionMs: 200 })
    recordDecisionTrace({ sourceType: 'daily_briefing', pushed: true, executionMs: 50 })
  })

  it('returns all traces when no filter', () => {
    const traces = queryDecisionTraces({ limit: 10 })
    expect(traces.length).toBeGreaterThanOrEqual(3)
  })

  it('filters by sourceType', () => {
    const traces = queryDecisionTraces({ sourceType: 'steel_price' })
    expect(traces.every(t => t.sourceType === 'steel_price')).toBe(true)
  })
})

describe('getTraceStats', () => {
  it('returns stats for a source type', () => {
    const stats = getTraceStats('steel_price')
    expect(stats.totalTraces).toBeGreaterThanOrEqual(2)
    expect(stats.avgMatchItems).toBeGreaterThan(0)
    expect(stats.avgExecutionMs).toBeGreaterThan(0)
    expect(stats.pushRate).toBe(100)
  })

  it('returns zeros for unknown source type', () => {
    const stats = getTraceStats('nonexistent')
    expect(stats.totalTraces).toBe(0)
    expect(stats.avgMatchItems).toBe(0)
    expect(stats.avgExecutionMs).toBe(0)
    expect(stats.pushRate).toBe(0)
  })
})
