/**
 * SpecForge — Spec-Driven Development 管线引擎
 *
 * 实现 GitHub spec-kit 的 SDD 流程：
 *   Constitution → Specify → Plan → Tasks → Implement
 *
 * 特性：
 *   - 复杂度启发式：简单请求跳过 Specify + Tasks（2 LLM calls vs 4）
 *   - 澄清中断：Specify 阶段检测到歧义时暂停，等待用户输入
 *   - 会话持久化：pipeline 状态可恢复（支持异步澄清流程）
 *   - 向后兼容：ForgeResult 输出格式不变，附加 specSession 元数据
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js'
import { loadConstitution, type BubbleConstitution } from './constitution.js'
import { getPhasePrompt, getPipelinePhases, isSkippablePhase, type ForgePhase } from './prompts.js'
import type { ForgeRequest, ForgeResult } from './forge.js'
import { logger } from '../../shared/logger.js'
import { randomUUID } from 'node:crypto'

// ── Types ────────────────────────────────────────────────────────────

export interface SpecSession {
  id: string
  request: ForgeRequest
  currentPhase: ForgePhase
  status: 'running' | 'paused' | 'completed' | 'failed'
  /** Artifacts produced by each phase */
  artifacts: Partial<Record<ForgePhase, string>>
  /** Clarification questions from specify phase */
  clarifications: string[]
  /** Whether the complexity heuristic determined this is simple */
  isSimple: boolean
  startedAt: number
  completedAt?: number
  tokenUsage: { prompt: number; completion: number; total: number }
  error?: string
}

export interface SpecForgeResult {
  /** Standard ForgeResult for backward compatibility */
  forge: ForgeResult
  /** The full spec session with all phase artifacts */
  session: SpecSession
}

export interface SpecForgePausedResult {
  status: 'paused'
  sessionId: string
  clarifications: string[]
  session: SpecSession
}

export type SpecForgeOutput = SpecForgeResult | SpecForgePausedResult

/** Type guard: check if output is paused (needs clarification) */
export function isSpecForgePaused(output: SpecForgeOutput): output is SpecForgePausedResult {
  return 'status' in output && (output as SpecForgePausedResult).status === 'paused'
}

// ── Complexity Heuristic ─────────────────────────────────────────────

const SIMPLE_THRESHOLD = 30

function isSimpleRequest(description: string): boolean {
  // Short requests or those with very specific single-query patterns
  if (description.length < SIMPLE_THRESHOLD) return true
  // Single-method patterns: "查询今日采购" "获取客户列表"
  if (/^(查询|获取|统计|列出).{2,10}$/.test(description)) return true
  return false
}

// ── SpecForge Engine ─────────────────────────────────────────────────

export class SpecForge {
  private constitution: BubbleConstitution
  private sessions = new Map<string, SpecSession>()

  constructor(
    private llm: LLMProvider,
    private projectRoot: string,
  ) {
    this.constitution = loadConstitution(projectRoot)
  }

  /**
   * Run the full SDD pipeline for a forge request.
   * Returns either a completed result or a paused state requiring clarification.
   */
  async run(request: ForgeRequest): Promise<SpecForgeOutput> {
    const session: SpecSession = {
      id: randomUUID(),
      request,
      currentPhase: 'specify',
      status: 'running',
      artifacts: {},
      clarifications: [],
      isSimple: isSimpleRequest(request.description),
      startedAt: Date.now(),
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
    }

    this.sessions.set(session.id, session)
    logger.info(`[SpecForge] Starting session ${session.id.slice(0, 8)} (simple=${session.isSimple})`)

    return this.executePipeline(session)
  }

  /**
   * Resume a paused session with user clarification.
   */
  async resume(sessionId: string, clarification: string): Promise<SpecForgeOutput> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    if (session.status !== 'paused') {
      throw new Error(`Session ${sessionId} is not paused (status: ${session.status})`)
    }

    logger.info(`[SpecForge] Resuming session ${sessionId.slice(0, 8)} with clarification`)

    // Append clarification to the request description for re-running specify
    session.request = {
      ...session.request,
      description: `${session.request.description}\n\n用户补充说明：${clarification}`,
    }
    session.status = 'running'
    session.clarifications = []
    session.artifacts = {} // Clear previous artifacts, re-run from start

