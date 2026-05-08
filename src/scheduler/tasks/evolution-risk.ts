/**
 * evolution-risk.ts — Deterministic risk classification for self-evolution proposals.
 *
 * Rules: conservative by default. Only the most benign operations are "low risk".
 * Any ambiguity → high risk (requires human approval).
 */

export interface EvolutionChange {
  file: string
  action: 'create' | 'modify' | 'append'
  description: string
}

export interface EvolutionPlan {
  summary: string
  changes: EvolutionChange[]
  sourceBubbleId: string
}

export type RiskLevel = 'low' | 'high'

/** Paths that are always high-risk to modify */
const HIGH_RISK_PATHS = [
  'src/kernel/',
  'src/index.ts',
  'src/shared/',
  'src/server/',
  'src/storage/',
  'src/ai/',
]

/** Paths where new file creation is considered low-risk */
const LOW_RISK_CREATE_PATHS = [
  'src/connector/tools/',
  'src/scheduler/tasks/',
]

/**
 * Classify risk level of a self-evolution plan.
 * Pure function — no LLM calls, no filesystem access.
 */
export function classifyRisk(plan: EvolutionPlan): RiskLevel {
  const { changes } = plan

  // No changes = nothing to do (treat as low, will be a no-op)
  if (changes.length === 0) return 'low'

  // Multiple files changed → always high risk
  if (changes.length > 1) return 'high'

  const change = changes[0]

  // Any modification to existing files → high risk
  if (change.action === 'modify') return 'high'

  // Touching high-risk paths → high risk
  for (const dangerPath of HIGH_RISK_PATHS) {
    if (change.file.includes(dangerPath)) return 'high'
  }

  // Creating a new file in safe directories → low risk
  if (change.action === 'create') {
    for (const safePath of LOW_RISK_CREATE_PATHS) {
      if (change.file.includes(safePath)) return 'low'
    }
  }

  // Appending to .env → low risk
  if (change.action === 'append' && change.file.endsWith('.env')) return 'low'

  // Default: high risk
  return 'high'
}
