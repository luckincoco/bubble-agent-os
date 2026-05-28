import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { SimpleFetcher } from '../src/connector/tools/simple-fetcher.js'

// Mock fetch to avoid sandbox network restrictions
const originalFetch = globalThis.fetch
beforeAll(() => {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch blocked'))
})
afterAll(() => {
  globalThis.fetch = originalFetch
})

describe('SimpleFetcher', () => {
  it('constructs with default options', () => {
    const f = new SimpleFetcher()
    expect(f).toBeInstanceOf(SimpleFetcher)
  })

  it('constructs with custom maxLength', () => {
    const f = new SimpleFetcher({ maxLength: 100 })
    expect(f).toBeInstanceOf(SimpleFetcher)
  })

  it('fetchText throws when fetch fails', async () => {
    const f = new SimpleFetcher({ timeout: 100 })
    await expect(f.fetchText('https://example.com')).rejects.toThrow('fetch blocked')
  })
})