    return this.executePipeline(session)
  }

  /**
   * Get a session by ID (for API inspection).
   */
  getSession(sessionId: string): SpecSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * List all sessions (recent first).
   */
  listSessions(limit = 20): SpecSession[] {
    return [...this.sessions.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
  }

  // ── Private Pipeline Execution ─────────────────────────────────────

  private async executePipeline(session: SpecSession): Promise<SpecForgeOutput> {
    const phases = this.getActivePhases(session.isSimple)

    for (const phase of phases) {
      // Skip if already have artifact for this phase (resume scenario)
      if (session.artifacts[phase]) continue

      session.currentPhase = phase
      logger.info(`[SpecForge] Phase: ${phase} (session ${session.id.slice(0, 8)})`)

      try {
        const result = await this.executePhase(session, phase)

        // Check for clarification pause (only in specify phase)
        if (phase === 'specify' && result.startsWith('[NEEDS CLARIFICATION]')) {
          session.status = 'paused'
          session.clarifications = this.extractClarifications(result)
          session.artifacts[phase] = result
          this.sessions.set(session.id, session)

          logger.info(`[SpecForge] Paused for clarification (${session.clarifications.length} questions)`)

          return {
            status: 'paused',
            sessionId: session.id,
            clarifications: session.clarifications,
            session,
          }
        }

        session.artifacts[phase] = result
      } catch (err) {
        session.status = 'failed'
        session.error = err instanceof Error ? err.message : String(err)
        this.sessions.set(session.id, session)
        throw err
      }
    }

    // Pipeline complete — parse the implement phase output
    session.status = 'completed'
    session.completedAt = Date.now()
    this.sessions.set(session.id, session)

    const forgeResult = this.parseImplementOutput(session)

    logger.info(`[SpecForge] Completed: tool="${forgeResult.toolName}" (${session.tokenUsage.total} tokens total)`)

    return { forge: forgeResult, session }
  }

  private getActivePhases(isSimple: boolean): ForgePhase[] {
    if (isSimple) {
      // Simple path: skip specify + tasks, only Plan → Implement
      return getPipelinePhases().filter(p => !isSkippablePhase(p))
    }
    return getPipelinePhases()
  }

  private async executePhase(session: SpecSession, phase: ForgePhase): Promise<string> {
    const prompt = getPhasePrompt(phase, this.constitution)
    const userMessage = this.buildPhaseUserMessage(session, phase)

    const messages: LLMMessage[] = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: userMessage },
    ]

    const response = await this.llm.chat(messages)

    // Accumulate token usage
    if (response.usage) {
      session.tokenUsage.prompt += response.usage.promptTokens
      session.tokenUsage.completion += response.usage.completionTokens
      session.tokenUsage.total += response.usage.totalTokens
    }

    return response.content
  }

  private buildPhaseUserMessage(session: SpecSession, phase: ForgePhase): string {
    const { description, suggestedName, category } = session.request

    switch (phase) {
      case 'specify': {
        let msg = `需求：${description}`
        if (suggestedName) msg += `\n建议工具名：${suggestedName}`
        if (category) msg += `\n分类：${category}`
        return msg
      }

      case 'plan': {
        const spec = session.artifacts.specify
        let msg = `需求：${description}`
        if (suggestedName) msg += `\n建议工具名：${suggestedName}`
        if (spec) msg += `\n\n## 需求规格\n${spec}`
        return msg
      }

      case 'tasks': {
        const plan = session.artifacts.plan
        return `## 技术方案\n${plan || '(无)'}\n\n请拆解为实施任务。`
      }

      case 'implement': {
        const plan = session.artifacts.plan || ''
        const tasks = session.artifacts.tasks || ''
        let msg = `需求：${description}`
        if (suggestedName) msg += `\n建议工具名：${suggestedName}`
        msg += `\n\n## 技术方案\n${plan}`
        if (tasks) msg += `\n\n## 任务列表\n${tasks}`
        return msg
      }
    }
  }

  private extractClarifications(content: string): string[] {
    // Extract from spec YAML block → clarifications field
    const specMatch = content.match(/```spec\n([\s\S]*?)```/)
    if (specMatch) {
      const yaml = specMatch[1]
      const clarMatch = yaml.match(/clarifications:\s*\n([\s\S]*?)(?:\n\w|\n$|$)/)
      if (clarMatch) {
        return clarMatch[1]
          .split('\n')
          .map(l => l.replace(/^\s*-\s*/, '').trim())
          .filter(l => l.length > 0)
      }
    }

    // Fallback: extract lines after [NEEDS CLARIFICATION]
    const lines = content.split('\n')
    const startIdx = lines.findIndex(l => l.includes('[NEEDS CLARIFICATION]'))
    if (startIdx >= 0) {
      return lines
        .slice(startIdx + 1)
        .map(l => l.replace(/^\s*[-•]\s*/, '').trim())
        .filter(l => l.length > 0 && !l.startsWith('```'))
    }

    return ['需求描述不够明确，请补充更多细节。']
  }

  private parseImplementOutput(session: SpecSession): ForgeResult {
    const content = session.artifacts.implement || ''

    const toolMatch = content.match(/```tool\n([\s\S]*?)```/)
    const testMatch = content.match(/```test\n([\s\S]*?)```/)
    const explMatch = content.match(/```explanation\n([\s\S]*?)```/)

    // Fallback: try generic typescript blocks
    const code = toolMatch?.[1]?.trim()
      || this.extractCodeBlock(content, 'typescript')
      || this.extractCodeBlock(content, 'ts')
      || ''

    const testCode = testMatch?.[1]?.trim() || ''
    const explanation = explMatch?.[1]?.trim() || '（由 SpecForge SDD 管线生成）'

    // Extract tool name from code
    const nameMatch = code.match(/name:\s*['"]([^'"]+)['"]/)
    const toolName = nameMatch?.[1] || session.request.suggestedName || 'unnamed_tool'

    return {
      toolName,
      code,
      testCode,
      explanation,
      tokenUsage: { ...session.tokenUsage },
    }
  }

  private extractCodeBlock(content: string, lang: string): string | null {
    const re = new RegExp('```' + lang + '\\n([\\s\\S]*?)```')
    const match = content.match(re)
    return match?.[1]?.trim() || null
  }
}
