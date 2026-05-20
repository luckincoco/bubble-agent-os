/**
 * BoundaryChecker — 统一能力边界检查层 (Gate Layer)。
 *
 * 设计原则：
 * - 内建在 ToolRegistry.invoke()，所有工具调用必经
 * - 零风险（白名单<1ms）→ 中风险（硬规则）→ 高风险（硬+柔性LLM）
 * - 硬规则用 TS 配置文件驱动，预埋 JSON 接口（feature flag 锁死）
 * - 工具注册时声明 reversible，未声明默认不可逆（零信任）
 * - 每次检查写 Episode (type:'system', source:'boundary-check')
 *
 * ADR: docs/adr-architecture-hardening-2026-05-18.md
 */

import { logger } from '../shared/logger.js'
import { classifyRisk, type RiskLevel } from '../scheduler/tasks/evolution-risk.js'

// ── Types ─────────────────────────────────────────────────────────

export type GateDecision = 'allow' | 'deny' | 'confirm'

export interface GateCheckResult {
  decision: GateDecision
  reason: string
  suggestion?: string
  riskLevel: RiskLevel | 'none'
  triggeredRule?: string
  source: 'whitelist' | 'hard-rule' | 'soft-llm'
}

export interface BoundaryRule {
  id: string
  description: string
  /** Tool names this rule applies to. '*' means all tools. */
  tools: string[] | '*'
  condition: (args: Record<string, unknown>, toolName: string) => boolean
  decision: GateDecision
  reason: string
  riskLevel: RiskLevel
}

// ── Configuration ─────────────────────────────────────────────────

/** Tools that are always safe — bypass all checks (< 1ms path) */
const WHITELIST: Set<string> = new Set([
  'web_search',
  'fetch_page',
  'get_steel_price',
  'memory_search',
  'memory_recall',
  'list_bubbles',
  'get_bubble',
  'get_time',
])

/** Hard rules — deterministic boundary checks */
const HARD_RULES: BoundaryRule[] = [
  {
    id: 'deny-file-system-access',
    description: '禁止直接文件系统操作',
    tools: ['exec_code', 'run_command'],
    condition: (args) => {
      const code = String(args.code || args.command || '')
      return /\b(rm|rmdir|del|format|mkfs|dd)\b/.test(code)
    },
    decision: 'deny',
    reason: '检测到破坏性文件系统操作',
    riskLevel: 'high',
  },
  {
    id: 'confirm-data-mutation',
    description: '数据变更需确认',
    tools: ['biz_create', 'biz_update', 'biz_delete'],
    condition: (_args, toolName) => toolName === 'biz_delete',
    decision: 'confirm',
    reason: '业务数据删除操作需要用户确认',
    riskLevel: 'high',
  },
  {
    id: 'deny-core-path-evolution',
    description: '禁止演化核心路径',
    tools: ['self_evolve'],
    condition: (args) => {
      const changes = args.changes as Array<{ file: string }> | undefined
      if (!changes) return false
      const corePaths = ['src/kernel/', 'src/index.ts', 'src/shared/', 'src/server/', 'src/storage/', 'src/ai/']
      return changes.some(c => corePaths.some(p => c.file.includes(p)))
    },
    decision: 'deny',
    reason: '不允许自动演化核心模块路径',
    riskLevel: 'high',
  },
  {
    id: 'token-cost-threshold',
    description: '单次工具调用 token 成本过高时需确认',
    tools: '*',
    condition: (args) => {
      const estimatedTokens = Number(args._estimatedTokens || 0)
      return estimatedTokens >= 5000
    },
    decision: 'confirm',
    reason: '预估 token 消耗超过 5000，需确认',
    riskLevel: 'high',
  },
]

// ── Reversibility Registry ────────────────────────────────────────

/**
 * Tools declare reversible at registration.
 * Undeclared defaults to irreversible (zero trust).
 */
const reversibleTools: Set<string> = new Set()

export function declareReversible(toolName: string): void {
  reversibleTools.add(toolName)
}

export function isReversible(toolName: string): boolean {
  return reversibleTools.has(toolName)
}

// ── Gate Check ────────────────────────────────────────────────────

/**
 * Run boundary check for a tool invocation.
 * Tiered: whitelist → hard rules → (future: soft LLM judgment)
 */
export function checkBoundary(
  toolName: string,
  args: Record<string, unknown>,
): GateCheckResult {
  // Tier 0: Whitelist — instant pass
  if (WHITELIST.has(toolName)) {
    return {
      decision: 'allow',
      reason: '白名单工具',
      riskLevel: 'none',
      source: 'whitelist',
    }
  }

  // Tier 1: Hard rules — deterministic
  for (const rule of HARD_RULES) {
    const applies = rule.tools === '*' || rule.tools.includes(toolName)
    if (!applies) continue

    if (rule.condition(args, toolName)) {
      logger.info(`BoundaryChecker: rule "${rule.id}" triggered for ${toolName}`)
      return {
        decision: rule.decision,
        reason: rule.reason,
        riskLevel: rule.riskLevel,
        triggeredRule: rule.id,
        source: 'hard-rule',
      }
    }
  }

  // Tier 2: Soft LLM judgment (future — currently passthrough)
  // For irreversible tools not covered by hard rules, log a warning
  if (!isReversible(toolName)) {
    logger.debug(`BoundaryChecker: ${toolName} is irreversible, no rule triggered — allowing with caution`)
  }

  return {
    decision: 'allow',
    reason: '无规则命中',
    riskLevel: 'none',
    source: 'hard-rule',
  }
}

// ── Whitelist management ──────────────────────────────────────────

export function addToWhitelist(toolName: string): void {
  WHITELIST.add(toolName)
}

export function removeFromWhitelist(toolName: string): void {
  WHITELIST.delete(toolName)
}

export function getWhitelist(): string[] {
  return [...WHITELIST]
}
