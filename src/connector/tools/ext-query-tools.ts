/**
 * External user query tools — scoped to a single counterparty.
 * Each tool automatically filters by the external user's counterpartyId.
 * Sensitive fields (cost, profit, exposure) are never exposed.
 */

import type { ToolDefinition } from '../registry.js'
import type { UserContext, ExternalUserContext } from '../../shared/types.js'
import { isExternalContext } from '../../shared/types.js'
import type { BizContext } from '../biz/structured-store.js'
import { getPurchases, getSales, getPayments, getLogistics } from '../biz/structured-store.js'
import { getCounterpartyStatement } from '../biz/reports.js'
import { logExternalAction, switchActiveBinding, listUserBindings } from '../biz/external-store.js'
import { clearIdentityCache } from '../identity.js'

// ── Helpers ──────────────────────────────────────────────────────────

function toExtCtx(ctx?: UserContext): { bizCtx: BizContext; ext: ExternalUserContext } | null {
  if (!ctx || !isExternalContext(ctx)) return null
  return { bizCtx: { spaceId: ctx.activeSpaceId }, ext: ctx }
}

function fmt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return '0'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function mdTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '暂无数据'
  const sep = headers.map(() => '---')
  return [
    `| ${headers.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
  ].join('\n')
}

const STATUS_MAP: Record<string, string> = {
  draft: '草稿', confirmed: '已确认', completed: '已完成', cancelled: '已取消',
}

// ── ext_my_orders ────────────────────────────────────────────────────

function createExtMyOrdersTool(): ToolDefinition {
  return {
    name: 'ext_my_orders',
    description: '查询与您相关的订单（采购/销售记录）。可按日期范围筛选。',
    parameters: {
      date_from: { type: 'string', description: '开始日期 YYYY-MM-DD（可选）' },
      date_to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { bizCtx, ext } = ec
      const dateFrom = args.date_from as string | undefined
      const dateTo = args.date_to as string | undefined

      let result: string
      if (ext.counterpartyType === 'supplier') {
        const rows = getPurchases(bizCtx, { supplierId: ext.counterpartyId, dateFrom, dateTo })
        if (rows.length === 0) { result = '暂无与您相关的采购记录'; } else {
          result = `与${ext.counterpartyName}相关的采购记录（共${rows.length}条）：\n\n` +
            mdTable(['日期', '品名', '吨位', '单价', '总额', '状态'], rows.map(r => [
              r.date, r.productId ?? '-', fmt(r.tonnage), fmt(r.unitPrice), fmt(r.totalAmount),
              STATUS_MAP[r.docStatus ?? ''] ?? r.docStatus ?? '-',
            ]))
        }
      } else {
        const rows = getSales(bizCtx, { customerId: ext.counterpartyId, dateFrom, dateTo })
        if (rows.length === 0) { result = '暂无与您相关的销售记录'; } else {
          result = `与${ext.counterpartyName}相关的销售记录（共${rows.length}条）：\n\n` +
            mdTable(['日期', '品名', '吨位', '单价', '总额', '状态'], rows.map(r => [
              r.date, r.productId ?? '-', fmt(r.tonnage), fmt(r.unitPrice), fmt(r.totalAmount),
              STATUS_MAP[r.docStatus ?? ''] ?? r.docStatus ?? '-',
            ]))
        }
      }
      logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_orders', outputText: result })
      return result
    },
  }
}

// ── ext_my_payments ──────────────────────────────────────────────────

function createExtMyPaymentsTool(): ToolDefinition {
  return {
    name: 'ext_my_payments',
    description: '查询与您相关的付款/收款记录。',
    parameters: {
      date_from: { type: 'string', description: '开始日期 YYYY-MM-DD（可选）' },
      date_to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { bizCtx, ext } = ec
      const rows = getPayments(bizCtx, {
        counterpartyId: ext.counterpartyId,
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
      })
      if (rows.length === 0) {
        const result = '暂无与您相关的付款记录'
        logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_payments', outputText: result })
        return result
      }
      const dirLabel = (d: string) => d === 'in' ? '收款' : '付款'
      const result = `与${ext.counterpartyName}相关的付款记录（共${rows.length}条）：\n\n` +
        mdTable(['日期', '方向', '金额', '方式', '状态'], rows.map(r => [
          r.date, dirLabel(r.direction), fmt(r.amount), r.method ?? '-',
          STATUS_MAP[r.docStatus ?? ''] ?? r.docStatus ?? '-',
        ]))
      logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_payments', outputText: result })
      return result
    },
  }
}

// ── ext_my_logistics ─────────────────────────────────────────────────

function createExtMyLogisticsTool(): ToolDefinition {
  return {
    name: 'ext_my_logistics',
    description: '查询与您相关的物流/运输记录。',
    parameters: {
      date_from: { type: 'string', description: '开始日期 YYYY-MM-DD（可选）' },
      date_to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { bizCtx, ext } = ec
      const rows = getLogistics(bizCtx, {
        counterpartyId: ext.counterpartyId,
        dateFrom: args.date_from as string | undefined,
        dateTo: args.date_to as string | undefined,
      })
      if (rows.length === 0) {
        const result = '暂无与您相关的物流记录'
        logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_logistics', outputText: result })
        return result
      }
      const result = `与${ext.counterpartyName}相关的物流记录（共${rows.length}条）：\n\n` +
        mdTable(['日期', '目的地', '吨位', '运单号', '状态'], rows.map(r => [
          r.date, r.destination ?? '-', fmt(r.tonnage), r.waybillNo ?? '-',
          STATUS_MAP[r.docStatus ?? ''] ?? r.docStatus ?? '-',
        ]))
      logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_logistics', outputText: result })
      return result
    },
  }
}

// ── ext_price_inquiry ────────────────────────────────────────────────

function createExtPriceInquiryTool(): ToolDefinition {
  return {
    name: 'ext_price_inquiry',
    description: '向华瑞隆提交询价请求。请说明品名、规格和需要的数量。',
    parameters: {
      product: { type: 'string', description: '品名（如 HRB400E 螺纹钢）', required: true },
      spec: { type: 'string', description: '规格（如 Φ25）' },
      quantity: { type: 'string', description: '需求数量（如 50吨）' },
      notes: { type: 'string', description: '其他说明' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { ext } = ec
      const detail = `品名: ${args.product || '-'}, 规格: ${args.spec || '-'}, 数量: ${args.quantity || '-'}, 备注: ${args.notes || '-'}`
      const result = `已收到您的询价请求，华瑞隆会尽快回复。\n\n询价详情：${detail}`
      logExternalAction({
        counterpartyId: ext.counterpartyId,
        action: 'price_inquiry',
        inputText: detail,
        outputText: result,
      })
      return result
    },
  }
}

// ── ext_confirm_receipt ──────────────────────────────────────────────

function createExtConfirmReceiptTool(): ToolDefinition {
  return {
    name: 'ext_confirm_receipt',
    description: '确认收货/到货。请说明相关订单的日期或品名。',
    parameters: {
      date: { type: 'string', description: '订单日期 YYYY-MM-DD' },
      product: { type: 'string', description: '品名（可选）' },
      notes: { type: 'string', description: '确认说明' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { ext } = ec
      if (ext.permissionLevel !== 'query_confirm') {
        return '您当前没有确认权限，如需开通请联系华瑞隆业务员。'
      }
      const detail = `日期: ${args.date || '-'}, 品名: ${args.product || '-'}, 说明: ${args.notes || '-'}`
      const result = `已记录您的收货确认，华瑞隆会同步更新。\n\n确认详情：${detail}`
      logExternalAction({
        counterpartyId: ext.counterpartyId,
        action: 'confirm_receipt',
        inputText: detail,
        outputText: result,
      })
      return result
    },
  }
}

// ── ext_payment_status ───────────────────────────────────────────────

function createExtPaymentStatusTool(): ToolDefinition {
  return {
    name: 'ext_payment_status',
    description: '查询您与华瑞隆之间的对账单和款项往来汇总。',
    parameters: {
      date_from: { type: 'string', description: '开始日期 YYYY-MM-DD（可选）' },
      date_to: { type: 'string', description: '结束日期 YYYY-MM-DD（可选）' },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { bizCtx, ext } = ec
      try {
        const stmt = getCounterpartyStatement(bizCtx, ext.counterpartyId,
          args.date_from as string | undefined,
          args.date_to as string | undefined,
        )
        if (!stmt || stmt.rows.length === 0) {
          const result = '暂无与您相关的对账记录'
          logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_statement', outputText: result })
          return result
        }
        const stmtRows = stmt.rows.slice(0, 30)
        const result = `${ext.counterpartyName}对账单（共${stmt.rows.length}条）：\n\n` +
          mdTable(['日期', '类型', '摘要', '借方', '贷方', '余额'], stmtRows.map(r => [
            r.date, r.type, r.description, fmt(r.debit), fmt(r.credit), fmt(r.balance),
          ])) +
          `\n\n期末余额: ${fmt(stmt.closingBalance)}`
        logExternalAction({ counterpartyId: ext.counterpartyId, action: 'query_statement', outputText: result })
        return result
      } catch {
        return '对账单查询暂不可用，请稍后再试。'
      }
    },
  }
}

// ── Role switching tool ───────────────────────────────────────────────

function createExtSwitchRoleTool(): ToolDefinition {
  return {
    name: 'ext_switch_role',
    description: '切换到其他合作公司的身份查询数据。当用户说"切换到XX"、"我想看XX的数据"时使用。',
    parameters: {
      company_name: { type: 'string', description: '目标公司名称', required: true },
    },
    execute: async (args, ctx) => {
      const ec = toExtCtx(ctx)
      if (!ec) return '身份验证失败'
      const { ext } = ec
      const targetName = (args.company_name as string)?.trim()
      if (!targetName) return '请提供目标公司名称'

      // List all bindings for this user
      const bindings = listUserBindings(ext.platform, ext.platformUserId)
      if (bindings.length <= 1) {
        return `您当前仅绑定了「${ext.counterpartyName}」，没有其他可切换的公司。`
      }

      // Find target by name (fuzzy match)
      const target = bindings.find(b =>
        b.counterpartyName === targetName || b.counterpartyName.includes(targetName) || targetName.includes(b.counterpartyName),
      )
      if (!target) {
        const names = bindings.map(b => `${b.counterpartyName}${b.isActive ? ' [当前]' : ''}`).join('、')
        return `未找到「${targetName}」。您可以切换到：${names}`
      }

      if (target.counterpartyId === ext.counterpartyId) {
        return `您当前已经在「${target.counterpartyName}」的身份下。`
      }

      const ok = switchActiveBinding(ext.platform, ext.platformUserId, target.counterpartyId)
      if (!ok) return '切换失败，请稍后重试。'

      clearIdentityCache()

      logExternalAction({
        counterpartyId: target.counterpartyId,
        action: 'switch_role',
        inputText: `from ${ext.counterpartyName} to ${target.counterpartyName}`,
      })

      const names = bindings.map(b =>
        `${b.counterpartyName}${b.counterpartyId === target.counterpartyId ? ' [当前]' : ''}`,
      ).join('、')
      return `已切换到「${target.counterpartyName}」，您可以开始查询了。\n可切换的公司：${names}`
    },
  }
}

// ── Export ────────────────────────────────────────────────────────────

export const EXT_TOOL_NAMES = [
  'ext_my_orders', 'ext_my_payments', 'ext_my_logistics',
  'ext_price_inquiry', 'ext_confirm_receipt', 'ext_payment_status',
  'ext_switch_role',
]

export function createExtQueryTools(): ToolDefinition[] {
  return [
    createExtMyOrdersTool(),
    createExtMyPaymentsTool(),
    createExtMyLogisticsTool(),
    createExtPriceInquiryTool(),
    createExtConfirmReceiptTool(),
    createExtPaymentStatusTool(),
    createExtSwitchRoleTool(),
  ]
}
