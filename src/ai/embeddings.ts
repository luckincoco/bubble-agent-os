import type { EmbeddingProvider } from '../shared/types.js'
import { logger } from '../shared/logger.js'

interface EmbeddingConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  const { apiKey, baseUrl, model } = config

  async function embed(text: string): Promise<number[]> {
    const result = await embedBatch([text])
    return result[0]
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${baseUrl}/v1/embeddings`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Embedding API error ${res.status}: ${text}`)
    }

    const data = await res.json() as {
      data: { embedding: number[]; index: number }[]
    }

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding)
  }

  return { embed, embedBatch }
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}
