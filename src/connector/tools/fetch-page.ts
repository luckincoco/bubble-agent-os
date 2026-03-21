import type { ToolDefinition } from '../registry.js'

/**
 * Fetch a web page and extract text content.
 * Used for scraping specific URLs like price quotation pages.
 */
export function createFetchPageTool(): ToolDefinition {
  return {
    name: 'fetch_page',
    description: '抓取指定网页的文字内容（适用于价格行情页、新闻页等）',
    parameters: {
      url: { type: 'string', description: '要抓取的网页 URL', required: true },
    },
    async execute(args) {
      const url = String(args.url || '').trim()
      if (!url) return '请提供网页 URL'

      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; BubbleAgent/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
          },
          signal: AbortSignal.timeout(15000),
        })

        if (!res.ok) {
          return `抓取失败 (${res.status}): ${res.statusText}`
        }

        const html = await res.text()

        // Extract text from HTML: strip tags, collapse whitespace
        const text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, '\n')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#\d+;/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n/g, '\n')
          .trim()

        if (!text) return '页面内容为空'

        // Truncate to avoid token overflow
        const MAX_CHARS = 4000
        if (text.length > MAX_CHARS) {
          return text.slice(0, MAX_CHARS) + `\n...(内容已截取前 ${MAX_CHARS} 字)`
        }
        return text
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `抓取出错: ${msg}`
      }
    },
  }
}
