import { describe, it, expect } from 'vitest'
import { estimateTokens, truncateToTokenBudget, TOKEN_LIMITS } from '../src/shared/tokens.js'

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns 0 for null/undefined', () => {
    expect(estimateTokens(null as any)).toBe(0)
    expect(estimateTokens(undefined as any)).toBe(0)
  })

  it('estimates Chinese text (CJK characters)', () => {
    const text = '今天天气不错'  // 6 CJK chars
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('estimates English text', () => {
    const text = 'hello world this is a test'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(20)
  })

  it('estimates mixed Chinese/English text', () => {
    const text = '我的name是Bubble Agent，version是2.0'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
    expect(tokens).toBeLessThan(30)
  })

  it('estimates numbers', () => {
    const text = '12345 67890 3.14'
    const tokens = estimateTokens(text)
    expect(tokens).toBeGreaterThan(0)
  })

  it('handles long text proportionally', () => {
    const short = '你好世界'
    const long = '你好世界'.repeat(100)
    const shortTokens = estimateTokens(short)
    const longTokens = estimateTokens(long)
    // Long text should have roughly 100x the tokens
    expect(longTokens / shortTokens).toBeGreaterThan(50)
    expect(longTokens / shortTokens).toBeLessThan(150)
  })
})

describe('truncateToTokenBudget', () => {
  it('returns text unchanged if within budget', () => {
    const text = '短文本'
    expect(truncateToTokenBudget(text, 1000)).toBe(text)
  })

  it('truncates text that exceeds budget', () => {
    const text = '这是一段很长的测试文本'.repeat(100)
    const result = truncateToTokenBudget(text, 10)
    expect(result.length).toBeLessThan(text.length)
    expect(result).toContain('截断')
  })

  it('preserves the head of text', () => {
    const text = 'ABCDEF' + '测试'.repeat(500)
    const result = truncateToTokenBudget(text, 10)
    expect(result.startsWith('ABCDEF')).toBe(true)
  })
})

describe('TOKEN_LIMITS', () => {
  it('has expected constants', () => {
    expect(TOKEN_LIMITS.MAX_PROMPT_TOKENS).toBe(110_000)
    expect(TOKEN_LIMITS.COMPLETION_RESERVE).toBe(16_000)
    expect(TOKEN_LIMITS.MEMORY_BUDGET).toBe(60_000)
    expect(TOKEN_LIMITS.HISTORY_BUDGET).toBe(40_000)
    expect(TOKEN_LIMITS.SINGLE_BUBBLE_MAX).toBe(8_000)
  })

  it('COMPLETION_RESERVE is less than MAX_PROMPT_TOKENS', () => {
    expect(TOKEN_LIMITS.COMPLETION_RESERVE).toBeLessThan(TOKEN_LIMITS.MAX_PROMPT_TOKENS)
  })

  it('MEMORY_BUDGET + HISTORY_BUDGET fits within MAX_PROMPT_TOKENS', () => {
    expect(TOKEN_LIMITS.MEMORY_BUDGET + TOKEN_LIMITS.HISTORY_BUDGET)
      .toBeLessThanOrEqual(TOKEN_LIMITS.MAX_PROMPT_TOKENS)
  })
})
