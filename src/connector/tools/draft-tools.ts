/**
 * Draft observation tools — 用户通过对话审批 Bubble 的自主思考草稿
 */

import type { ToolDefinition } from '../registry.js'
import { listDrafts, confirmDraft, rejectDraft, countDrafts } from '../../memory/draft-observations.js'

export function createDraftTools(): ToolDefinition[] {
  return [
    {
      name: 'list_drafts',
      description: '列出所有待审核的自主思考草稿（draft observations）。当用户问"有什么待审的"或"最近想到什么"时使用。',
      parameters: {},
      reversible: true,
      async execute(_args, ctx) {
        const spaceId = ctx?.activeSpaceId
        const drafts = listDrafts(spaceId)
        if (drafts.length === 0) {
          return '当前没有待审核的思考草稿。'
        }
        const lines = drafts.map((d, i) => {
          const date = new Date(d.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          return `${i + 1}. [${d.id}] (${date}, 来源: ${d.source})\n   ${d.content}${d.context ? `\n   背景: ${d.context}` : ''}`
        })
        return `待审核草稿 (${drafts.length} 条):\n\n${lines.join('\n\n')}\n\n回复"确认 [编号或ID]"或"删除 [编号或ID]"来审批。`
      },
    },
    {
      name: 'review_draft',
      description: '审批一条自主思考草稿。action 为 confirm（确认，升级为正式 observation）或 reject（拒绝删除）。',
      parameters: {
        draft_id: { type: 'string', description: '草稿 ID', required: true },
        action: { type: 'string', description: 'confirm 或 reject', required: true },
      },
      async execute(args) {
        const draftId = args.draft_id as string
        const action = args.action as string

        if (action === 'confirm') {
          const obsId = confirmDraft(draftId)
          if (obsId) {
            return `草稿已确认，升级为正式 observation (${obsId})。`
          }
          return `未找到草稿 ${draftId}。`
        }

        if (action === 'reject') {
          const ok = rejectDraft(draftId)
          return ok ? `草稿 ${draftId} 已删除。` : `未找到草稿 ${draftId}。`
        }

        return 'action 必须是 confirm 或 reject。'
      },
    },
  ]
}
