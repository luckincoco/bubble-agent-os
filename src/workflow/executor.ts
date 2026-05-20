/**
 * PlanExecutor — 执行 ActionPlanner 生成的计划。
 *
 * 职责：
 * - 按序/并行执行步骤
 * - 每步更新 TaskLedger
 * - 失败时按策略处理（重试/停止报告/绝对停止）
 * - 用户可中断
 */

import type { LLMProvider, UserContext } from '../shared/types.js'
import type { ToolRegistry } from '../connector/registry.js'
import { executeStep, classifyFailure, type ExecutionPlan, type StepResult, type FailureStrategy } from './planner.js'
import { updateLedgerStatus, updatePlanSteps, type PlanStep } from '../temporal/task-ledger.js'
import { logger } from '../shared/logger.js'

// ── Types ─────────────────────────────────────────────────────────

export interface ExecutorOptions {
  ledgerId: string
  plan: ExecutionPlan
  tools: ToolRegistry
  llm: LLMProvider
  ctx?: UserContext
  /** Called before each step — return false to abort */
  onBeforeStep?: (step: PlanStep, index: number) => Promise<boolean>
  /** Called after each step with the result */
  onStepComplete?: (step: PlanStep, result: StepResult, index: number) => Promise<void>
}

export interface ExecutorResult {
  completed: boolean
  stepsExecuted: number
  results: StepResult[]
  abortReason?: string
}

// ── Executor ──────────────────────────────────────────────────────

/**
 * Execute a plan sequentially, updating the ledger at each step.
 */
export async function executePlan(opts: ExecutorOptions): Promise<ExecutorResult> {
  const { ledgerId, plan, tools, llm, ctx, onBeforeStep, onStepComplete } = opts
  const results: StepResult[] = []
  let stepsExecuted = 0

  const pendingSteps = plan.steps.filter(s => s.status === 'pending' || s.status === 'in_progress')

  for (let i = 0; i < pendingSteps.length; i++) {
    const step = pendingSteps[i]

    // Check for user interrupt
    if (onBeforeStep) {
      const shouldContinue = await onBeforeStep(step, i)
      if (!shouldContinue) {
        logger.info(`PlanExecutor: user interrupted at step ${i + 1}`)
        return { completed: false, stepsExecuted, results, abortReason: '用户中断' }
      }
    }

    // Check dependencies
    if (step.dependsOn && step.dependsOn.length > 0) {
      const unmetDeps = step.dependsOn.filter(depId => {
        const depResult = results.find(r => r.stepId === depId)
        return !depResult || !depResult.success
      })
      if (unmetDeps.length > 0) {
        logger.info(`PlanExecutor: skipping step "${step.id}" — unmet dependencies: ${unmetDeps.join(', ')}`)
        step.status = 'skipped'
        updatePlanSteps(ledgerId, plan.steps)
        results.push({ stepId: step.id, success: false, output: '', error: `依赖未满足: ${unmetDeps.join(', ')}` })
        continue
      }
    }

    // Mark in progress
    step.status = 'in_progress'
    updatePlanSteps(ledgerId, plan.steps)

    // Execute
    let result = await executeStep(ledgerId, step, tools, llm, ctx)
    stepsExecuted++

    // Handle failure
    if (!result.success && result.error) {
      const strategy = classifyFailure(result.error, step)

      switch (strategy) {
        case 'retry':
          logger.info(`PlanExecutor: retrying step "${step.id}" (transient error)`)
          result = await executeStep(ledgerId, step, tools, llm, ctx)
          stepsExecuted++
          if (!result.success) {
            step.status = 'failed'
            updatePlanSteps(ledgerId, plan.steps)
            updateLedgerStatus(ledgerId, 'paused')
            results.push(result)
            return { completed: false, stepsExecuted, results, abortReason: `步骤失败(重试后): ${result.error}` }
          }
          break

        case 'halt_report':
          step.status = 'failed'
          updatePlanSteps(ledgerId, plan.steps)
          updateLedgerStatus(ledgerId, 'paused')
          results.push(result)
          return { completed: false, stepsExecuted, results, abortReason: `数据异常，需确认: ${result.error}` }

        case 'halt_absolute':
          step.status = 'failed'
          updatePlanSteps(ledgerId, plan.steps)
          updateLedgerStatus(ledgerId, 'paused')
          results.push(result)
          return { completed: false, stepsExecuted, results, abortReason: `不可逆操作失败，绝对停止: ${result.error}` }
      }
    }

    results.push(result)

    // Callback
    if (onStepComplete) {
      await onStepComplete(step, result, i)
    }
  }

  // All steps completed
  updateLedgerStatus(ledgerId, 'completed')
  return { completed: true, stepsExecuted, results }
}

/**
 * Generate a human-readable progress report for the executor result.
 */
export function formatExecutorReport(result: ExecutorResult, plan: ExecutionPlan): string {
  const totalSteps = plan.steps.length
  const successCount = result.results.filter(r => r.success).length

  const lines: string[] = [
    `任务: ${plan.goal}`,
    `状态: ${result.completed ? '已完成' : '已暂停'}`,
    `进度: ${successCount}/${totalSteps} 步骤成功`,
  ]

  if (result.abortReason) {
    lines.push(`中止原因: ${result.abortReason}`)
  }

  // Step details
  lines.push('')
  for (const step of plan.steps) {
    const icon = step.status === 'completed' ? '[done]'
      : step.status === 'failed' ? '[FAIL]'
        : step.status === 'skipped' ? '[skip]'
          : '[    ]'
    lines.push(`${icon} ${step.description}`)
  }

  return lines.join('\n')
}
