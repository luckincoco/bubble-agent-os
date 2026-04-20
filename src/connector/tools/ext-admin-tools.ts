/**
 * Admin tools for managing external contact bindings.
 * These tools are available only to the admin user.
 */

import type { ToolDefinition } from '../registry.js'
import type { UserContext } from '../../shared/types.js'
import type { BizContext } from '../biz/structured-store.js'
import { fuzzyFindCounterparty, getCounterparties } from '../biz/structured-store.js'
import {
  bindExternalContact, unbindExternalContact, listExternalContacts,
} from '../biz/external-store.js'
import { clearIdentityCache } from '../identity.js'

function toBizCtx(ctx?: UserContext): BizContext {
  return { spaceId: ctx?.activeSpaceId ?? '' }
}

// ── ext_bind_contact ─────────────────────────────────────────────────

function createExtBindContactTool(): ToolDefinition {
  return {
    name: 'ext_bind_contact',
    description: '将企微/飞书用户绑定到交易对手方，使其可以通过该平台与泡泡对话并查询自己的业务数据。',
    parameters: {
      platform: { type: 'string', description: "平台：'wecom' 或 'feishu'", required: true },
      platform_user_id: { type: 'string', description: '平台用户ID（企微的FromUserName或飞书的open_id）', required: true },
      counterparty_name: { type: 'string', description: '交易对手方名称（支持模糊匹配）', required: true },
      permission_level: { type: 'string', description: "权限级别：'query'（仅查询）或 'query_confirm'（查询+确认），默认 query" },
    },
    execute: async (args, ctx) => {
      const bizCtx = toBizCtx(ctx)
      const platform = (args.platform as string || '').toLowerCase()
      if (platform !== 'wecom' && platform !== 'feishu') {
        return `平台必须是 wecom 或 feishu，收到: ${platform}`
      }
      const platformUserId = args.platform_user_id as string
      if (!platformUserId) return '请提供平台用户ID'
      const cpName = args.counterparty_name as string
      if (!cpName) return '请提供交易对手方名称'

      // Find counterparty
      const cp = fuzzyFindCounterparty(bizCtx, cpName)
      if (!cp) {
        const all = getCounterparties(bizCtx)
        const names = all.slice(0, 10).map(c => c.name)
        return `找不到"${cpName}"。系统中的往来对象：${names.join('、') || '暂无'}`
      }

      const perm = (args.permission_level as string || 'query') as 'query' | 'query_confirm'
      const contact = bindExternalContact({
        spaceId: bizCtx.spaceId,
        platform: platform as 'wecom' | 'feishu',
        platformUserId,
        counterpartyId: cp.id,
        permissionLevel: perm,
        boundBy: ctx?.userId,
      })

      clearIdentityCache()

      const permLabel = perm === 'query_confirm' ? '查询+确认' : '仅查询'
      const platformLabel = platform === 'wecom' ? '企微' : '飞书'
      return `已将${platformLabel}用户 ${platformUserId} 绑定到「${cp.name}」（${cp.type === 'supplier' ? '供应商' : cp.type === 'customer' ? '客户' : '物流商'}），权限：${permLabel}`
    },
  }
}

// ── ext_unbind_contact ───────────────────────────────────────────────

function createExtUnbindContactTool(): ToolDefinition {
  return {
    name: 'ext_unbind_contact',
    description: '解绑/停用某个交易对手方的外部联系人访问权限。',
    parameters: {
      counterparty_name: { type: 'string', description: '交易对手方名称', required: true },
    },
    execute: async (args, ctx) => {
      const bizCtx = toBizCtx(ctx)
      const cpName = args.counterparty_name as string
      if (!cpName) return '请提供交易对手方名称'

      const cp = fuzzyFindCounterparty(bizCtx, cpName)
      if (!cp) return `找不到"${cpName}"`

      const count = unbindExternalContact(cp.id)
      clearIdentityCache()

      if (count === 0) return `「${cp.name}」没有已启用的外部联系人绑定`
      return `已停用「${cp.name}」的 ${count} 个外部联系人绑定`
    },
  }
}

// ── ext_list_contacts ────────────────────────────────────────────────

function createExtListContactsTool(): ToolDefinition {
  return {
    name: 'ext_list_contacts',
    description: '列出所有已绑定的外部联系人及其状态。',
    parameters: {},
    execute: async (_args, ctx) => {
      const spaceId = ctx?.activeSpaceId ?? ''
      const contacts = listExternalContacts(spaceId)

      if (contacts.length === 0) return '暂无已绑定的外部联系人'

      const lines = contacts.map(c => {
        const platformLabel = c.platform === 'wecom' ? '企微' : '飞书'
        const permLabel = c.permissionLevel === 'query_confirm' ? '查询+确认' : '仅查询'
        const status = c.enabled ? '启用' : '停用'
        const active = c.isActive ? ' [当前]' : ''
        return `- ${c.counterpartyName}（${c.counterpartyType === 'supplier' ? '供应商' : c.counterpartyType === 'customer' ? '客户' : '物流商'}）← ${platformLabel}:${c.platformUserId} [${permLabel}] [${status}]${active}`
      })

      return `已绑定的外部联系人（共${contacts.length}个）：\n${lines.join('\n')}`
    },
  }
}

// ── Export ────────────────────────────────────────────────────────────

export function createExtAdminTools(): ToolDefinition[] {
  return [
    createExtBindContactTool(),
    createExtUnbindContactTool(),
    createExtListContactsTool(),
  ]
}
