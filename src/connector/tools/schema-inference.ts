/**
 * LLM Schema Inference (inspired by CrewAI Knowledge Sources)
 *
 * Instead of hardcoded regex/column-name matching, let the LLM look at
 * each sheet's name + headers + sample rows and return:
 *   1. category  — what business type this sheet represents
 *   2. columnMap — mapping from actual column names to standard names
 *
 * The mapped rows are then fed into the existing translator / bridge
 * pipeline, which continues to work with its "standard" column names.
 */

import type { LLMProvider, LLMMessage } from '../../shared/types.js'
import type { SheetCategory } from './excel-translator.js'
import { detectSheetCategory } from './excel-translator.js'
import { logger } from '../../shared/logger.js'

// ── Public types ────────────────────────────────────────────────────

export interface SchemaInference {
  category: SheetCategory
  confidence: number
  columnMap: Record<string, string>   // actual column → standard column
}

// ── Standard column names (what the existing code expects) ──────────

const STANDARD_COLUMNS: Partial<Record<SheetCategory, string[]>> = {
  purchase: [
    '采购日期', '入库单号', '供应商', '品牌', '商品名称', '规格',
    '件数', '吨位', '单价(元/吨)', '金额(元)', '付款状态', '关联项目', '发票状态',
  ],
  sales: [
    '销售日期', '销售单号', '供应商', '客户/项目', '品牌', '商品名称', '规格',
    '件数', '吨位', '销售单价', '销售金额', '成本价(自动)', '单笔毛利', '物流商',
  ],
  logistics: [
    '装车日期', '运单号', '托运公司', '目的地/项目', '车牌号', '司机',
    '吨位', '运费(元)', '吊费(元)', '费用合计', '结算状态',
  ],
  payment: [
    '日期', '单据号', '类型', '对象(客户/供应商)', '关联项目',
    '金额(元)', '方式', '摘要',
  ],
  inventory: [
    '品名', '规格', '件数', '吨位', '供应商', '单价', '金额',
  ],
  receivable: [
    '客户', '项目', '销售额', '已回款', '未回款',
  ],
  payable: [
    '供应商', '采购额', '已付', '未付',
  ],
  product_info: [
    '商品代码', '品牌', '商品名称', '规格', '规格(调整格式)',
    '计量方式', '件重(吨)', '支数', '吊费(元/吨)', '类型',
  ],
  supplier_info: [
    '供应商名称', '经销品牌', '提货地址', '联系人', '联系电话',
    '已付金额', '未付余款',
  ],
  customer_info: [
    '项目名称', '合同编号', '工程地址', '施工单位', '建设单位',
    '联系人', '电话', '项目状态', '累计销售额', '已回款', '未回款余额',
  ],
  logistics_info: [
    '托运公司', '常送目的地', '车牌号', '司机', '司机电话',
  ],
  summary: [
    '月份', '采购额', '销售额', '毛利', '毛利率', '运费', '净利润',
  ],
  dashboard: [
    '指标', '数值', '说明',
  ],
}

const VALID_CATEGORIES: SheetCategory[] = [
  'purchase', 'sales', 'logistics', 'payment', 'inventory',
  'receivable', 'payable', 'product_info', 'supplier_info',
  'customer_info', 'logistics_info', 'summary', 'dashboard', 'unknown',
]

// ── Cache (headers hash → result) ───────────────────────────────────

const inferenceCache = new Map<string, SchemaInference>()

function cacheKey(sheetName: string, headers: string[]): string {
  return `${sheetName}|${headers.join('\t')}`
}

// ── LLM prompt ──────────────────────────────────────────────────────

function buildPrompt(
  sheetName: string,
  headers: string[],
  sampleRows: Record<string, unknown>[],
): string {
  const categoryDesc = Object.entries(STANDARD_COLUMNS)
    .map(([cat, cols]) => `  ${cat}: [${cols!.join(', ')}]`)
    .join('\n')

  const samples = sampleRows.slice(0, 3).map((row, i) => {
    const entries = Object.entries(row)
      .filter(([, v]) => v != null && v !== '')
      .slice(0, 12)
      .map(([k, v]) => `${k}=${v}`)
    return `  行${i + 1}: ${entries.join(' | ')}`
  }).join('\n')

  return `分析这个Excel工作表，判断业务类别并映射列名。

工作表: "${sheetName}"
列名: [${headers.join(', ')}]
样本:
${samples}

已知类别及标准列名:
${categoryDesc}

返回JSON(不要代码块):
{"category":"类别","confidence":0.9,"columnMap":{"实际列名":"标准列名"}}

规则:
1. category必须是上面的类别之一，都不匹配用"unknown"
2. columnMap中：实际列名和标准列名一样也要包含；无法匹配的不包含
3. 同义映射示例: "钢厂"→"供应商", "重量"→"吨位", "采买日期"→"采购日期", "价格"→"单价(元/吨)"
4. 只返回JSON`
}

// ── Core inference function ─────────────────────────────────────────

