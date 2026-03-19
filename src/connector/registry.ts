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

  getToolDescriptions(): string {
    if (this.tools.size === 0) return ''
    const lines = this.list().map((t) => {
      const params = Object.entries(t.parameters)
        .map(([k, v]) => `${k}: ${v.type}${v.required ? ' (required)' : ''}`)
        .join(', ')
      return `- ${t.name}(${params}): ${t.description}`
    })
    return `\n你可以使用以下工具：\n${lines.join('\n')}\n\n要使用工具，请回复格式：\n[TOOL_CALL: tool_name] {"param": "value"}\n工具执行完后，我会把结果告诉你。`
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
