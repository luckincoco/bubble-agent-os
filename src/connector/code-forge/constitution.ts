/**
 * Bubble CodeForge Constitution — 编码宪章
 *
 * 定义 Bubble 自编码系统的不可违反原则、领域上下文和反模式。
 * 灵感来源：GitHub spec-kit 的 constitution-template.md
 *
 * 管理员可通过 generated/constitution.json 覆写非安全类原则。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { logger } from '../../shared/logger.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ConstitutionPrinciple {
  name: string
  description: string
  nonNegotiable: boolean
}

export interface BubbleConstitution {
  version: number
  principles: ConstitutionPrinciple[]
  securityRules: string[]
  domainContext: string
  antiPatterns: string[]
  availableMethods: string[]
}

// ── Default Constitution ─────────────────────────────────────────────

const DEFAULT_CONSTITUTION: BubbleConstitution = {
  version: 1,
  principles: [
    {
      name: 'Query-Only',
      description: '生成的工具只能读取数据，禁止任何写操作（create/update/delete）。这是安全底线。',
      nonNegotiable: true,
    },
    {
      name: 'Security-First',
      description: '禁止 fs、child_process、net、http、fetch、eval、Function 构造器。禁止任何网络和文件系统访问。',
      nonNegotiable: true,
    },
    {
      name: 'Test-First',
      description: '每个工具必须同时生成 vitest 测试代码，mock structured-store 方法，验证输出格式。',
      nonNegotiable: true,
    },
    {
      name: 'Library-First',
      description: '复用 structured-store.js 的 get*/find* 方法获取数据，不重新实现数据访问逻辑。',
      nonNegotiable: false,
    },
    {
      name: 'Simplicity',
      description: '单文件、函数式风格、50-150 行。不使用 class 抽象，不引入不必要的泛型或设计模式。',
      nonNegotiable: false,
    },
    {
      name: 'Domain-Aware',
      description: '工具服务于钢贸业务场景（采购/销售/物流/付款/发票），使用业务术语命名，考虑实际使用场景。',
      nonNegotiable: false,
    },
    {
      name: 'Sensitive-Data-Protection',
      description: '敏感字段（costPrice、costAmount、profit、exposure、敞口、成本价、毛利）不得出现在工具输出中。',
      nonNegotiable: true,
    },
  ],

  securityRules: [
    '只能 import：registry.js 的类型、types.js 的类型、structured-store.js 的 get*/find* 方法',
    '禁止：fs、child_process、net、http、https、fetch、eval、new Function',
    '禁止：任何写操作（create*、update*、delete*）',
    '禁止：process.exit、process.kill、globalThis、WebSocket、XMLHttpRequest',
    '敏感字段不得出现在返回值中',
    'execute 必须是 async 函数，必须返回 string',
  ],

  domainContext: `Bubble Agent OS 是一个钢贸行业的智能助手。生成的工具用于帮助用户查询和分析业务数据。
核心业务实体：采购单(Purchase)、销售单(Sale)、物流单(Logistics)、付款单(Payment)、发票(Invoice)、客户/供应商(Counterparty)、产品(Product)。
用户通常是钢贸公司老板或业务员，关注：今日采购量、客户欠款、物流状态、价格变动等。`,

  antiPatterns: [
    '不要生成通用的 CRUD 工具 — 只做查询',
    '不要使用 any 类型 — 使用具体类型',
    '不要在 execute 函数内定义复杂类型 — 保持简洁',
    '不要硬编码 spaceId — 从 ctx.activeSpaceId 获取',
    '不要返回原始 JSON — 格式化为人可读的中文文本',
    '不要一次返回超过 50 条记录 — 做分页或 top-N',
  ],

  availableMethods: [
    'getPurchases(ctx, filters?) → Purchase[]',
    'getSales(ctx, filters?) → Sale[]',
    'getLogistics(ctx, filters?) → Logistics[]',
    'getPayments(ctx, filters?) → Payment[]',
    'getCounterparties(ctx, filters?) → Counterparty[]',
    'getProducts(ctx) → Product[]',
    'findPurchaseById(ctx, id) → Purchase | null',
    'findSaleById(ctx, id) → Sale | null',
    'findCounterpartyByName(ctx, name) → Counterparty | null',
    'getInvoices(ctx, filters?) → Invoice[]',
  ],
}

