/**
 * Model Router — routes LLM requests to different providers based on task category.
 *
 * Categories:
 *   chat   — user-facing conversation (Brain.think)
 *   biz    — business data processing (BizEntryHandler, TeachHandler)
 *   memory — compaction, reflection, causal evaluation
 *   search — interest-search, feed-watcher query generation
 *
 * Configuration via environment variables:
 *   LLM_<CATEGORY>_PROVIDER / LLM_<CATEGORY>_API_KEY / LLM_<CATEGORY>_MODEL / LLM_<CATEGORY>_BASE_URL
 *   DEEPSEEK_OPT_OUT=biz,chat  (comma-separated categories that must not use DeepSeek)
 *
 * If no override is configured for a category, falls back to the default provider.
 */

import type { LLMProvider } from '../shared/types.js'
import type { AppConfig } from '../shared/types.js'
import { createLLM } from './llm.js'
import { logger } from '../shared/logger.js'

export type LLMCategory = 'chat' | 'biz' | 'memory' | 'search'

interface CategoryConfig {
  provider: AppConfig['llm']['provider']
  apiKey: string
  baseUrl: string
  model: string
}

export class ModelRouter {
  private providers = new Map<LLMCategory, LLMProvider>()
  private defaultProvider: LLMProvider

  constructor(defaultConfig: AppConfig['llm']) {
    const env = process.env
    const optOut = new Set((env.DEEPSEEK_OPT_OUT || '').split(',').map(s => s.trim()).filter(Boolean))

    this.defaultProvider = createLLM(defaultConfig)

    const categories: LLMCategory[] = ['chat', 'biz', 'memory', 'search']
    for (const cat of categories) {
      const catConfig = this.readCategoryConfig(cat, env)
      if (!catConfig) {
        // No override — use default, but check opt-out
        if (optOut.has(cat) && defaultConfig.provider === 'deepseek') {
          logger.warn(`ModelRouter: category '${cat}' opts out of DeepSeek but no override configured, using default anyway`)
        }
        this.providers.set(cat, this.defaultProvider)
        continue
      }

      // Enforce DeepSeek opt-out
      if (optOut.has(cat) && catConfig.provider === 'deepseek') {
        logger.warn(`ModelRouter: category '${cat}' opts out of DeepSeek, ignoring override and using default`)
        this.providers.set(cat, this.defaultProvider)
        continue
      }

      try {
        const provider = createLLM(catConfig)
        this.providers.set(cat, provider)
        logger.info(`ModelRouter: ${cat} → ${catConfig.provider} (${catConfig.model})`)
      } catch (err) {
        logger.warn(`ModelRouter: failed to create provider for '${cat}', falling back to default: ${err instanceof Error ? err.message : String(err)}`)
        this.providers.set(cat, this.defaultProvider)
      }
    }
  }

  /** Get provider for a specific task category */
  forCategory(category: LLMCategory): LLMProvider {
    return this.providers.get(category) || this.defaultProvider
  }

  /** Get the default provider (backward compat) */
  get default(): LLMProvider {
    return this.defaultProvider
  }

  private readCategoryConfig(
    category: LLMCategory,
    env: NodeJS.ProcessEnv,
  ): CategoryConfig | null {
    const prefix = `LLM_${category.toUpperCase()}_`
    const provider = env[`${prefix}PROVIDER`] as AppConfig['llm']['provider'] | undefined
    if (!provider) return null

    const DEFAULTS: Record<string, { baseUrl: string; model: string; keyEnv: string }> = {
      deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
      openai: { baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
      ollama: { baseUrl: 'http://localhost:11434', model: 'llama3', keyEnv: '' },
    }

    const d = DEFAULTS[provider] || DEFAULTS.deepseek
    return {
      provider,
      apiKey: env[`${prefix}API_KEY`] || env[d.keyEnv] || env.LLM_API_KEY || '',
      baseUrl: env[`${prefix}BASE_URL`] || d.baseUrl,
      model: env[`${prefix}MODEL`] || d.model,
    }
  }
}
