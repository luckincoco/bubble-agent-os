import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getConfig } from '../src/shared/config.js'

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock, readFileSync: readFileSyncMock }))

/** Run fn() with specific env vars set, then restore them. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) saved[k] = process.env[k]
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

/** Env vars that getConfig might read or set */
const CONFIG_ENV_KEYS = [
  'LLM_PROVIDER', 'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL',
  'DATA_DIR', 'JWT_SECRET', 'DEFAULT_PASSWORD', 'SERVICE_API_KEY',
  'DEEPSEEK_API_KEY', 'OPENAI_API_KEY',
  'FEISHU_APP_ID', 'FEISHU_APP_SECRET',
  'WECOM_CORP_ID', 'WECOM_SECRET', 'WECOM_AGENT_ID', 'WECOM_TOKEN', 'WECOM_ENCODING_AES_KEY',
  'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION',
  'FOCUS_TRACKING', 'SEMANTIC_BRIDGE', 'SURPRISE_DETECTION', 'CODE_TOOLS',
  'SELF_EVOLUTION', 'MARKITDOWN', 'EVENT_SOURCING', 'TEMPORAL_GRAPH',
  'MEMORY_VIEWS', 'WORKING_MEMORY', 'COGNITION_ORIENTATION', 'COGNITION_EVALUATOR',
  'COGNITION_INTERNAL', 'COGNITION_CASCADE', 'COGNITION_GAP_TRIGGER',
  'TASK_LEDGER', 'BOUNDARY_CHECKER', 'ACTION_PLANNER',
  'DRAFT_OBSERVATIONS', 'ASSERTION_IDENTIFICATION', 'MY_CUSTOM_VAR',
]