// ── Loader ───────────────────────────────────────────────────────────

let cachedConstitution: BubbleConstitution | null = null

/**
 * Load the constitution, merging defaults with optional user overrides.
 * User overrides can only modify non-negotiable=false principles and add new ones.
 */
export function loadConstitution(projectRoot?: string): BubbleConstitution {
  if (cachedConstitution) return cachedConstitution

  const constitution = { ...DEFAULT_CONSTITUTION }

  // Try to load user overrides
  if (projectRoot) {
    const overridePath = resolve(projectRoot, 'src/connector/tools/generated/constitution.json')
    if (existsSync(overridePath)) {
      try {
        const raw = readFileSync(overridePath, 'utf8')
        const overrides = JSON.parse(raw)

        // Merge principles: user can add or override non-negotiable=false principles
        if (Array.isArray(overrides.principles)) {
          for (const userP of overrides.principles) {
            const existing = constitution.principles.find(p => p.name === userP.name)
            if (existing && !existing.nonNegotiable) {
              existing.description = userP.description || existing.description
            } else if (!existing) {
              constitution.principles.push({
                name: userP.name,
                description: userP.description || '',
                nonNegotiable: false,
              })
            }
            // nonNegotiable principles cannot be overridden
          }
        }

        // Merge domain context (append)
        if (overrides.domainContext) {
          constitution.domainContext += '\n' + overrides.domainContext
        }

        // Merge anti-patterns (append)
        if (Array.isArray(overrides.antiPatterns)) {
          constitution.antiPatterns.push(...overrides.antiPatterns)
        }

        // Merge available methods (append)
        if (Array.isArray(overrides.availableMethods)) {
          constitution.availableMethods.push(...overrides.availableMethods)
        }

        logger.info('[Constitution] User overrides loaded')
      } catch (err) {
        logger.debug('[Constitution] Failed to load overrides:', err instanceof Error ? err.message : String(err))
      }
    }
  }

  cachedConstitution = constitution
  return constitution
}

/**
 * Format constitution for injection into a specific phase's prompt.
 * Only includes relevant sections to minimize token usage.
 */
export function formatForPhase(constitution: BubbleConstitution, phase: 'specify' | 'plan' | 'tasks' | 'implement'): string {
  switch (phase) {
    case 'specify':
      return [
        '## 项目宪章（领域上下文）',
        constitution.domainContext,
        '',
        '## 编码原则',
        ...constitution.principles.map(p => `- **${p.name}**${p.nonNegotiable ? ' [不可违反]' : ''}: ${p.description}`),
      ].join('\n')

    case 'plan':
      return [
        '## 可用数据方法',
        ...constitution.availableMethods.map(m => `- ${m}`),
        '',
        '## 反模式（避免）',
        ...constitution.antiPatterns.map(a => `- ${a}`),
      ].join('\n')

    case 'tasks':
      return [
        '## 原则提醒',
        ...constitution.principles.filter(p => p.nonNegotiable).map(p => `- ${p.name}: ${p.description}`),
      ].join('\n')

    case 'implement':
      return [
        '## 安全约束（不可违反）',
        ...constitution.securityRules.map((r, i) => `${i + 1}. ${r}`),
        '',
        '## 反模式',
        ...constitution.antiPatterns.map(a => `- ${a}`),
      ].join('\n')
  }
}

/** Reset cached constitution (for testing) */
export function resetConstitutionCache(): void {
  cachedConstitution = null
}
