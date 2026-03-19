import { describe, it, expect } from 'vitest'
import { tokenize, FocusTracker } from '../src/memory/focus-tracker.js'

describe('tokenize', () => {
  it('splits text into lowercase terms', () => {
    const result = tokenize('Hello World')
    expect(result.has('hello')).toBe(true)
    expect(result.has('world')).toBe(true)
  })

  it('filters out single-char terms', () => {
    const result = tokenize('a b cd ef')
    expect(result.has('a')).toBe(false)
    expect(result.has('b')).toBe(false)
    expect(result.has('cd')).toBe(true)
    expect(result.has('ef')).toBe(true)
  })

  it('splits on Chinese punctuation', () => {
    const result = tokenize('产品，供应商。客户')
    expect(result.has('产品')).toBe(true)
    expect(result.has('供应商')).toBe(true)
    expect(result.has('客户')).toBe(true)
  })

  it('returns empty set for empty string', () => {
    const result = tokenize('')
    expect(result.size).toBe(0)
  })

  it('returns empty set for only short tokens', () => {
    const result = tokenize('a b c')
    expect(result.size).toBe(0)
  })

  it('deduplicates terms', () => {
    const result = tokenize('hello hello hello')
    expect(result.size).toBe(1)
  })
})

describe('FocusTracker', () => {
  it('returns 0 boost when no focus data recorded', () => {
    const tracker = new FocusTracker()
    const boost = tracker.computeFocusBoost('user1', '任何内容')
    expect(boost).toBe(0)
  })

  it('returns positive boost for matching content', () => {
    const tracker = new FocusTracker()
    // Use comma-separated terms so tokenizer produces overlapping 2+ char tokens
    tracker.record('user1', '钢材，采购，价格，分析')
    const boost = tracker.computeFocusBoost('user1', '钢材，价格，走势，采购，策略')
    expect(boost).toBeGreaterThan(0)
  })

  it('returns 0 for non-matching content', () => {
    const tracker = new FocusTracker()
    tracker.record('user1', '钢材采购价格')
    const boost = tracker.computeFocusBoost('user1', 'completely unrelated english text nothing')
    expect(boost).toBe(0)
  })

  it('boost is capped at MAX_BOOST (0.15)', () => {
    const tracker = new FocusTracker()
    // Record the same topic repeatedly to build high frequency
    for (let i = 0; i < 10; i++) {
      tracker.record('user1', '钢材采购钢材采购钢材采购')
    }
    const boost = tracker.computeFocusBoost('user1', '钢材采购钢材采购')
    expect(boost).toBeLessThanOrEqual(0.15)
  })

  it('isolates users', () => {
    const tracker = new FocusTracker()
    tracker.record('user1', '钢材，采购，分析')
    const boost1 = tracker.computeFocusBoost('user1', '钢材，采购')
    const boost2 = tracker.computeFocusBoost('user2', '钢材，采购')
    expect(boost1).toBeGreaterThan(0)
    expect(boost2).toBe(0)
  })

  it('returns 0 boost for empty bubble content', () => {
    const tracker = new FocusTracker()
    tracker.record('user1', '钢材采购')
    const boost = tracker.computeFocusBoost('user1', '')
    expect(boost).toBe(0)
  })
})
