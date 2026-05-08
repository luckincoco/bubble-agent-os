/**
 * CodeHandler — handles the 'code' skill type.
 *
 * Instead of injecting the full SKILL.md body (wastes tokens per Karpathy P2: Simplicity First),
 * injects a condensed checklist of mandatory checkpoints.
 * The full workflow documentation lives in skills/coding-workflow/SKILL.md for reference.
 */

export interface CodeHandlerResult {
  handled: false
  contextInjection: string
}

/**
 * Condensed coding discipline — mandatory checkpoints only.
 * Full rationale in skills/coding-workflow/SKILL.md.
 */
const CODING_CHECKLIST = `[编码纪律 — 强制检查点]
1. DEFINE: 先确认目标和验收标准，模糊就追问，不要假设
2. PLAN: 先 read_file 了解现有代码，再规划。每个切片 ≤100 行改动
3. BUILD: 一次一个切片，写完就用 shell_exec 验证 build/lint
4. VERIFY: 必须有 shell_exec 输出作为证据。"我觉得没问题"不是证据
5. 禁止: 跳过验证门、假设文件内容、一次改 >3 文件不分步验证`

export class CodeHandler {
  handle(_skillBody: string): CodeHandlerResult {
    return {
      handled: false,
      contextInjection: `\n\n${CODING_CHECKLIST}\n`,
    }
  }
}
