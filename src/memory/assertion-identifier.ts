/**
 * Assertion Identifier — identifies and tags assertions in Bubble's output.
 *
 * After each Brain.think() turn, this module asynchronously classifies substantive
 * claims in the assistant's response by type (fact/judgment/speculation/reference)
 * and source (user_statement/tool_result/self_inference/external_source).
 *
 * This is the prerequisite for the Deferred Verification Layer:
 * without knowing which parts are assertions, we cannot verify them.
 *
 * Design decisions:
 * - Async, fire-and-forget: never blocks the response
 * - Metadata-only: does NOT modify the reply text
 * - Stores results in conversation_assertions table, linked by turnId
 */

import type { LLMProvider, LLMMessage, AssertionType, AssertionSource, VerificationStatus, AssertionTag } from '../shared/types.js'
import { getDatabase } from '../storage/database.js'
import { ulid } from 'ulid'
import { logger } from '../shared/logger.js'

// ── Types ──────────────────────────────────────────────────────

interface RawAssertion {
  textSnippet: string
  assertionType: AssertionType
  source: AssertionSource
  confidence: number
}

interface IdentifyResult {
  assertions: RawAssertion[]
}

export interface AssertionStats {
  byType: Record<string, number>
  byStatus: Record<string, number>
  total: number
  userCalibrated: number
}

// ── Constants ──────────────────────────────────────────────────

const MIN_RESPONSE_LENGTH = 300
const MAX_ASSERTIONS_PER_TURN = 8

const ASSERTION_IDENTIFY_PROMPT = `你是断言分类引擎。分析AI的回复，识别其中的实质性断言，并为每条断言分类。

断言类型定义：
- fact: 可验证的事实陈述（数字、日期、事件、明确的状态描述）
- judgment: 基于证据的判断（趋势评估、因果断言、评价性结论）
- speculation: 缺乏充分证据的推测（"也许""可能""我猜"等不确定性表述）
- reference: 引用外部来源的信息（"根据X""X说了""文献显示"）

来源类型定义：
- user_statement: 信息来源于用户的陈述或提供的数据
- tool_result: 信息来源于工具/API调用返回的结果
- self_inference: AI自身推理得出的结论
- external_source: 引用外部知识源（训练数据中的通用知识）

注意：
- 只识别实质性断言，跳过问候、确认、过渡语、元认知标注
- 每条回复最多识别${MAX_ASSERTIONS_PER_TURN}条断言
- 如果回复中几乎没有实质性断言（纯闲聊、简单确认），返回空数组
- confidence表示分类器的置信度，0-1之间

输出严格JSON:
{
  "assertions": [
    {
      "textSnippet": "原文片段（从回复中摘取的原文）",
      "assertionType": "fact|judgment|speculation|reference",
      "source": "user_statement|tool_result|self_inference|external_source",
      "confidence": 0.8
    }
  ]
}`

// ── Identifier ──────────────────────────────────────────────────

export class AssertionIdentifier {
  private llm: LLMProvider

  constructor(llm: LLMProvider) {
    this.llm = llm
  }

