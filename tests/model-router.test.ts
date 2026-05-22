import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ModelRouter } from '../src/ai/model-router.js'
import type { LLMProvider } from '../src/shared/types.js'

const { createLLMMock } = vi.hoisted(() => ({ createLLMMock: vi.fn() }))
vi.mock('../src/ai/llm.js', () => ({ createLLM: createLLMMock }))

function mockProvider(name: string): LLMProvider {
  return { chat: vi.fn(), chatStream: vi.fn(), _name: name } as any
}

const defaultConfig = {
  provider: 'deepseek' as const,
  apiKey: 'default-key',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
}

/** Run fn() with specific env vars set, then restore them. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k]
  }
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

describe('ModelRouter', () => {
  beforeEach(() => {
    createLLMMock.mockReset()
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LLM_') || key === 'DEEPSEEK_OPT_OUT') {
        delete process.env[key]
      }
    }
  })

  // ── constructor ───────────────────────────────────────────

  it('creates default provider once when no env overrides', () => {
    createLLMMock.mockReturnValue(mockProvider('default'))

    const router = new ModelRouter(defaultConfig)

    // createLLM is called 1× for default, 0× for categories (no env overrides)
    expect(createLLMMock).toHaveBeenCalledTimes(1)
    expect(createLLMMock).toHaveBeenCalledWith(defaultConfig)
    expect(router.forCategory('chat')).toBeDefined()
    expect(router.forCategory('biz')).toBeDefined()
    expect(router.forCategory('memory')).toBeDefined()
    expect(router.forCategory('search')).toBeDefined()
  })

  it('default getter returns the default provider', () => {
    const p = mockProvider('default')
    createLLMMock.mockReturnValue(p)

    const router = new ModelRouter(defaultConfig)
    expect(router.default).toBe(p)
  })

  // ── env overrides ─────────────────────────────────────────

  it('overrides chat category via env var', () => {
    createLLMMock.mockReturnValue(mockProvider('default'))

    const router = withEnv(
      { LLM_CHAT_PROVIDER: 'ollama', LLM_CHAT_MODEL: 'llama3', LLM_CHAT_BASE_URL: 'http://localhost:11434' },
      () => new ModelRouter(defaultConfig),
    )

    // createLLM called 2×: default + chat override
    expect(createLLMMock).toHaveBeenCalledTimes(2)
    const chatCall = createLLMMock.mock.calls[1]
    expect(chatCall[0].provider).toBe('ollama')
    expect(chatCall[0].model).toBe('llama3')
    expect(chatCall[0].baseUrl).toBe('http://localhost:11434')
  })

  it('overrides multiple categories independently', () => {
    createLLMMock.mockReturnValue(mockProvider('default'))

    const router = withEnv(
      {
        LLM_CHAT_PROVIDER: 'ollama',
        LLM_BIZ_PROVIDER: 'openai', LLM_BIZ_API_KEY: 'biz-key',
      },
      () => new ModelRouter(defaultConfig),
    )

    // createLLM called 3×: default + chat(ollama) + biz(openai)
    expect(createLLMMock).toHaveBeenCalledTimes(3)
    expect(createLLMMock.mock.calls[1][0].provider).toBe('ollama')
    expect(createLLMMock.mock.calls[2][0].provider).toBe('openai')
  })

  it('falls back to default when env override creation fails', () => {
    createLLMMock
      .mockReturnValueOnce(mockProvider('default'))  // default call succeeds
      .mockImplementationOnce(() => { throw new Error('Missing API key') }) // chat fails

    const router = withEnv(
      { LLM_CHAT_PROVIDER: 'openai' },
      () => new ModelRouter(defaultConfig),
    )

    expect(router.forCategory('chat')).toBeDefined()
    // createLLM was called 2× (default + chat attempt)
    expect(createLLMMock).toHaveBeenCalledTimes(2)
  })

  it('respects DEEPSEEK_OPT_OUT to skip override', () => {
    createLLMMock.mockReturnValue(mockProvider('default'))

    const router = withEnv(
      { LLM_CHAT_PROVIDER: 'deepseek', DEEPSEEK_OPT_OUT: 'chat' },
      () => new ModelRouter({ ...defaultConfig, provider: 'deepseek' }),
    )

    // createLLM called only 1× — chat override suppressed by opt-out
    expect(createLLMMock).toHaveBeenCalledTimes(1)
  })

  it('uses default config for un-overridden categories', () => {
    createLLMMock.mockReturnValue(mockProvider('default'))

    const router = withEnv(
      { LLM_CHAT_PROVIDER: 'ollama' },
      () => new ModelRouter(defaultConfig),
    )

    // chat is overridden, the other 3 use default (not re-created)
    expect(createLLMMock).toHaveBeenCalledTimes(2)
    // First call is always the default
    expect(createLLMMock.mock.calls[0][0]).toEqual(defaultConfig)
  })

  // ── forCategory ───────────────────────────────────────────

  it('forCategory returns default for unknown category', () => {
    const p = mockProvider('default')
    createLLMMock.mockReturnValue(p)

    const router = new ModelRouter(defaultConfig)
    expect(router.forCategory('unknown' as any)).toBe(p)
  })

  it('forCategory returns distinct providers when overridden', () => {
    const defaultP = mockProvider('default')
    const chatP = mockProvider('ollama-provider')
    createLLMMock
      .mockReturnValueOnce(defaultP)
      .mockReturnValueOnce(chatP)

    const router = withEnv(
      { LLM_CHAT_PROVIDER: 'ollama' },
      () => new ModelRouter(defaultConfig),
    )

    expect(router.forCategory('chat')).toBe(chatP)
    expect(router.forCategory('biz')).toBe(defaultP)
  })
})
