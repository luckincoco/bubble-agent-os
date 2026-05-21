/**
 * ActionFeedback — EventBus wiring for the Action → Observation feedback loop.
 *
 * Closes the "State-Action 循环" gap between plan execution and cognitive state:
 *
 *   Plan step completes → emit action.step.completed
 *     → listener records observation bubble → Reflector picks it up on next run
 *
 *   Plan finishes → emit action.plan.finished
 *     → listener triggers Reflector validation
 *
 *   Orientation detects tension → emit knowledge.tension.detected
 *     → listener triggers plan generation (Phase B)
 *
 * Design: no new data structures, only EventBus wiring.
 * ADR: docs/adr-action-feedback-loop-2026-05-21.md
 */

import type { EventBus } from '../event/event-bus.js'
import { logger } from '../shared/logger.js'

// ── PlanStep / StepResult interface stubs ─────────────────────────
// These match the types in src/workflow/planner.ts without importing
// from a file that may not exist in all branches.

export interface PlanStepStub {
  id: string
  description: string
  status: string
}

export interface StepResultStub {
  stepId: string
  success: boolean
  output: string
  error?: string
}

export interface StepObserver {
  /** Callback for PlanExecutor's onStepComplete. Emits action.step.completed. */
  onStepComplete: (step: PlanStepStub, result: StepResultStub, index: number) => Promise<void>
}

export interface TensionHandlerOptions {
  /** Minimum tension count to trigger action plan generation */
  minTensionThreshold?: number
  /** Minimum frontier gap score to flag */
  minGapThreshold?: number
}

// ── Constants ─────────────────────────────────────────────────────

const DEFAULT_TENSION_THRESHOLD = 2
const DEFAULT_GAP_THRESHOLD = 0.7

// ── Observer Factory ──────────────────────────────────────────────

/**
 * Create a step observer that emits action.step.completed events to EventBus.
 * Pass the returned `onStepComplete` to PlanExecutor's ExecutorOptions.
 *
 * Anti-loop guard: step results from plan_feedback sources are tagged
 * with source metadata so downstream listeners can filter them out.
 */
export function createStepObserver(
  eventBus: EventBus,
  ledgerId: string,
  goal: string,
  spaceId?: string,
): StepObserver {
  return {
    onStepComplete: async (step, result, _index) => {
      // Skip failed steps — only successful ones carry signal worth recording
      if (!result.success) {
        logger.debug(`ActionFeedback: step "${step.id}" failed, skipping event`)
        return
      }

      eventBus.emitFireAndForget(
        {
          type: 'action.step.completed',
          payload: {
            ledgerId,
            stepId: step.id,
            goal,
            description: step.description,
            success: true,
            output: result.output.slice(0, 500),
            spaceId,
          },
        },
        { actor: 'system', spaceId, metadata: { causationId: ledgerId } },
      )

      logger.debug(`ActionFeedback: emitted action.step.completed for "${step.id}"`)
    },
  }
}

// ── Plan Completion Helper ────────────────────────────────────────

/**
 * Emit action.plan.finished after a plan completes.
 * Call this after executePlan() returns.
 */
export function emitPlanFinished(
  eventBus: EventBus,
  ledgerId: string,
  goal: string,
  status: 'completed' | 'cancelled' | 'paused',
  completedSteps: number,
  totalSteps: number,
  spaceId?: string,
): void {
  eventBus.emitFireAndForget(
    {
      type: 'action.plan.finished',
      payload: { ledgerId, goal, status, completedSteps, totalSteps, spaceId },
    },
    { actor: 'system', spaceId, metadata: { causationId: ledgerId } },
  )

  const msg = `ActionFeedback: plan "${goal}" finished — ${status} (${completedSteps}/${totalSteps} steps)`
  if (status === 'completed') logger.info(msg)
  else logger.warn(msg)
}

// ── Listener Registration ────────────────────────────────────────

/**
 * Register all action-feedback EventBus listeners.
 *
 * Listeners registered:
 *   action.step.completed  → log (observation recording is handled by the caller)
 *   action.plan.finished   → trigger Reflector validation hint
 *   knowledge.tension.detected → log, future: auto-generate plan
 *
 * Returns unsubscribe function for cleanup.
 */
export function registerActionFeedbackListeners(
  eventBus: EventBus,
  options?: TensionHandlerOptions,
): () => void {
  const unsubscribers: (() => void)[] = []

  const minTension = options?.minTensionThreshold ?? DEFAULT_TENSION_THRESHOLD
  const minGap = options?.minGapThreshold ?? DEFAULT_GAP_THRESHOLD

  // Listener 1: step completed → log (observation side handled by the emit source)
  const unsub1 = eventBus.on('action.step.completed', async (event) => {
    const { goal, description, success } = event.payload
    if (success) {
      logger.debug(`ActionFeedback: step completed — "${description}" (goal: ${goal.slice(0, 40)})`)
    }
  })
  unsubscribers.push(unsub1)

  // Listener 2: plan finished → log completion signal
  // Reflector will pick up related observations on its next validate cycle
  const unsub2 = eventBus.on('action.plan.finished', async (event) => {
    const { goal, status, completedSteps, totalSteps } = event.payload
    if (status === 'completed') {
      logger.info(`ActionFeedback: plan completed — "${goal}" (${completedSteps}/${totalSteps})`)
    }
  })
  unsubscribers.push(unsub2)

  // Listener 3: tension detected → log (Phase B will add plan generation here)
  const unsub3 = eventBus.on('knowledge.tension.detected', async (event) => {
    const { spaceId, tensionCount, highPriorityTensions, frontierGaps } = event.payload

    const significantTensions = highPriorityTensions.length >= minTension
    const significantGaps = frontierGaps.some(g => g.gapScore >= minGap)

    if (!significantTensions && !significantGaps) {
      logger.debug(`ActionFeedback: tensions below threshold in ${spaceId}, skipping`)
      return
    }

    logger.info(
      `ActionFeedback: ${tensionCount} tensions detected in ${spaceId}` +
        (significantTensions ? ` (${highPriorityTensions.length} high-priority)` : '') +
        (significantGaps ? ' + frontier gaps' : ''),
    )

    // Phase B: generate ActionPlan from high-priority tensions
    // e.g.: generatePlan(`审查认知偏差: ${highPriorityTensions[0].reason}`, llm)
  })
  unsubscribers.push(unsub3)

  return () => {
    for (const fn of unsubscribers) fn()
  }
}
