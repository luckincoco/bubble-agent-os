/**
 * ActionPlanner — 多步骤任务编排引擎。
 *
 * 设计原则：
 * - 动态生成为主，机械流程模板为辅
 * - 触发条件：步骤>=3 或含不可逆操作 或用户要求分步
 * - 仅支持串行和并行（不做 DAG），涌现式设计不预建复杂度
 * - 用户可中断，用户指令优先级永远高于 plan 下一步
 * - 每步同步更新 TaskLedger
 *
 * ADR: docs/adr-architecture-hardening-2026-05-18.md
 */

import type { LLMProvider, LLMMessage, UserContext } from '../shared/types.js'
import type { ToolRegistry } from '../connector/registry.js'
import {
  createLedger, addCheckpoint, setPendingAction, updateLedgerStatus, updatePlanSteps,
  type TaskLedger, type PlanStep, type Checkpoint, type PendingAction,
} from '../temporal/task-ledger.js'
import { logger } from '../shared/logger.js'
import { ulid } from 'ulid'

// ── Types ─────────────────────────────────────────────────────────

export type StepExecution = 'sequential' | 'parallel'

export interface ExecutionPlan {
  goal: string
  steps: PlanStep[]
  execution: StepExecution
}

export interface PlannerResult {
  plan: ExecutionPlan
  ledgerId: string
}

export interface StepResult {
  stepId: string
  success: boolean
  output: string
  error?: string
}

export type FailureStrategy = 'retry' | 'halt_report' | 'halt_absolute'

// ── Plan Generation ───────────────────────────────────────────────

const PLAN_GENERATION_PROMPT = `你是一个任务规划器。根据用户的目标，生成一个执行计划。

要求：
1. 将目标拆解为具体、可执行的步骤
2. 每步描述要明确，可以直接映射到工具调用
3. 如果步骤间有依赖，用 dependsOn 标注
4. 含不可逆操作的步骤标记 fallback

返回 JSON 格式：
{
  "steps": [
    { "id": "step_1", "description": "...", "dependsOn": [], "fallback": null },
    { "id": "step_2", "description": "...", "dependsOn": ["step_1"], "fallback": "..." }
  ],
  "execution": "sequential" | "parallel"
}

只返回 JSON，不要其他内容。`

/**
 * Generate an execution plan from a goal using LLM.
 */
export async function generatePlan(
  goal: string,
  llm: LLMProvider,
  context?: string,
): Promise<ExecutionPlan> {
  const messages: LLMMessage[] = [
    { role: 'system', content: PLAN_GENERATION_PROMPT },
    { role: 'user', content: context ? `${goal}\n\n背景信息: ${context}` : goal },
  ]

  const response = await llm.chat(messages)

  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = response.content.trim()
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    }
    const parsed = JSON.parse(jsonStr) as { steps: Array<{ id: string; description: string; dependsOn?: string[]; fallback?: string }>; execution: StepExecution }

    const steps: PlanStep[] = parsed.steps.map(s => ({
      id: s.id || ulid(),
      description: s.description,
      status: 'pending' as const,
      dependsOn: s.dependsOn,
      fallback: s.fallback,
    }))

    return {
      goal,
      steps,
      execution: parsed.execution || 'sequential',
    }
  } catch (err) {
    logger.error('ActionPlanner: failed to parse plan:', err instanceof Error ? err.message : String(err))
    // Fallback: single-step plan
    return {
      goal,
      steps: [{ id: ulid(), description: goal, status: 'pending' }],
      execution: 'sequential',
    }
  }
}

// ── Plan Execution ────────────────────────────────────────────────

/**
 * Create a TaskLedger and start executing the plan.
 */
export async function startPlan(
  plan: ExecutionPlan,
  ctx: UserContext,
): Promise<PlannerResult> {
  const ledger = createLedger({
    spaceId: ctx.activeSpaceId,
    actorId: ctx.userId,
    goal: plan.goal,
    planSteps: plan.steps,
  })

  return { plan, ledgerId: ledger.id }
}

/**
 * Execute a single step in the plan.
 * Returns the step result. Caller decides whether to continue.
 */
export async function executeStep(
  ledgerId: string,
  step: PlanStep,
  tools: ToolRegistry,
  llm: LLMProvider,
  ctx?: UserContext,
): Promise<StepResult> {
  // Mark step as in_progress
  setPendingAction(ledgerId, {
    stepId: step.id,
    description: step.description,
    requiresConfirmation: false,
    createdAt: Date.now(),
  })

  try {
    // Use LLM to determine which tool to call for this step
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: `你需要执行以下步骤。根据可用工具，生成正确的工具调用。\n\n可用工具:\n${tools.getToolDescriptions()}\n\n只回复一个工具调用，格式: [TOOL_CALL: tool_name] {"param": "value"}`,
      },
      { role: 'user', content: step.description },
    ]

    const response = await llm.chat(messages)
    const toolCallMatch = response.content.match(/\[TOOL_CALL:\s*(\w+)\]\s*(\{[^}]*\})?/)

    let output: string
    if (toolCallMatch) {
      const toolName = toolCallMatch[1]
      const args = toolCallMatch[2] ? JSON.parse(toolCallMatch[2]) : {}
      output = await tools.execute(toolName, args, ctx)
    } else {
      // LLM didn't produce a tool call — treat its response as the output
      output = response.content
    }

    // Record checkpoint
    addCheckpoint(ledgerId, {
      stepId: step.id,
      completedAt: Date.now(),
      summary: output.slice(0, 200),
    })

    // Clear pending action
    setPendingAction(ledgerId, null)

    return { stepId: step.id, success: true, output }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error(`ActionPlanner: step "${step.id}" failed: ${errorMsg}`)

    // Clear pending action on failure
    setPendingAction(ledgerId, null)

    return { stepId: step.id, success: false, output: '', error: errorMsg }
  }
}

/**
 * Determine failure handling strategy based on the type of error.
 */
export function classifyFailure(error: string, step: PlanStep): FailureStrategy {
  // Irreversible operation failure — absolute halt
  if (/删除|delete|drop|remove/i.test(step.description)) {
    return 'halt_absolute'
  }
  // Data anomaly — halt and report
  if (/not found|404|无数据|不存在/i.test(error)) {
    return 'halt_report'
  }
  // Transient errors — retry
  if (/timeout|ECONNRESET|ETIMEDOUT|rate limit/i.test(error)) {
    return 'retry'
  }
  // Default: halt and report
  return 'halt_report'
}

// ── Complexity Detection ──────────────────────────────────────────

/**
 * Detect if a user message warrants plan mode.
 * Conditions: steps >= 3, contains irreversible operations, or user explicitly asks for breakdown.
 */
export function shouldUsePlanMode(text: string): boolean {
  // User explicitly requests planning
  if (/分步|逐步|制定计划|计划一下|拆解|步骤/.test(text)) return true

  // Count action verbs as proxy for complexity
  const actionVerbs = text.match(/[查找搜创建修改删除更新添加导入导出生成计算统计分析对比]/g)
  if (actionVerbs && actionVerbs.length >= 3) return true

  // Contains explicit multi-step markers
  if (/第[一二三四五六七八九十]+[步件]|然后.*再.*最后/.test(text)) return true

  return false
}
