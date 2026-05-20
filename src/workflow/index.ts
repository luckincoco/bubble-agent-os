/**
 * Workflow module — ActionPlanner + PlanExecutor for multi-step task orchestration.
 */

export { generatePlan, startPlan, executeStep, classifyFailure, shouldUsePlanMode } from './planner.js'
export type { ExecutionPlan, PlannerResult, StepResult, FailureStrategy, StepExecution } from './planner.js'

export { executePlan, formatExecutorReport } from './executor.js'
export type { ExecutorOptions, ExecutorResult } from './executor.js'
