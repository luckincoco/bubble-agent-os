/**
 * self-evolution.ts — Scheduled task that evaluates interest-search findings
 * and proposes/applies code improvements to Bubble itself.
 *
 * Workflow (follows coding-workflow discipline):
 *   1. DEFINE — Query recent interest-search bubbles, LLM evaluates relevance
 *   2. PLAN  — LLM generates change plan with risk factors
 *   3. Risk classification (deterministic)
 *   4. Low risk → BUILD + VERIFY + SHIP (auto)
 *   5. High risk → Propose via Feishu, wait for approval
 */

import type { TaskDeps, TaskResult } from '../scheduler.js'
import { getDatabase } from '../../storage/database.js'
import { createBubble } from '../../bubble/model.js'
import { classifyRisk, type EvolutionPlan, type EvolutionChange } from './evolution-risk.js'
import { gitCommitChanges, gitRevert, validateTypeCheck } from './evolution-git.js'
import { logger } from '../../shared/logger.js'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const RELEVANCE_PROMPT = `你是一个 AI 系统自我改进评估器。你正在评估一条知识是否可以用来改进一个 TypeScript/Node.js AI Agent 系统（Bubble Agent OS）。

该系统的核心能力：记忆管理、LLM对话、工具调用、定时任务、多渠道接入（飞书/企业微信）。
技术栈：TypeScript, Node.js, SQLite, Fastify, DeepSeek API。

请判断以下知识是否包含可以直接应用于改进此系统的技术方案、算法、架构模式或最佳实践。

严格过滤：
- 纯理论讨论、哲学思考 → 不相关
- 其他语言/平台特定技术（如 Rust、Go 独有的特性）→ 不相关
- 通用 AI 新闻/公告 → 不相关
- 具体可实现的优化、新工具思路、算法改进 → 相关

输出严格 JSON：{"relevant": true/false, "reason": "一句话说明", "improvement": "如果相关，一句话描述可能的改进"}`

const PLAN_PROMPT = `你是一个代码改进规划器。基于给定的知识和当前项目文件结构，生成一个具体的代码变更计划。

要求（Karpathy P1: Think Before Coding — 先暴露假设再行动）：
1. 先列出你的假设 — 你认为当前代码是什么状态？改动基于什么前提？
2. 变更必须是最小化的 — 只改必要的部分
3. 优先创建新文件而不是修改现有文件
4. 保持与项目现有风格一致
5. 如果假设中有任何不确定项，将 "confident" 设为 false

输出严格 JSON:
{
  "assumptions": ["假设1: ...", "假设2: ..."],
  "confident": true/false,
  "summary": "一句话描述改进",
  "changes": [
    {"file": "相对路径", "action": "create|modify|append", "description": "做什么", "content": "完整的文件内容或变更内容"}
  ]
}`

