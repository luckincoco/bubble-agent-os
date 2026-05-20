/**
 * CodeForge — Bubble 自编码核心引擎（Legacy Single-Shot 模式）
 *
 * 职责：根据需求描述，调用 DeepSeek 生成符合 Bubble 工具规范的 TypeScript 代码。
 * 设计原则：
 *   - 节省成本：复用现有 LLM 连接，prompt 精简
 *   - 控制风险：生成代码经静态分析 + 编译验证，人工审批后才注册
 *
 * 注意：新代码应优先使用 SpecForge（spec-forge.ts）的 SDD 管线。
 * 此类保留用于向后兼容和极简请求的直接生成路径。
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js'
import { logger } from '../../shared/logger.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ForgeRequest {
  /** 需求描述（自然语言） */
  description: string
  /** 工具名称建议（可选，forge 会自动生成） */
  suggestedName?: string
  /** 分类 */
  category?: 'biz-query' | 'data-transform' | 'report' | 'utility'
}

export interface ForgeResult {
  /** 生成的工具名 */
  toolName: string
  /** 生成的 TypeScript 源码 */
  code: string
  /** 对应的测试代码 */
  testCode: string
  /** 代码解释（供人工审核） */
  explanation: string
  /** token 消耗 */
  tokenUsage?: { prompt: number; completion: number; total: number }
}

// ── System Prompt（精简，控制 token 开销） ────────────────────────────

const SYSTEM_PROMPT = `你是 Bubble Agent OS 的工具生成器。根据需求生成一个 TypeScript 工具文件。

## 工具规范
导出一个 ToolDefinition 对象：
\`\`\`typescript
import type { ToolDefinition } from '../../connector/registry.js'
import type { UserContext } from '../../shared/types.js'
import type { BizContext } from '../../connector/biz/structured-store.js'
// 按需 import structured-store 的 get* 方法

export function createXxxTool(): ToolDefinition {
  return {
    name: 'tool_name',
    description: '工具描述',
    parameters: {
      param1: { type: 'string', description: '参数说明', required: true },
    },
    async execute(args, ctx) {
      // ctx.activeSpaceId 获取当前空间
      const bizCtx: BizContext = { spaceId: ctx?.activeSpaceId || '' }
      // 调用 structured-store 的查询方法
      // 返回格式化的字符串结果
      return '结果'
    },
  }
}
\`\`\`

## 安全约束（不可违反）
1. 只能 import：registry.js 的类型、types.js 的类型、structured-store.js 的 get*/find* 方法
2. 禁止：fs、child_process、net、http、fetch、eval、Function 构造器
3. 禁止：任何写操作（create*、update*、delete*）
4. 敏感字段（costPrice、costAmount、profit、exposure、敞口）不得出现在输出中
5. execute 必须是 async 函数，返回 string

## 输出格式
用三个代码块，分别标注 tool、test、explanation：

\`\`\`tool
// 工具源码
\`\`\`

\`\`\`test
// vitest 测试代码（mock structured-store）
\`\`\`

\`\`\`explanation
// 一段话解释这个工具做什么、为什么这样设计
\`\`\`
`

// ── Forge Engine ─────────────────────────────────────────────────────

export class CodeForge {
  constructor(private llm: LLMProvider) {}

  async generate(req: ForgeRequest): Promise<ForgeResult> {
    const userMsg = this.buildUserPrompt(req)
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ]

    logger.info(`[CodeForge] Generating tool for: ${req.description.slice(0, 50)}...`)
    const response = await this.llm.chat(messages)

    const parsed = this.parseResponse(response.content)
    const tokenUsage = response.usage ? {
      prompt: response.usage.promptTokens,
      completion: response.usage.completionTokens,
      total: response.usage.totalTokens,
    } : undefined

    logger.info(`[CodeForge] Generated tool "${parsed.toolName}" (${tokenUsage?.total || '?'} tokens)`)

    return { ...parsed, tokenUsage }
  }

  private buildUserPrompt(req: ForgeRequest): string {
    let prompt = `需求：${req.description}`
    if (req.suggestedName) {
      prompt += `\n建议工具名：${req.suggestedName}`
    }
    if (req.category) {
      prompt += `\n分类：${req.category}`
    }
    return prompt
  }

  private parseResponse(content: string): Omit<ForgeResult, 'tokenUsage'> {
    const toolMatch = content.match(/```tool\n([\s\S]*?)```/)
    const testMatch = content.match(/```test\n([\s\S]*?)```/)
    const explMatch = content.match(/```explanation\n([\s\S]*?)```/)

    // Fallback: try generic typescript blocks
    const code = toolMatch?.[1]?.trim()
      || this.extractFirstCodeBlock(content, 'typescript')
      || this.extractFirstCodeBlock(content, 'ts')
      || ''

    const testCode = testMatch?.[1]?.trim() || ''
    const explanation = explMatch?.[1]?.trim() || '（未提供解释）'

    // Extract tool name from code
    const nameMatch = code.match(/name:\s*['"]([^'"]+)['"]/)
    const toolName = nameMatch?.[1] || 'unnamed_tool'

    return { toolName, code, testCode, explanation }
  }

  private extractFirstCodeBlock(content: string, lang: string): string | null {
    const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```')
    const match = content.match(re)
    return match?.[1]?.trim() || null
  }
}