export async function inferSheetSchema(
  llm: LLMProvider,
  sheetName: string,
  headers: string[],
  sampleRows: Record<string, unknown>[],
): Promise<SchemaInference | null> {
  const key = cacheKey(sheetName, headers)
  const cached = inferenceCache.get(key)
  if (cached) return cached

  try {
    const prompt = buildPrompt(sheetName, headers, sampleRows)
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }]

    const response = await llm.chat(messages)
    const text = response.content.trim()

    // Extract JSON (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      logger.warn(`SchemaInference: no JSON in LLM response for "${sheetName}"`)
      return null
    }

    const parsed = JSON.parse(jsonMatch[0]) as SchemaInference

    if (!parsed.category || typeof parsed.columnMap !== 'object') {
      logger.warn(`SchemaInference: invalid structure for "${sheetName}"`)
      return null
    }

    if (!VALID_CATEGORIES.includes(parsed.category)) {
      parsed.category = 'unknown'
    }

    inferenceCache.set(key, parsed)

    const mappedCount = Object.keys(parsed.columnMap).length
    logger.info(
      `SchemaInference: "${sheetName}" → ${parsed.category} (${(parsed.confidence * 100).toFixed(0)}%), ${mappedCount} columns mapped`,
    )

    return parsed
  } catch (err) {
    logger.warn(
      `SchemaInference: failed for "${sheetName}": ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

// ── Batch pre-inference (parallel, all sheets at once) ──────────────

export interface SheetPreview {
  sheetName: string
  headers: string[]
  sampleRows: Record<string, unknown>[]
}

export async function inferAllSheets(
  llm: LLMProvider,
  sheets: SheetPreview[],
): Promise<Map<string, SchemaInference>> {
  const results = new Map<string, SchemaInference>()

  const promises = sheets.map(async ({ sheetName, headers, sampleRows }) => {
    const inference = await inferSheetSchema(llm, sheetName, headers, sampleRows)
    if (inference) {
      results.set(sheetName, inference)
    }
  })

  await Promise.all(promises)
  return results
}

// ── Apply column mapping to rows ────────────────────────────────────

/**
 * Add standard column names as aliases in each row.
 * Original columns are preserved; standard names are added alongside.
 * This way the existing `col(row, '标准名')` calls will find the data.
 */
export function applyColumnMap(
  rows: Record<string, unknown>[],
  columnMap: Record<string, string>,
): Record<string, unknown>[] {
  const entries = Object.entries(columnMap).filter(([orig, std]) => orig !== std)
  if (!entries.length) return rows

  return rows.map(row => {
    const mapped: Record<string, unknown> = { ...row }
    for (const [originalName, standardName] of entries) {
      if (row[originalName] != null && row[originalName] !== '') {
        mapped[standardName] = row[originalName]
      }
    }
    return mapped
  })
}

// ── Resolve category: LLM inference → fallback to regex ─────────────

export function resolveCategory(
  sheetName: string,
  inference: SchemaInference | undefined,
): SheetCategory {
  if (inference && inference.confidence >= 0.5 && inference.category !== 'unknown') {
    return inference.category
  }
  // Fallback: original regex-based detection
  return detectSheetCategory(sheetName)
}

// ── Fuzzy column resolver (P2a fallback) ────────────────────────────

/** Levenshtein distance for short strings */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost)
    }
  }
  return dp[m]![n]!
}

/** Common synonyms for steel trade column names */
const COLUMN_SYNONYMS: Record<string, string[]> = {
  '采购日期': ['采买日期', '进货日期', '入库日期', '日期'],
  '供应商': ['钢厂', '厂家', '供货商', '卖方'],
  '吨位': ['重量', '吨数', '净重', '数量(吨)'],
  '单价(元/吨)': ['单价', '价格', '吨价', '采购单价'],
  '金额(元)': ['金额', '总额', '货款', '采购金额'],
  '品牌': ['钢厂品牌', '品名', '牌号'],
  '商品名称': ['品名', '材料名称', '货物名称', '钢材名称'],
  '规格': ['规格型号', '型号', '尺寸'],
  '销售日期': ['出库日期', '送货日期'],
  '销售单价': ['售价', '销售价', '卖价'],
  '销售金额': ['销售额', '销售总额', '出库金额'],
  '客户/项目': ['客户', '项目', '客户名称', '项目名称', '买方'],
  '托运公司': ['物流公司', '运输公司', '承运商'],
  '运费(元)': ['运费', '运输费'],
  '对象(客户/供应商)': ['对象', '往来单位', '付款对象', '收款对象'],
}

/**
 * Fuzzy-match actual column headers to standard column names when LLM inference fails.
 * Returns a columnMap or null if matching quality is too low.
 */
export function fuzzyMatchColumns(
  headers: string[],
  category: SheetCategory,
): Record<string, string> | null {
  const standard = STANDARD_COLUMNS[category]
  if (!standard) return null

  const columnMap: Record<string, string> = {}
  let matched = 0

  for (const header of headers) {
    const h = header.trim()
    if (!h) continue

    // 1. Exact match
    if (standard.includes(h)) {
      columnMap[h] = h
      matched++
      continue
    }

    // 2. Synonym match
    let found = false
    for (const [stdName, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
      if (standard.includes(stdName) && synonyms.some(s => s === h || h.includes(s) || s.includes(h))) {
        columnMap[h] = stdName
        matched++
        found = true
        break
      }
    }
    if (found) continue

    // 3. Levenshtein distance match (threshold: <= 2 edits for short names)
    let bestStd = ''
    let bestDist = Infinity
    for (const std of standard) {
      const dist = levenshtein(h, std)
      if (dist < bestDist) {
        bestDist = dist
        bestStd = std
      }
    }
    const threshold = Math.max(2, Math.floor(h.length * 0.4))
    if (bestDist <= threshold && bestStd) {
      columnMap[h] = bestStd
      matched++
    }
  }

  // Require at least 30% of standard columns matched to accept
  if (matched < standard.length * 0.3) return null

  logger.info(`FuzzyColumnMatch: ${category} → ${matched}/${standard.length} columns matched`)
  return columnMap
}