export async function executeSelfEvolution(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  // Guard: require CODE_TOOLS to be enabled
  if (process.env.CODE_TOOLS !== 'true') {
    return { success: true, message: '自进化: CODE_TOOLS 未启用，跳过' }
  }

  const projectRoot = process.env.BUBBLE_PROJECT_ROOT || process.cwd()
  const searchLlm = deps.llmRouter?.forCategory('memory') ?? deps.llm

  // ── Step 1: DEFINE — Find recent interest-search bubbles not yet evaluated ──
  const db = getDatabase()
  const cutoff = Date.now() - 24 * 60 * 60 * 1000 // last 24h
  const candidates = db.prepare(
    `SELECT id, title, content FROM bubbles
     WHERE (tags LIKE '%interest-search%' OR tags LIKE '%deep-read%')
     AND created_at > ?
     AND json_extract(metadata, '$.evolutionChecked') IS NULL
     AND deleted_at IS NULL
     ORDER BY confidence DESC
     LIMIT 10`,
  ).all(cutoff) as Array<{ id: string; title: string; content: string }>

  if (candidates.length === 0) {
    return { success: true, message: '自进化: 无未评估的兴趣搜索结果' }
  }

  logger.info(`SelfEvolution: evaluating ${candidates.length} candidates`)

  // ── Step 2: LLM relevance filter (batch) ──
  let relevantCandidate: { id: string; title: string; content: string; improvement: string } | null = null

  for (const candidate of candidates) {
    try {
      const response = await searchLlm.chat([
        { role: 'system', content: RELEVANCE_PROMPT },
        { role: 'user', content: `标题: ${candidate.title}\n内容: ${candidate.content.slice(0, 800)}` },
      ])

      const jsonMatch = response.content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as { relevant: boolean; reason: string; improvement?: string }
        if (parsed.relevant && parsed.improvement) {
          relevantCandidate = { ...candidate, improvement: parsed.improvement }
          break // Process only the first relevant one per run
        }
      }
    } catch (err) {
      logger.debug(`SelfEvolution: relevance check failed for ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`)
    }

    // Mark as checked regardless
    markEvolutionChecked(db, candidate.id)
  }

  if (!relevantCandidate) {
    // Mark all remaining as checked
    for (const c of candidates) {
      markEvolutionChecked(db, c.id)
    }
    return { success: true, message: `自进化: 评估 ${candidates.length} 条, 无可应用改进` }
  }

  logger.info(`SelfEvolution: found actionable improvement from "${relevantCandidate.title}" — ${relevantCandidate.improvement}`)

  // ── Step 3: PLAN — Generate code change plan ──
  let plan: EvolutionPlan
  try {
    // Get project structure for context
    const tools = deps.tools
    const structureResult = await tools.execute('list_directory', { path: `${projectRoot}/src`, recursive: 'false' })

    const response = await searchLlm.chat([
      { role: 'system', content: PLAN_PROMPT },
      {
        role: 'user',
        content: `知识来源:\n${relevantCandidate.content.slice(0, 1000)}\n\n改进方向: ${relevantCandidate.improvement}\n\n项目 src/ 结构:\n${structureResult}\n\n项目根目录: ${projectRoot}`,
      },
    ])

    const jsonMatch = response.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      markEvolutionChecked(db, relevantCandidate.id)
      return { success: true, message: '自进化: LLM 未能生成有效计划' }
    }

    const parsed = JSON.parse(jsonMatch[0]) as { summary: string; changes: EvolutionChange[]; assumptions?: string[]; confident?: boolean }

    // Karpathy P1: If LLM is not confident about its assumptions, skip auto-execution
    if (parsed.confident === false) {
      logger.info(`SelfEvolution: LLM not confident (assumptions: ${(parsed.assumptions || []).join('; ')}), skipping`)
      markEvolutionChecked(db, relevantCandidate.id)
      return { success: true, message: `自进化: LLM 对假设不确定，跳过 — ${parsed.assumptions?.join('; ') || 'no details'}` }
    }

    plan = {
      summary: parsed.summary,
      changes: parsed.changes || [],
      sourceBubbleId: relevantCandidate.id,
    }
  } catch (err) {
    markEvolutionChecked(db, relevantCandidate.id)
    return { success: false, message: `自进化: 计划生成失败 — ${err instanceof Error ? err.message : String(err)}` }
  }

  if (plan.changes.length === 0) {
    markEvolutionChecked(db, relevantCandidate.id)
    return { success: true, message: '自进化: 计划为空，无变更' }
  }

  // ── Step 4: Risk classification ──
  const riskLevel = classifyRisk(plan)
  logger.info(`SelfEvolution: plan "${plan.summary}" classified as ${riskLevel} risk (${plan.changes.length} changes)`)

  if (riskLevel === 'high') {
    // ── High risk: propose via Feishu, don't auto-apply ──
    const proposalBubble = createBubble({
      type: 'event',
      title: `自进化提案: ${plan.summary}`,
      content: JSON.stringify(plan, null, 2),
      tags: ['evolution-proposal', 'pending'],
      source: 'self-evolution',
      confidence: 0.7,
      decayRate: 0.08,
      metadata: {
        status: 'pending',
        riskLevel: 'high',
        sourceBubbleId: relevantCandidate.id,
        proposedAt: Date.now(),
        plan,
      },
    })

    // Push to Feishu if available
    if (deps.feishu) {
      const chatId = deps.feishu.getAdminChatId() || process.env.FEISHU_ADMIN_CHAT_ID || ''
      if (chatId) {
        const changeList = plan.changes.map(c => `  - ${c.file}: ${c.action} — ${c.description}`).join('\n')
        await deps.feishu.pushMessage(chatId,
          `🧬 Self-Evolution Proposal\n\n灵感: ${relevantCandidate.title}\n摘要: ${plan.summary}\n变更:\n${changeList}\n风险: HIGH\n\n回复 "approve ${proposalBubble.id}" 应用\n回复 "reject ${proposalBubble.id}" 驳回`,
        )
      }
    }

    markEvolutionChecked(db, relevantCandidate.id)
    return { success: true, message: `自进化: 高风险提案已推送审批 — ${plan.summary}`, bubbleIds: [proposalBubble.id] }
  }

  // ── Low risk: auto-apply (BUILD + VERIFY + SHIP) ──
  try {
    // BUILD: Apply changes
    for (const change of plan.changes) {
      const filePath = change.file.startsWith('/') ? change.file : `${projectRoot}/${change.file}`
      if (change.action === 'create') {
        mkdirSync(dirname(filePath), { recursive: true })
        writeFileSync(filePath, (change as any).content || '', 'utf-8')
      } else if (change.action === 'append') {
        const existing = readFileSync(filePath, 'utf-8')
        writeFileSync(filePath, existing + '\n' + ((change as any).content || ''), 'utf-8')
      }
      // 'modify' is handled same as create for low-risk (which shouldn't happen due to risk rules)
    }

    // VERIFY: Type check
    const { pass, output } = await validateTypeCheck(projectRoot)
    if (!pass) {
      // Rollback: discard changes
      const { exec } = await import('node:child_process')
      await new Promise<void>((resolve) => {
        exec('git checkout -- .', { cwd: projectRoot }, () => resolve())
      })
      logger.warn(`SelfEvolution: type check failed, changes reverted`)
      markEvolutionChecked(db, relevantCandidate.id)
      return { success: false, message: `自进化: 类型检查失败，已回滚 — ${output.slice(0, 200)}` }
    }

    // SHIP: Git commit
    const { hash, success } = await gitCommitChanges(projectRoot, plan.summary, relevantCandidate.id)
    if (!success) {
      markEvolutionChecked(db, relevantCandidate.id)
      return { success: false, message: '自进化: git commit 失败' }
    }

    // Record successful evolution
    createBubble({
      type: 'event',
      title: `自进化完成: ${plan.summary}`,
      content: `基于兴趣搜索 "${relevantCandidate.title}" 的发现，自动应用了代码改进。\n\nCommit: ${hash}\n\n变更: ${plan.changes.map(c => `${c.file} (${c.action})`).join(', ')}`,
      tags: ['self-evolution', 'applied'],
      source: 'self-evolution',
      confidence: 0.9,
      decayRate: 0.03,
      metadata: { commitHash: hash, plan, sourceBubbleId: relevantCandidate.id, appliedAt: Date.now() },
    })

    markEvolutionChecked(db, relevantCandidate.id)

    // Notify via Feishu
    if (deps.feishu) {
      const chatId = deps.feishu.getAdminChatId() || process.env.FEISHU_ADMIN_CHAT_ID || ''
      if (chatId) {
        await deps.feishu.pushMessage(chatId,
          `🧬 自进化完成\n\n${plan.summary}\n来源: ${relevantCandidate.title}\nCommit: ${hash.slice(0, 8)}`,
        )
      }
    }

    return { success: true, message: `自进化: 低风险改进已应用 — ${plan.summary} (${hash.slice(0, 8)})`, bubbleIds: [] }
  } catch (err) {
    markEvolutionChecked(db, relevantCandidate.id)
    return { success: false, message: `自进化: 执行失败 — ${err instanceof Error ? err.message : String(err)}` }
  }
}

function markEvolutionChecked(db: ReturnType<typeof getDatabase>, bubbleId: string): void {
  try {
    const row = db.prepare('SELECT metadata FROM bubbles WHERE id = ?').get(bubbleId) as { metadata: string } | undefined
    if (!row) return
    const existing = row.metadata ? JSON.parse(row.metadata) : {}
    db.prepare('UPDATE bubbles SET metadata = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({ ...existing, evolutionChecked: Date.now() }),
      Date.now(),
      bubbleId,
    )
  } catch {
    // Non-critical, skip
  }
}
