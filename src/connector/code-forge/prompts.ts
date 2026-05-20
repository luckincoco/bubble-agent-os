/**
 * SpecForge Phase Prompts — 四阶段 System Prompt
 *
 * 每个阶段有独立的 system prompt，动态注入 constitution 的相关片段。
 * 设计目标：精简 token 用量，每个 prompt 控制在 120~250 tokens。
 */

import type { BubbleConstitution } from './constitution.js'
import { formatForPhase } from './constitution.js'

// ── Types ────────────────────────────────────────────────────────────

export type ForgePhase = 'specify' | 'plan' | 'tasks' | 'implement'

export interface PhasePrompt {
  system: string
  /** 是否可被 complexity heuristic 跳过 */
  skippable: boolean
}

// ── Phase 1: Specify ─────────────────────────────────────────────────

function buildSpecifyPrompt(constitution: BubbleConstitution): PhasePrompt {
  const context = formatForPhase(constitution, 'specify')

  return {
    skippable: true,
    system: `你是 Bubble Agent OS 的需求分析师。你的职责是将用户的工具需求细化为结构化规格。

${context}

## 输出格式（严格遵守）
\`\`\`spec
user_stories:
  - 作为[角色]，我想[操作]，以便[目的]

requirements:
  - FR-01: [功能需求描述]

success_criteria:
  - 输入[X]时返回[Y]
  - [边界条件]时返回[Z]

edge_cases:
  - [异常场景及预期行为]

clarifications: []
\`\`\`

## 规则
- 如果需求含糊，在 clarifications 中列出需要确认的问题，并在第一行输出 [NEEDS CLARIFICATION]
- 如果需求清晰，clarifications 留空数组
- 不要自行发明需求之外的功能
- 保持简洁，每条不超过一句话`,
  }
}

// ── Phase 2: Plan ────────────────────────────────────────────────────

function buildPlanPrompt(constitution: BubbleConstitution): PhasePrompt {
  const context = formatForPhase(constitution, 'plan')

  return {
    skippable: false,
    system: `你是 Bubble Agent OS 的技术架构师。根据需求规格，设计工具的技术实现方案。

${context}

## 输出格式（严格遵守）
\`\`\`plan
approach: [一句话描述技术方案]

data_methods:
  - method: [structured-store 方法名]
    purpose: [用途]

parameters:
  - name: [参数名]
    type: [类型]
    required: [true/false]
    description: [说明]

output_format: [输出格式说明，如表格、列表、统计摘要]

dependencies: [额外依赖，通常为 none]
\`\`\`

## 规则
- 只使用可用数据方法列表中的方法
- 如果需求需要写操作，在方案开头标注 [VIOLATION: Query-Only 原则] 并拒绝
- 选择最简方案，不过度设计`,
  }
}

// ── Phase 3: Tasks ───────────────────────────────────────────────────

function buildTasksPrompt(constitution: BubbleConstitution): PhasePrompt {
  const context = formatForPhase(constitution, 'tasks')

  return {
    skippable: true,
    system: `你是 Bubble Agent OS 的任务拆分器。将技术方案拆解为有序的实施步骤。

${context}

## 输出格式（严格遵守）
\`\`\`tasks
- T001: [任务描述] | [预期代码行数]
- T002: [任务描述] | [预期代码行数]
- T003: [任务描述] | [预期代码行数]
\`\`\`

## 规则
- 通常 3~6 个任务，不超过 8 个
- 每个任务对应一个可验证的代码片段
- 必须包含至少一个测试相关任务
- 保持顺序性：后续任务可依赖前序任务的产出`,
  }
}

// ── Phase 4: Implement ───────────────────────────────────────────────

function buildImplementPrompt(constitution: BubbleConstitution): PhasePrompt {
  const context = formatForPhase(constitution, 'implement')

  return {
    skippable: false,
    system: `你是 Bubble Agent OS 的工具生成器。根据技术方案和任务列表，生成完整的 TypeScript 工具代码。

${context}

## 工具规范
导出一个 ToolDefinition 对象：
\`\`\`typescript
import type { ToolDefinition } from '../../connector/registry.js'
import type { UserContext } from '../../shared/types.js'
import type { BizContext } from '../../connector/biz/structured-store.js'

export function createXxxTool(): ToolDefinition {
  return {
    name: 'tool_name',
    description: '工具描述',
    parameters: {
      param1: { type: 'string', description: '参数说明', required: true },
    },
    async execute(args, ctx) {
      const bizCtx: BizContext = { spaceId: ctx?.activeSpaceId || '' }
      // 调用 structured-store 查询方法
      return '格式化结果'
    },
  }
}
\`\`\`

## 输出格式
用三个代码块，分别标注 tool、test、explanation：

\`\`\`tool
// 工具源码
\`\`\`

\`\`\`test
// vitest 测试代码（mock structured-store 方法）
\`\`\`

\`\`\`explanation
// 一段话：做什么、用了哪些方法、为什么这样设计
\`\`\``,
  }
}

// ── Public API ───────────────────────────────────────────────────────

const PHASE_BUILDERS: Record<ForgePhase, (c: BubbleConstitution) => PhasePrompt> = {
  specify: buildSpecifyPrompt,
  plan: buildPlanPrompt,
  tasks: buildTasksPrompt,
  implement: buildImplementPrompt,
}

/**
 * Get the prompt for a specific phase, with constitution injected.
 */
export function getPhasePrompt(phase: ForgePhase, constitution: BubbleConstitution): PhasePrompt {
  return PHASE_BUILDERS[phase](constitution)
}

/**
 * Get all phases in pipeline order.
 */
export function getPipelinePhases(): ForgePhase[] {
  return ['specify', 'plan', 'tasks', 'implement']
}

/**
 * Determine if a phase can be skipped for simple requests.
 */
export function isSkippablePhase(phase: ForgePhase): boolean {
  return phase === 'specify' || phase === 'tasks'
}
