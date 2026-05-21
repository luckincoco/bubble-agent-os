/**
 * Wiring module — EventBus connections between Bubble's cognitive layers.
 *
 * Keeps wiring logic separate from core modules. New integrations
 * (e.g. ActionPlanner ↔ Reflector) add a file here rather than
 * modifying existing module internals.
 */

export {
  createStepObserver,
  emitPlanFinished,
  registerActionFeedbackListeners,
} from './action-feedback.js'
export type { StepObserver, TensionHandlerOptions, PlanStepStub, StepResultStub } from './action-feedback.js'
