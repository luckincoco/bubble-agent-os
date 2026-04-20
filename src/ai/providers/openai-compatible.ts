import type { LLMMessage, LLMResponse, LLMProvider } from '../../shared/types.js'
import { TOKEN_LIMITS } from '../../shared/tokens.js'
import { logger } from '../../shared/logger.js'

interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl: string
  model: string
}

/**
 * OpenAI-compatible LLM provider.
 * Works with DeepSeek, OpenAI, and any OpenAI-compatible API.
 */
export function createOpenAIProvider(config: OpenAICompatibleConfig): LLMProvider {
  const { apiKey, baseUrl, model } = config

  async function chat(messages: LLMMessage[]): Promise<LLMResponse> {
    const url = `${baseUrl}/v1/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TOKEN_LIMITS.LLM_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LLM API error ${res.status}: ${text}`)
      }

      const data = await res.json() as {
        choices: { message: { content: string } }[]
        usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }

      return {
        content: data.choices[0]?.message?.content || '',
        usage: data.usage ? {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        } : undefined,
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  async function chatStream(
    messages: LLMMessage[],
    onChunk: (text: string) => void,
  ): Promise<LLMResponse> {
    const url = `${baseUrl}/v1/chat/completions`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TOKEN_LIMITS.LLM_TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        throw new Error(`LLM API error ${res.status}: ${text}`)
      }

      const reader = res.body?.getReader()
      if (!reader) throw new Error('No response body')

      const decoder = new TextDecoder()
      let fullContent = ''
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data: ')) continue
          const payload = trimmed.slice(6)
          if (payload === '[DONE]') continue

          try {
            const chunk = JSON.parse(payload) as {
              choices: { delta: { content?: string } }[]
            }
            const text = chunk.choices[0]?.delta?.content
            if (text) {
              fullContent += text
              onChunk(text)
            }
          } catch {
            logger.debug('Failed to parse SSE chunk:', payload)
          }
        }
      }

      return { content: fullContent }
    } finally {
      clearTimeout(timeout)
    }
  }

  return { chat, chatStream }
}
