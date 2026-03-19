import type { ToolDefinition } from '../registry.js'

export function createWebSearchTool(): ToolDefinition {
  return {
    name: 'web_search',
    description: '在互联网上搜索实时信息（钢材价格、行业新闻、公司信息等），返回相关网页摘要',
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
      limit: { type: 'string', description: '返回结果数量，默认5', required: false },
    },
    async execute(args) {
      const query = String(args.query || '').trim()
      if (!query) return '请提供搜索关键词'

      const apiKey = process.env.TAVILY_API_KEY
      if (!apiKey) return '未配置搜索 API Key（TAVILY_API_KEY），请联系管理员设置'

      const maxResults = Math.min(parseInt(String(args.limit || '5')) || 5, 10)

      try {
        const res = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: maxResults,
            search_depth: 'basic',
          }),
          signal: AbortSignal.timeout(15000),
        })

        if (!res.ok) {
          const text = await res.text()
          return `搜索失败 (${res.status}): ${text.slice(0, 200)}`
        }

        const data = await res.json() as {
          results?: Array<{ title: string; url: string; content: string }>
          answer?: string
        }

        const results = data.results ?? []
        if (results.length === 0) return `未找到与"${query}"相关的结果`

        const lines = results.map((r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content?.slice(0, 200) ?? ''}`,
        )

        let output = `搜索"${query}"找到 ${results.length} 条结果：\n\n${lines.join('\n\n')}`
        if (data.answer) {
          output = `摘要：${data.answer}\n\n${output}`
        }
        return output
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return `搜索出错: ${msg}`
      }
    },
  }
}
