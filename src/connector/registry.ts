import type { UserContext } from '../shared/types.js'
import { logger } from '../shared/logger.js'
import { checkBoundary, declareReversible } from './boundary-checker.js'

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
  /** 自定义超时（毫秒），不设则使用 ToolLoop 默认值 */
  timeout?: number
  /** 声明此工具为可逆操作，默认不可逆（零信任） */
  reversible?: boolean
  execute: (args: Record<string, unknown>, ctx?: UserContext) => Promise<string>
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool)
    if (tool.reversible) {
      declareReversible(tool.name)
    }
    logger.info(`Tool registered: ${tool.name}${tool.reversible ? ' [reversible]' : ''}`)
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
    return `\n\n## 可用工具\n你可以使用以下工具：\n${lines.join('\n')}\n\n要使用工具，请回复格式：\n[TOOL_CALL: tool_name] {"param": "value"}\n工具执行完后，我会把结果告诉你，你可以继续使用其他工具或给出最终回答。\n\n**多步调用**：如果需要多个步骤（如先查数据再计算），每次回复只调用你当前需要的工具，等结果返回后再决定下一步。\n**同时调用**：如果需要同时获取多个独立数据，可以在一次回复中写多个 [TOOL_CALL: ...] 调用。\n\n**重要规则**：当用户询问实时信息（价格、新闻、天气、市场行情、公司信息等），你**必须**使用 web_search 工具获取最新数据，不要凭记忆回答。\n示例：用户问"今天螺纹钢价格" → 你应回复：[TOOL_CALL: web_search] {"query": "今天螺纹钢价格"}`
  }

  async execute(name: string, args: Record<string, unknown>, ctx?: UserContext): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) return `Error: unknown tool "${name}"`

    // ── Gate Layer: boundary check before execution ──────────────
    const gate = checkBoundary(name, args)
    if (gate.decision === 'deny') {
      logger.warn(`Gate Layer DENIED: ${name} — ${gate.reason} (rule: ${gate.triggeredRule})`)
      return `操作被拒绝: ${gate.reason}${gate.suggestion ? `\n建议: ${gate.suggestion}` : ''}`
    }
    if (gate.decision === 'confirm') {
      logger.info(`Gate Layer CONFIRM: ${name} — ${gate.reason}`)
      return `需要确认: ${gate.reason}\n请回复"确认"以继续执行此操作。`
    }

    try {
      return await tool.execute(args, ctx)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error executing ${name}: ${msg}`
    }
  }
}
