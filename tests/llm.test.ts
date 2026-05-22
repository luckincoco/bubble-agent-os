import { describe, it, expect } from 'vitest'
import { createLLM } from '../src/ai/llm.js'

function makeConfig(overrides: Partial<Record<string, string | undefined>> = {}) {
  return {
    provider: 'openai',
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    model: 'gpt-4o',
    ...overrides,
  } as any
}

describe('createLLM', () => {
  it('returns a provider with chat and chatStream for openai', () => {
    const provider = createLLM(makeConfig({ provider: 'openai' }))
    expect(provider).toHaveProperty('chat')
    expect(provider).toHaveProperty('chatStream')
    expect(typeof provider.chat).toBe('function')
    expect(typeof provider.chatStream).toBe('function')
  })

  it('returns a provider with chat and chatStream for deepseek', () => {
    const provider = createLLM(makeConfig({ provider: 'deepseek' }))
    expect(provider).toHaveProperty('chat')
    expect(provider).toHaveProperty('chatStream')
    expect(typeof provider.chat).toBe('function')
    expect(typeof provider.chatStream).toBe('function')
  })

  it('returns a provider with chat and chatStream for ollama', () => {
    const provider = createLLM(makeConfig({ provider: 'ollama' }))
    expect(provider).toHaveProperty('chat')
    expect(provider).toHaveProperty('chatStream')
    expect(typeof provider.chat).toBe('function')
    expect(typeof provider.chatStream).toBe('function')
  })

  it('throws when apiKey is missing for openai', () => {
    expect(() => createLLM(makeConfig({ provider: 'openai', apiKey: '' }))).toThrow(
      'Missing API key for openai',
    )
  })

  it('throws when apiKey is missing for deepseek', () => {
    expect(() => createLLM(makeConfig({ provider: 'deepseek', apiKey: '' }))).toThrow(
      'Missing API key for deepseek',
    )
  })

  it('does not throw when apiKey is missing for ollama', () => {
    expect(() => createLLM(makeConfig({ provider: 'ollama', apiKey: '' }))).not.toThrow()
  })

  it('throws for unknown provider', () => {
    expect(() => createLLM(makeConfig({ provider: 'unknown' }))).toThrow(
      'Unknown LLM provider: unknown',
    )
  })
})
