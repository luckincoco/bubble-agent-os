import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cosineSimilarity, createEmbeddingProvider } from '../src/ai/embeddings.js'

// ── cosineSimilarity (pure function, no DB/network) ─────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 5)
  })

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5)
  })

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1.0, 5)
  })

  it('returns a value between -1 and 1 for partially similar vectors', () => {
    const result = cosineSimilarity([1, 2, 3], [2, 3, 4])
    expect(result).toBeGreaterThan(-1)
    expect(result).toBeLessThan(1)
    expect(result).toBeGreaterThan(0)
  })

  it('returns 0 when vectors have different lengths', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
  })

  it('returns 0 when vectors are empty', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  it('handles single-element vectors', () => {
    expect(cosineSimilarity([5], [5])).toBeCloseTo(1.0, 5)
    expect(cosineSimilarity([5], [-5])).toBeCloseTo(-1.0, 5)
  })

  it('handles zero vectors gracefully', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0)
  })
})

// ── createEmbeddingProvider ──────────────────────────────────

describe('createEmbeddingProvider', () => {
  const config = { apiKey: 'test-key', baseUrl: 'https://api.test.com', model: 'test-model' }

  it('returns an object with embed and embedBatch functions', () => {
    const provider = createEmbeddingProvider(config)
    expect(provider).toHaveProperty('embed')
    expect(provider).toHaveProperty('embedBatch')
    expect(typeof provider.embed).toBe('function')
    expect(typeof provider.embedBatch).toBe('function')
  })

  describe('with mocked fetch', () => {
    let originalFetch: typeof globalThis.fetch

    beforeEach(() => {
      originalFetch = globalThis.fetch
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
    })

    it('embed returns a promise that resolves to an embedding vector', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({
        data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
      }))
      const provider = createEmbeddingProvider(config)
      const result = await provider.embed('test text')
      expect(Array.isArray(result)).toBe(true)
      expect(result).toEqual([0.1, 0.2, 0.3])
    })

    it('embedBatch returns embeddings in index order', async () => {
      globalThis.fetch = async () => new Response(JSON.stringify({
        data: [
          { embedding: [0.3, 0.4], index: 1 },
          { embedding: [0.1, 0.2], index: 0 },
        ],
      }))
      const provider = createEmbeddingProvider(config)
      const result = await provider.embedBatch(['first', 'second'])
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual([0.1, 0.2])
      expect(result[1]).toEqual([0.3, 0.4])
    })

    it('handles API errors gracefully', async () => {
      globalThis.fetch = async () => new Response('Rate limit exceeded', { status: 429 })
      const provider = createEmbeddingProvider(config)
      await expect(provider.embed('test')).rejects.toThrow('Embedding API error 429')
    })

    it('handles network errors', async () => {
      globalThis.fetch = async () => { throw new Error('Network failure') }
      const provider = createEmbeddingProvider(config)
      await expect(provider.embed('test')).rejects.toThrow('Network failure')
    })
  })
})
