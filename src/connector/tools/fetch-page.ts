import type { ToolDefinition } from '../registry.js'
import { isObscuraAvailable, renderPage } from './obscura-client.js'

/**
 * Fetch a web page and extract text content.
 * Used for scraping specific URLs like price quotation pages.
 *
 * When render=true and Obscura is available, uses headless browser
 * to render JavaScript before extracting content (for SPA/dynamic pages).
 */
export function createFetchPageTool(): ToolDefinition {
  return {
    name: 'fetch_page',
    description: '抓取指定网页的文字内容（适用于价格行情页、新闻页等）。设置 render=true 可渲染动态页面（如 X/Twitter、知乎等 JS 渲染页面）',
    parameters: {
      url: { type: 'string', description: '要抓取的网页 URL', required: true },
      render: { type: 'string', description: '是否使用浏览器渲染动态页面（true/false），默认 false', required: false },
    },
    async execute(args) {
      const url = String(args.url || '').trim()
      if (!url) return '请提供网页 URL'
      const useRender = args.render === 'true' || args.render === true

      const MAX_CHARS = 4000

      // Obscura rendered path
      if (useRender && isObscuraAvailable()) {
        try {
          const result = await renderPage(url, { stealth: true })
          const text = result.text
          if (!text) return '页面渲染后内容为空'
          if (text.length > MAX_CHARS) {
            return text.slice(0, MAX_CHARS) + `\n...(内容已截取前 ${MAX_CHARS} 字)`
          }
          return text
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return `渲染抓取出错: ${msg}`
        }
      }

      // Standard HTTP fetch path
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
