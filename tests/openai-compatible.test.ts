import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createOpenAIProvider } from '../src/ai/providers/openai-compatible.js'

const config = { apiKey: 'test-key', baseUrl: 'https://api.test.com', model: 'gpt-4o' }
const messages = [{ role: 'user' as const, content: 'hello' }]

describe('createOpenAIProvider', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ── shape ─────────────────────────────────────────────────

  it('returns an object with chat and chatStream functions', () => {
    const provider = createOpenAIProvider(config)
    expect(provider).toHaveProperty('chat')
    expect(provider).toHaveProperty('chatStream')
    expect(typeof provider.chat).toBe('function')
    expect(typeof provider.chatStream).toBe('function')
  })

  // ── chat ──────────────────────────────────────────────────

  it('chat sends correct request and returns parsed response', async () => {
    let captured: any
    globalThis.fetch = async (url, opts: any) => {
      captured = { url, ...opts }
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello!' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }))
    }

    const provider = createOpenAIProvider(config)
    const result = await provider.chat(messages)

    expect(captured.url).toBe('https://api.test.com/v1/chat/completions')
    expect(captured.headers['Content-Type']).toBe('application/json')
    expect(captured.headers['Authorization']).toBe('Bearer test-key')
    expect(JSON.parse(captured.body)).toEqual({
      model: 'gpt-4o', messages, stream: false,
    })

    expect(result.content).toBe('Hello!')
    expect(result.usage).toEqual({
      promptTokens: 10, completionTokens: 5, totalTokens: 15,
    })
  })

  it('chat handles empty content when no choices returned', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [],
    }))

    const provider = createOpenAIProvider(config)
    const result = await provider.chat(messages)
    expect(result.content).toBe('')
    expect(result.usage).toBeUndefined()
  })

  it('chat throws on HTTP error', async () => {
    globalThis.fetch = async () => new Response('Rate limit', { status: 429 })

    const provider = createOpenAIProvider(config)
    await expect(provider.chat(messages)).rejects.toThrow('LLM API error 429')
  })

  it('chat throws on network error', async () => {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }

    const provider = createOpenAIProvider(config)
    await expect(provider.chat(messages)).rejects.toThrow('connect ECONNREFUSED')
  })

  // ── chatStream ────────────────────────────────────────────

  it('chatStream yields chunks via onChunk and returns full content', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n'))
        controller.close()
      },
    }))

    const provider = createOpenAIProvider(config)
    const chunks: string[] = []
    const result = await provider.chatStream(messages, (text) => { chunks.push(text) })

    expect(chunks).toEqual(['Hello', ' World'])
    expect(result.content).toBe('Hello World')
  })

  it('chatStream handles single chunk', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Only chunk"}}]}\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n'))
        controller.close()
      },
    }))

    const provider = createOpenAIProvider(config)
    const chunks: string[] = []
    const result = await provider.chatStream(messages, (text) => { chunks.push(text) })
    expect(chunks).toEqual(['Only chunk'])
    expect(result.content).toBe('Only chunk')
  })

  it('chatStream handles empty response', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: [DONE]\n'))
        controller.close()
      },
    }))

    const provider = createOpenAIProvider(config)
    const chunks: string[] = []
    const result = await provider.chatStream(messages, (text) => { chunks.push(text) })
    expect(chunks).toEqual([])
    expect(result.content).toBe('')
  })

  it('chatStream throws on HTTP error', async () => {
    globalThis.fetch = async () => new Response('Unauthorized', { status: 401 })

    const provider = createOpenAIProvider(config)
    await expect(
      provider.chatStream(messages, () => {}),
    ).rejects.toThrow('LLM API error 401')
  })

  it('chatStream throws on missing response body', async () => {
    globalThis.fetch = async () => new Response(null, { status: 200 })

    const provider = createOpenAIProvider(config)
    await expect(
      provider.chatStream(messages, () => {}),
    ).rejects.toThrow('No response body')
  })

  it('chatStream handles content-less delta gracefully', async () => {
    const encoder = new TextEncoder()
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{}}]}\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n'))
        controller.close()
      },
    }))

    const provider = createOpenAIProvider(config)
    const result = await provider.chatStream(messages, () => {})
    expect(result.content).toBe('')
  })
})