  /**
   * Identify assertions in a conversation turn.
   * Called asynchronously from Brain.think() — never blocks the response.
   */
  async identify(
    userInput: string,
    assistantResponse: string,
    turnId: string,
    userId: string,
    spaceId?: string,
  ): Promise<AssertionTag[]> {
    // Skip short/trivial responses
    if (assistantResponse.length < MIN_RESPONSE_LENGTH) return []

    // Skip if response is an error or fallback
    if (assistantResponse.includes('抱歉') && assistantResponse.length < 400) return []

    try {
      const result = await this.classifyAssertions(userInput, assistantResponse)
      if (!result.assertions || result.assertions.length === 0) return []

      const now = Date.now()
      const tags: AssertionTag[] = []

      for (const raw of result.assertions.slice(0, MAX_ASSERTIONS_PER_TURN)) {
        const tag: AssertionTag = {
          id: ulid(),
          userId,
          spaceId: spaceId ?? undefined,
          turnId,
          textSnippet: raw.textSnippet,
          assertionType: raw.assertionType,
          source: raw.source,
          verificationStatus: 'pending',
          confidence: raw.confidence,
          userCalibrated: false,
          createdAt: now,
          updatedAt: now,
        }

        this.storeTag(tag)
        tags.push(tag)
      }

      // Update assertion count on the turn
      if (tags.length > 0) {
        const db = getDatabase()
        db.prepare('UPDATE conversation_turns SET assertion_count = ? WHERE id = ?')
          .run(tags.length, turnId)
      }

      logger.info(`AssertionIdentifier: ${tags.length} assertions identified for turn ${turnId.slice(-6)}`)
      return tags
    } catch (err) {
      logger.debug(`AssertionIdentifier: identify error: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  /** Get assertions for a specific conversation turn. */
  getAssertionsByTurn(turnId: string): AssertionTag[] {
    const db = getDatabase()
    const rows = db.prepare(
      'SELECT * FROM conversation_assertions WHERE turn_id = ? ORDER BY created_at'
    ).all(turnId) as Array<Record<string, unknown>>

    return rows.map(row => this.rowToTag(row))
  }

  /** Get assertions for a user, with optional filters. */
  getAssertionsByUser(
    userId: string,
    filters?: {
      assertionType?: AssertionType
      verificationStatus?: VerificationStatus
      since?: number
      limit?: number
    },
  ): AssertionTag[] {
    const db = getDatabase()
    let sql = 'SELECT * FROM conversation_assertions WHERE user_id = ?'
    const params: unknown[] = [userId]

    if (filters?.assertionType) {
      sql += ' AND assertion_type = ?'
      params.push(filters.assertionType)
    }
    if (filters?.verificationStatus) {
      sql += ' AND verification_status = ?'
      params.push(filters.verificationStatus)
    }
    if (filters?.since) {
      sql += ' AND created_at >= ?'
      params.push(filters.since)
    }

    sql += ' ORDER BY created_at DESC'

    if (filters?.limit) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>
    return rows.map(row => this.rowToTag(row))
  }

  /** Calibrate an assertion based on user feedback. */
  calibrateAssertion(
    id: string,
    updates: { assertionType?: AssertionType; verificationStatus?: VerificationStatus },
  ): boolean {
    const db = getDatabase()
    const now = Date.now()

    const fields: string[] = ['user_calibrated = 1', 'updated_at = ?']
    const params: unknown[] = [now]

    if (updates.assertionType) {
      fields.push('assertion_type = ?')
      params.push(updates.assertionType)
    }
    if (updates.verificationStatus) {
      fields.push('verification_status = ?')
      params.push(updates.verificationStatus)
    }

    params.push(id)

    const result = db.prepare(
      `UPDATE conversation_assertions SET ${fields.join(', ')} WHERE id = ?`
    ).run(...params)

    return result.changes > 0
  }

  /** Get aggregate assertion statistics. */
  getAssertionSummary(spaceId?: string): AssertionStats {
    const db = getDatabase()
    const spaceFilter = spaceId ? 'WHERE space_id = ?' : ''
    const params = spaceId ? [spaceId] : []

    const byType: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    let total = 0
    let userCalibrated = 0

    const rows = db.prepare(
      `SELECT assertion_type, verification_status, user_calibrated FROM conversation_assertions ${spaceFilter}`
    ).all(...params) as Array<{ assertion_type: string; verification_status: string; user_calibrated: number }>

    for (const row of rows) {
      total++
      byType[row.assertion_type] = (byType[row.assertion_type] || 0) + 1
      byStatus[row.verification_status] = (byStatus[row.verification_status] || 0) + 1
      if (row.user_calibrated) userCalibrated++
    }

    return { byType, byStatus, total, userCalibrated }
  }

  // ── Private ──────────────────────────────────────────────────

  private async classifyAssertions(userInput: string, response: string): Promise<IdentifyResult> {
    const messages: LLMMessage[] = [
      { role: 'system', content: ASSERTION_IDENTIFY_PROMPT },
      {
        role: 'user',
        content: `## 用户消息\n${userInput.slice(0, 500)}\n\n## AI回复\n${response.slice(0, 2000)}`,
      },
    ]

    const result = await this.llm.chat(messages)
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { assertions: [] }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as IdentifyResult
      return {
        assertions: (parsed.assertions || []).filter(
          (a: RawAssertion) => a.textSnippet && a.assertionType && a.source,
        ),
      }
    } catch {
      return { assertions: [] }
    }
  }

  private storeTag(tag: AssertionTag): void {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO conversation_assertions
        (id, user_id, space_id, turn_id, text_snippet, assertion_type, source_type,
         verification_status, confidence, user_calibrated, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tag.id, tag.userId, tag.spaceId ?? null, tag.turnId, tag.textSnippet,
      tag.assertionType, tag.source, tag.verificationStatus, tag.confidence,
      tag.userCalibrated ? 1 : 0, tag.createdAt, tag.updatedAt,
    )
  }

  private rowToTag(row: Record<string, unknown>): AssertionTag {
    return {
      id: row.id as string,
      userId: row.user_id as string,
      spaceId: (row.space_id as string) || undefined,
      turnId: row.turn_id as string,
      textSnippet: row.text_snippet as string,
      assertionType: row.assertion_type as AssertionType,
      source: row.source_type as AssertionSource,
      verificationStatus: row.verification_status as VerificationStatus,
      confidence: row.confidence as number,
      userCalibrated: (row.user_calibrated as number) === 1,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }
  }
}
