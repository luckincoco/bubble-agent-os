import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import type { AppConfig } from './types.js'

function loadEnv(): Record<string, string> {
  const envPath = resolve(process.cwd(), '.env')
  if (!existsSync(envPath)) return {}
  const env: Record<string, string> = {}
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    const val = trimmed.slice(eqIdx + 1).trim()
    env[key] = val
  }
  return env
}

export function getConfig(): AppConfig {
  const env = { ...loadEnv(), ...process.env }
  const provider = (env.LLM_PROVIDER || 'deepseek') as AppConfig['llm']['provider']

  const defaults: Record<string, { baseUrl: string; model: string; keyEnv: string }> = {
    deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
    openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
    ollama: { baseUrl: 'http://localhost:11434', model: 'llama3', keyEnv: '' },
  }

  const d = defaults[provider] || defaults.deepseek

  return {
    llm: {
      provider,
      apiKey: env[d.keyEnv] || env.LLM_API_KEY || '',
      baseUrl: env.LLM_BASE_URL || d.baseUrl,
      model: env.LLM_MODEL || d.model,
    },
    storage: {
      dataDir: env.DATA_DIR || resolve(homedir(), '.bubble-agent', 'data'),
    },
    auth: {
      jwtSecret: env.JWT_SECRET || 'bubble-agent-default-secret-change-me',
      defaultPassword: env.DEFAULT_PASSWORD || 'bubble123',
    },
  }
}
