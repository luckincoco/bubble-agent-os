/**
 * SimpleFetcher — shared fetch + extract utility for all connectors.
 *
 * Wraps the common pattern: fetch a URL, extract text content,
 * optionally use LLM to transform into structured data.
 *
 * Usage:
 *   const fetcher = new SimpleFetcher()
 *   const text = await fetcher.fetchText(url)
 *   const json = await fetcher.fetchAndExtract(url, "提取钢价品种和价格", llm)
 */

import { logger } from '../../shared/logger.js'
import type { LLMProvider } from '../../shared/types.js'

export interface FetchOptions {
  timeout?: number
  userAgent?: string
  maxLength?: number
}

export interface FetchResult {
  text: string
  url: string
  fetchedAt: number
  truncated: boolean
}

const DEFAULT_UA = 'BubbleAgent/1.0 (information connector)'
const DEFAULT_TIMEOUT = 15000

export class SimpleFetcher {
  private options: Required<FetchOptions>

  constructor(options: FetchOptions = {}) {
    this.options = {
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      userAgent: options.userAgent ?? DEFAULT_UA,
      maxLength: options.maxLength ?? 50000,
    }
  }

  /** Fetch a URL and extract plain text content. */
  async fetchText(url: string): Promise<FetchResult> {
    const res = await fetch(url, {
      headers: { 'User-Agent': this.options.userAgent },
      signal: AbortSignal.timeout(this.options.timeout),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }

    const contentType = res.headers.get('content-type') || ''
    let raw = await res.text()

    // Strip HTML if needed
    if (contentType.includes('text/html')) {
      raw = raw
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '\n')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    const truncated = raw.length > this.options.maxLength
    if (truncated) {
      raw = raw.slice(0, this.options.maxLength)
    }

    return {
      text: raw,
      url,
      fetchedAt: Date.now(),
      truncated,
    }
  }

  /** Fetch a URL and use LLM to extract structured info as JSON. */
  async fetchAndExtract<T = Record<string, unknown>>(
    url: string,
    extractionPrompt: string,
    llm: LLMProvider,
  ): Promise<{ data: T | null; text: string }> {
    const result = await this.fetchText(url)

    try {
      const llmResponse = await llm.chat([
        {
          role: 'system',
          content: `你是一个信息提取助手。从以下网页文本中提取信息。${extractionPrompt}
返回 JSON 格式（不要 markdown 代码块，纯 JSON 字符串）。如果找不到信息，返回 null。`,
        },
        { role: 'user', content: result.text },
      ])

      const raw = llmResponse.content.trim()
      const json = JSON.parse(raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
      return { data: json as T, text: result.text }
    } catch (err) {
      logger.warn(`SimpleFetcher: LLM extraction failed for ${url}:`, err instanceof Error ? err.message : String(err))
      return { data: null, text: result.text }
    }
  }
}
