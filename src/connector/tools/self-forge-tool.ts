/**
 * self-forge tool — Bubble 的自编码对话工具 (v2: Spec-Driven Development)
 *
 * 当管理员在对话中要求 Bubble "生成一个新工具"/"创建一个查询功能" 时，
 * Bubble 可以调用此工具触发 SpecForge SDD 管线生成代码。
 *
 * v2 变更：
 *   - 使用 SpecForge 替代原始 CodeForge（SDD 多阶段管线）
 *   - 支持澄清中断：当需求不明确时暂停并返回问题
 *   - 支持 resume：用户回答后继续管线
 *
 * 安全约束：
 * - 仅管理员可触发（通过 UserContext 判断）
 * - 生成的代码经过静态安全分析
 * - 不会自动部署，需要管理员通过 /api/forge/approve 审批
 */

import type { ToolDefinition } from '../registry.js'
import type { UserContext, LLMProvider } from '../../shared/types.js'
import { SpecForge, isSpecForgePaused, Sandbox, DynamicLoader, type SpecForgeOutput } from '../code-forge/index.js'
import { logger } from '../../shared/logger.js'
import { resolve } from 'node:path'

// Module-level SpecForge instance (singleton per process)
let specForgeInstance: SpecForge | null = null

function getSpecForge(llm: LLMProvider, projectRoot: string): SpecForge {
  if (!specForgeInstance) {
    specForgeInstance = new SpecForge(llm, projectRoot)
  }
  return specForgeInstance
}

export function createSelfForgeTool(llm: LLMProvider, projectRoot: string): ToolDefinition {
  return {
    name: 'self_forge',
    description: '自编码：根据需求描述生成一个新的业务查询工具（Spec-Driven Development）。生成后需管理员审批才生效。当用户说"帮我做一个查询XX的功能"、"能不能自动查XX"等需要新工具时使用。',
    parameters: {
      description: { type: 'string', description: '详细的功能需求描述（越具体越好）', required: true },
      tool_name: { type: 'string', description: '建议的工具名称（英文，snake_case）', required: false },
      resume_session: { type: 'string', description: '恢复暂停的会话 ID（用于回答澄清问题后继续）', required: false },
      clarification: { type: 'string', description: '对澄清问题的回答（与 resume_session 搭配使用）', required: false },
    },
    timeout: 180_000, // SDD pipeline may need up to 4 LLM calls
    async execute(args, ctx) {
      const description = String(args.description || '').trim()
      const suggestedName = args.tool_name ? String(args.tool_name).trim() : undefined
      const resumeSession = args.resume_session ? String(args.resume_session).trim() : undefined
      const clarification = args.clarification ? String(args.clarification).trim() : undefined

      if (!description && !resumeSession) return '需要提供功能需求描述'

      const specForge = getSpecForge(llm, projectRoot)

      logger.info(`[SelfForge] Triggered: ${resumeSession ? 'resume ' + resumeSession.slice(0, 8) : description.slice(0, 80)}`)

      try {
        let output: SpecForgeOutput

        if (resumeSession && clarification) {
          // Resume a paused session with clarification
          output = await specForge.resume(resumeSession, clarification)
        } else {
          // Start new pipeline
          output = await specForge.run({
            description,
            suggestedName,
            category: 'biz-query',
          })
        }

        // Handle paused state (needs clarification)
        if (isSpecForgePaused(output)) {
          let response = `## 需要确认\n\n`
          response += `需求分析发现以下不明确之处，请补充说明：\n\n`
          for (let i = 0; i < output.clarifications.length; i++) {
            response += `${i + 1}. ${output.clarifications[i]}\n`
          }
          response += `\n---\n`
          response += `_会话 ID: \`${output.sessionId}\`_\n`
          response += `_回答后，再次调用此工具时传入 resume_session 和 clarification 参数即可继续。_`
          return response
        }

        // Pipeline completed — run static analysis
        const result = output.forge
        const sandbox = new Sandbox(projectRoot)
        const verification = await sandbox.verify(result.code)

        const staticOk = verification.staticAnalysis.passed
        let response = `## 自编码结果 (SDD Pipeline)\n\n`
        response += `**工具名**: \`${result.toolName}\`\n`
        response += `**说明**: ${result.explanation}\n`
        response += `**管线**: ${output.session.isSimple ? 'Plan→Implement（简化）' : 'Specify→Plan→Tasks→Implement（完整）'}\n\n`

        if (staticOk) {
          // Static security check passed — save as pending
          const loader = new DynamicLoader(projectRoot)
          const phases = Object.keys(output.session.artifacts)
          loader.savePendingTool(result.toolName, result.code, result.explanation, {
            sessionId: output.session.id,
            phases,
          })

          if (verification.compilation.passed) {
            response += `**安全检查**: 通过 (风险等级: ${verification.riskLevel})\n\n`
          } else {
            response += `**安全检查**: 通过 (编译有警告，不影响安全性)\n`
            response += `- 编译警告:\n`
            for (const e of verification.compilation.errors) {
              response += `  - ${e}\n`
            }
            response += `\n`
          }
          response += `代码已保存，等待管理员在 Web 后台审批后生效。\n\n`
          response += `<details><summary>生成的代码</summary>\n\n\`\`\`typescript\n${result.code}\n\`\`\`\n</details>`

          // Show spec artifacts if full pipeline
          if (!output.session.isSimple && output.session.artifacts.specify) {
            response += `\n\n<details><summary>需求规格</summary>\n\n${output.session.artifacts.specify}\n</details>`
          }
        } else {
          response += `**安全检查**: 未通过\n`
          response += `- 风险等级: ${verification.riskLevel}\n`
          if (verification.staticAnalysis.violations.length > 0) {
            response += `- 违规项:\n`
            for (const v of verification.staticAnalysis.violations) {
              response += `  - ${v}\n`
            }
          }
          response += `\n需要调整需求描述后重试。`
        }

        if (result.tokenUsage) {
          response += `\n\n_Token 消耗: ${result.tokenUsage.total}_`
        }

        return response
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error(`[SelfForge] Generation failed:`, msg)
        return `代码生成失败: ${msg}`
      }
    },
  }
}

/** Export the singleton getter for API routes */
export { getSpecForge }
