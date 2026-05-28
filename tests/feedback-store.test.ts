import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initDatabase } from '../src/storage/database.js'
import { recordFeedback, queryFeedback, getFeedbackStats } from '../src/memory/feedback-store.js'

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'bubble-feedback-'))
  initDatabase(dir)
})

describe('recordFeedback', () => {
  it('records a delivered event', () => {
    const event = recordFeedback('user-1', 'steel_price', 'delivered', {
      sourceId: 'msg-1',
      context: { date: '2026-05-28', matchedProducts: 3 },
    })
    expect(event.id).toBeTruthy()
    expect(event.userId).toBe('user-1')
    expect(event.sourceType).toBe('steel_price')
    expect(event.action).toBe('delivered')
    expect(event.context.date).toBe('2026-05-28')
    expect(event.createdAt).toBeGreaterThan(0)
  })

  it('records a read event', () => {
    const event = recordFeedback('user-1', 'daily_briefing', 'read', { sourceId: 'msg-2' })
    expect(event.action).toBe('read')
  })

  it('records acted and dismissed events', () => {
    recordFeedback('user-1', 'steel_price', 'acted', { sourceId: 'msg-1', context: { action: 'called_supplier' } })
    recordFeedback('user-1', 'steel_price', 'dismissed', { sourceId: 'msg-3' })
    recordFeedback('user-2', 'steel_price', 'delivered', { sourceId: 'msg-4' })
  })
})

describe('queryFeedback', () => {
  it('returns all events when no filter', () => {
    const events = queryFeedback({ limit: 10 })
    expect(events.length).toBeGreaterThanOrEqual(5)
  })

  it('filters by sourceType', () => {
    const events = queryFeedback({ sourceType: 'steel_price' })
    expect(events.every(e => e.sourceType === 'steel_price')).toBe(true)
  })

  it('filters by action', () => {
    const events = queryFeedback({ action: 'delivered' })
    expect(events.every(e => e.action === 'delivered')).toBe(true)
  })

  it('filters by userId', () => {
    const events = queryFeedback({ userId: 'user-2' })
    expect(events.every(e => e.userId === 'user-2')).toBe(true)
  })
})

describe('getFeedbackStats', () => {
  it('returns counts by action', () => {
    const stats = getFeedbackStats('steel_price')
    expect(stats.delivered).toBeGreaterThanOrEqual(2)
    expect(stats.acted).toBe(1)
    expect(stats.dismissed).toBe(1)
  })

  it('returns empty object for unknown source', () => {
    const stats = getFeedbackStats('nonexistent')
    expect(Object.keys(stats)).toHaveLength(0)
  })
})