describe('getConfig', () => {
  let cwdSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    existsSyncMock.mockReset()
    readFileSyncMock.mockReset()
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test')
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    for (const key of CONFIG_ENV_KEYS) {
      delete process.env[key]
    }
  })

  // ── defaults ──────────────────────────────────────────

  it('returns default deepseek config when no .env and no env vars', () => {
    existsSyncMock.mockReturnValue(false)
    const config = getConfig()
    expect(config.llm.provider).toBe('deepseek')
    expect(config.llm.apiKey).toBe('')
    expect(config.llm.baseUrl).toBe('https://api.deepseek.com')
    expect(config.llm.model).toBe('deepseek-chat')
    expect(config.storage.dataDir).toContain('.bubble-agent')
    expect(config.auth.jwtSecret).toBe('')
    expect(config.auth.defaultPassword).toBe('changeme')
    expect(config.auth.serviceApiKey).toBeUndefined()
    expect(config.features.focusTracking).toBe(true)
    expect(config.features.codeTools).toBe(false)
    expect(config.features.selfEvolution).toBe(false)
    expect(config.features.surpriseDetection).toBe(true)
    expect(config.features.assertionIdentification).toBe(false)
    expect(config.features.boundaryRuleSelfEvolution).toBe(false)
  })

  // ── .env file ─────────────────────────────────────────

  it('reads values from .env file', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue('LLM_PROVIDER=ollama\nLLM_BASE_URL=http://localhost:11434')
    const config = getConfig()
    expect(config.llm.provider).toBe('ollama')
    expect(config.llm.baseUrl).toBe('http://localhost:11434')
  })

  it('skips comments and blank lines in .env', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue('# comment\n\nLLM_MODEL=my-model\n# another\n')
    const config = getConfig()
    expect(config.llm.model).toBe('my-model')
    expect(config.llm.provider).toBe('deepseek') // default from LLM_PROVIDER not set
  })

  it('syncs .env values to process.env', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue('MY_CUSTOM_VAR=hello')
    getConfig()
    expect(process.env.MY_CUSTOM_VAR).toBe('hello')
  })

  it('does not override existing process.env with .env values', () => {
    withEnv({ MY_CUSTOM_VAR: 'existing' }, () => {
      existsSyncMock.mockReturnValue(true)
      readFileSyncMock.mockReturnValue('MY_CUSTOM_VAR=fromfile')
      getConfig()
      expect(process.env.MY_CUSTOM_VAR).toBe('existing')
    })
    delete process.env.MY_CUSTOM_VAR
  })

  // ── process.env override ──────────────────────────────

  it('process.env overrides .env file', () => {
    existsSyncMock.mockReturnValue(true)
    readFileSyncMock.mockReturnValue('LLM_PROVIDER=ollama')
    const config = withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-123' }, () => getConfig())
    expect(config.llm.provider).toBe('openai')
    expect(config.llm.apiKey).toBe('sk-123')
  })

  // ── provider defaults ─────────────────────────────────

  it('uses openai defaults when provider is openai', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ LLM_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-xxx' }, () => getConfig())
    expect(config.llm.baseUrl).toBe('https://api.openai.com')
    expect(config.llm.model).toBe('gpt-4o-mini')
    expect(config.llm.apiKey).toBe('sk-xxx')
  })

  it('uses ollama defaults when provider is ollama', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ LLM_PROVIDER: 'ollama' }, () => getConfig())
    expect(config.llm.baseUrl).toBe('http://localhost:11434')
    expect(config.llm.model).toBe('llama3')
    expect(config.llm.apiKey).toBe('') // ollama requires no key
  })

  it('falls back to LLM_API_KEY when provider-specific key missing', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ LLM_API_KEY: 'fallback-key' }, () => getConfig())
    expect(config.llm.apiKey).toBe('fallback-key')
  })

  // ── feature flags ─────────────────────────────────────

  it('parses feature flags from env', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({
      FOCUS_TRACKING: 'false',
      CODE_TOOLS: 'true',
      SELF_EVOLUTION: 'true',
      ASSERTION_IDENTIFICATION: 'true',
    }, () => getConfig())
    expect(config.features.focusTracking).toBe(false)
    expect(config.features.codeTools).toBe(true)
    expect(config.features.selfEvolution).toBe(true)
    expect(config.features.assertionIdentification).toBe(true)
    // defaults unchanged
    expect(config.features.surpriseDetection).toBe(true)
    expect(config.features.eventSourcing).toBe(true)
  })

  // ── optional sections ─────────────────────────────────

  it('includes feishu config when env vars present', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ FEISHU_APP_ID: 'cli_xxx', FEISHU_APP_SECRET: 'secret' }, () => getConfig())
    expect(config.feishu).toBeDefined()
    expect(config.feishu!.appId).toBe('cli_xxx')
    expect(config.feishu!.appSecret).toBe('secret')
  })

  it('includes wecom config when env vars present', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({
      WECOM_CORP_ID: 'corp', WECOM_SECRET: 'sec',
      WECOM_AGENT_ID: '1000001', WECOM_TOKEN: 'tok', WECOM_ENCODING_AES_KEY: 'aes',
    }, () => getConfig())
    expect(config.wecom).toBeDefined()
    expect(config.wecom!.corpId).toBe('corp')
    expect(config.wecom!.agentId).toBe(1000001)
    expect(config.wecom!.token).toBe('tok')
  })

  it('wecom agentId defaults to 0 when not set', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ WECOM_CORP_ID: 'corp', WECOM_SECRET: 'sec' }, () => getConfig())
    expect(config.wecom!.agentId).toBe(0)
  })

  it('includes tencent config when env vars present', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({
      TENCENT_SECRET_ID: 'sid', TENCENT_SECRET_KEY: 'skey', TENCENT_REGION: 'ap-shanghai',
    }, () => getConfig())
    expect(config.tencent).toBeDefined()
    expect(config.tencent!.secretId).toBe('sid')
    expect(config.tencent!.region).toBe('ap-shanghai')
  })

  // ── auth & data dir ───────────────────────────────────

  it('respects DATA_DIR env var', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({ DATA_DIR: '/custom/data' }, () => getConfig())
    expect(config.storage.dataDir).toBe('/custom/data')
  })

  it('populates auth fields from env', () => {
    existsSyncMock.mockReturnValue(false)
    const config = withEnv({
      JWT_SECRET: 'jwt-secret', DEFAULT_PASSWORD: 'mypass', SERVICE_API_KEY: 'svc-key',
    }, () => getConfig())
    expect(config.auth.jwtSecret).toBe('jwt-secret')
    expect(config.auth.defaultPassword).toBe('mypass')
    expect(config.auth.serviceApiKey).toBe('svc-key')
  })

  // ── missing .env file ─────────────────────────────────

  it('does not error when .env file missing', () => {
    existsSyncMock.mockReturnValue(false)
    expect(() => getConfig()).not.toThrow()
  })
})
