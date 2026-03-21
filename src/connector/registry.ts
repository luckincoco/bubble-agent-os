import type { UserContext } from '../shared/types.js'
import { logger } from '../shared/logger.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
  execute: (args: Record<string, unknown>, ctx?: UserContext) => Promise<string>
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool)
    logger.info(`Tool registered: ${tool.name}`)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  getToolDescriptions(filter?: string[]): string {
    if (this.tools.size === 0) return ''
    const toolList = filter?.length
      ? this.list().filter(t => filter.includes(t.name))
      : this.list()
    if (toolList.length === 0) return ''
    const lines = toolList.map((t) => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `${k}: ${v.type}${v.required ? ' (required)' : ''}`)
        .join(', ')
      return `- ${t.name}(${params}): ${t.description}`
    })
    return `\n\n## 可用工具\n你可以使用以下工具：\n${lines.join('\n')}\n\n要使用工具，请回复格式：\n[TOOL_CALL: tool_name] {"param": "value"}\n工具执行完后，我会把结果告诉你。\n\n**重要规则**：当用户询问实时信息（价格、新闻、天气、市场行情、公司信息等），你**必须**使用 web_search 工具获取最新数据，不要凭记忆回答。\n示例：用户问"今天螺纹钢价格" → 你应回复：[TOOL_CALL: web_search] {"query": "今天螺纹钢价格"}`
  }

  async execute(name: string, args: Record<string, unknown>, ctx?: UserContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Error: unknown tool "${name}"`
    try {
      return await tool.execute(args, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error executing ${name}: ${msg}`
    }
  }
}
