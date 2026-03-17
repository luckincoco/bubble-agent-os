import type { LLMProvider } from '../shared/types.js'
import type { AppConfig } from '../shared/types.js'
import { createOpenAIProvider } from './providers/openai-compatible.js'
import { logger } from '../shared/logger.js'

export function createLLM(config: AppConfig['llm']): LLMProvider {
  const { provider, apiKey, baseUrl, model } = config

  if (provider === 'deepseek' || provider === 'openai') {
    if (!apiKey) {
      throw new Error(
        `Missing API key for ${provider}. Set ${provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENAI_API_KEY'} in .env file.`
      )
    }
    logger.info(`LLM: ${provider} (${model}) @ ${baseUrl}`)
    return createOpenAIProvider({ apiKey, baseUrl: baseUrl!, model: model! })
  }

  if (provider === 'ollama') {
    logger.info(`LLM: ollama (${model}) @ ${baseUrl}`)
    return createOpenAIProvider({ apiKey: 'ollama', baseUrl: baseUrl!, model: model! })
  }

  throw new Error(`Unknown LLM provider: ${provider}`)
}
