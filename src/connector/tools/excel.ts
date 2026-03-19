import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import * as XLSX from 'xlsx'
import type { ToolDefinition } from '../registry.js'
import type { UserContext } from '../../shared/types.js'
import { getDatabase, buildInClause } from '../../storage/database.js'
import { updateBubble, deleteBubble } from '../../bubble/model.js'

// Shared exports directory
export const EXPORTS_DIR = resolve(tmpdir(), 'bubble-exports')
if (!existsSync(EXPORTS_DIR)) {
  mkdirSync(EXPORTS_DIR, { recursive: true })
}

// --- Helpers ---

function getExcelSummaries(spaceIds?: string[]) {
  const db = getDatabase()
  let sql = "SELECT * FROM bubbles WHERE tags LIKE '%excel-summary%'"
  const params: unknown[] = []
  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }
  sql += ' ORDER BY created_at DESC'
  return db.prepare(sql).all(...params) as any[]
}

function getExcelRows(sheetName: string, spaceIds?: string[], keyword?: string, limit = 50) {
  const db = getDatabase()
  let sql = "SELECT * FROM bubbles WHERE tags LIKE '%excel-row%' AND tags LIKE ?"
  const params: unknown[] = [`%${sheetName}%`]
  if (keyword) {
    sql += ' AND (content LIKE ? OR title LIKE ?)'
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (spaceIds?.length) {
    const { placeholders, params: sp } = buildInClause(spaceIds)
    sql += ` AND space_id IN (${placeholders})`
    params.push(...sp)
  }
  sql += ' ORDER BY created_at ASC LIMIT ?'
  params.push(limit)
  return db.prepare(sql).all(...params) as any[]
}

// --- Tool 1: query_excel ---

export function createQueryExcelTool(): ToolDefinition {
  return {
    name: 'query_excel',
    description: '查询已导入的Excel数据。不填sheet则列出所有表；填sheet查看该表数据；加keyword搜索特定内容',
    parameters: {
      sheet: { type: 'string', description: '工作表名称', required: false },
      keyword: { type: 'string', description: '搜索关键词', required: false },
      limit: { type: 'string', description: '最多返回行数（默认20）', required: false },
    },
    async execute(args, ctx?) {
      const sheet = args.sheet as string | undefined
      const keyword = args.keyword as string | undefined
      const limit = parseInt(args.limit as string || '20')
      const spaceIds = ctx?.spaceIds

      if (!sheet) {
        const summaries = getExcelSummaries(spaceIds)
        if (summaries.length === 0) return '当前没有已导入的Excel数据。'
        const lines = summaries.map((s: any) => {
          const meta = JSON.parse(s.metadata || '{}')
          return `- ${s.title}（${meta.rowCount || '?'}行，列: ${(meta.columns || []).join(', ')}）`
        })
        return `已导入的Excel表格：\n${lines.join('\n')}`
      }

      const summaries = getExcelSummaries(spaceIds)
      const summary = summaries.find((s: any) => {
        const tags = JSON.parse(s.tags || '[]')
        return tags.includes(sheet) || s.title.includes(sheet)
      })
      if (!summary) return `未找到名为"${sheet}"的工作表。`

      if (keyword) {
        const rows = getExcelRows(sheet, spaceIds, keyword, limit)
        if (rows.length === 0) return `在"${sheet}"中未找到包含"${keyword}"的数据。`
        const results = rows.map((r: any) => r.content).join('\n---\n')
        return `在"${sheet}"中找到${rows.length}条匹配"${keyword}"的数据：\n${results}`
      }

      const content = summary.content as string
      if (content.length > 4000) {
        return content.substring(0, 4000) + '\n...(数据过多已截断，可用keyword参数搜索特定内容)'
      }
      return content
    },
  }
}

// --- Tool 2: export_excel ---

export function createExportExcelTool(): ToolDefinition {
  return {
    name: 'export_excel',
    description: '将指定工作表数据导出为Excel文件供用户下载',
    parameters: {
      sheet: { type: 'string', description: '要导出的工作表名', required: true },
      keyword: { type: 'string', description: '筛选关键词（可选）', required: false },
      filename: { type: 'string', description: '导出文件名（可选）', required: false },
    },
    async execute(args, ctx?) {
      const sheet = args.sheet as string
      const keyword = args.keyword as string | undefined
      const filename = (args.filename as string) || `${sheet}_${Date.now()}.xlsx`
      const spaceIds = ctx?.spaceIds

      if (!sheet) return 'Error: 请指定要导出的工作表名'

      const rows = getExcelRows(sheet, spaceIds, keyword, 10000)
      if (rows.length === 0) return `"${sheet}"中没有找到数据。`

      const data: Record<string, unknown>[] = rows.map((r: any) => JSON.parse(r.metadata || '{}'))

      const ws = XLSX.utils.json_to_sheet(data)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, sheet.substring(0, 31))

      const safeName = filename.replace(/[^a-zA-Z0-9_\u4e00-\u9fff.\-]/g, '_')
      const filePath = resolve(EXPORTS_DIR, safeName)
      XLSX.writeFile(wb, filePath)

      return `Excel文件已生成，共${rows.length}行数据。下载链接: /api/exports/${encodeURIComponent(safeName)}`
    },
  }
}

// --- Tool 3: clean_excel ---

export function createCleanExcelTool(): ToolDefinition {
  return {
    name: 'clean_excel',
    description: '清洗Excel数据。支持: dedup(去重)、fill(填充缺失值)、trim(去空白)、normalize(统一格式)',
    parameters: {
      sheet: { type: 'string', description: '工作表名', required: true },
      operation: { type: 'string', description: '操作: dedup | fill | trim | normalize', required: true },
      column: { type: 'string', description: '指定列名（可选，不填则全列操作）', required: false },
      fill_value: { type: 'string', description: '填充值（fill操作时使用）', required: false },
    },
    async execute(args, ctx?) {
      const sheet = args.sheet as string
      const operation = args.operation as string
      const column = args.column as string | undefined
      const fillValue = (args.fill_value as string) || ''
      const spaceIds = ctx?.spaceIds

      if (!sheet) return 'Error: 请指定工作表名'
      if (!operation) return 'Error: 请指定操作类型'

      const rows = getExcelRows(sheet, spaceIds, undefined, 10000)
      if (rows.length === 0) return `"${sheet}"中没有找到数据。`

      let affected = 0

      switch (operation) {
        case 'dedup': {
          const seen = new Set<string>()
          const duplicateIds: string[] = []
          for (const row of rows) {
            const key = column
              ? String(JSON.parse(row.metadata || '{}')[column] ?? '')
              : row.content
            if (seen.has(key)) {
              duplicateIds.push(row.id)
            } else {
              seen.add(key)
            }
          }
          for (const id of duplicateIds) {
            deleteBubble(id)
            affected++
          }
          return `去重完成：在"${sheet}"中删除了${affected}条重复数据${column ? `（按"${column}"列判断）` : ''}。`
        }

        case 'fill': {
          for (const row of rows) {
            const meta = JSON.parse(row.metadata || '{}')
            let changed = false
            const targetCols = column ? [column] : Object.keys(meta)
            for (const col of targetCols) {
              if (meta[col] == null || meta[col] === '') {
                meta[col] = fillValue
                changed = true
              }
            }
            if (changed) {
              const contentParts = Object.entries(meta)
                .filter(([, v]) => v != null && v !== '')
                .map(([k, v]) => `${k}: ${v}`)
              updateBubble(row.id, { metadata: meta, content: contentParts.join('\n') })
              affected++
            }
          }
          return `填充完成：在"${sheet}"中填充了${affected}条缺失值${column ? `（"${column}"列）` : ''}，填充值: "${fillValue}"。`
        }

        case 'trim': {
          for (const row of rows) {
            const meta = JSON.parse(row.metadata || '{}')
            let changed = false
            const targetCols = column ? [column] : Object.keys(meta)
            for (const col of targetCols) {
              if (typeof meta[col] === 'string') {
                const trimmed = meta[col].trim()
                if (trimmed !== meta[col]) {
                  meta[col] = trimmed
                  changed = true
                }
              }
            }
            if (changed) {
              const contentParts = Object.entries(meta)
                .filter(([, v]) => v != null && v !== '')
                .map(([k, v]) => `${k}: ${v}`)
              updateBubble(row.id, { metadata: meta, content: contentParts.join('\n') })
              affected++
            }
          }
          return `去空白完成：在"${sheet}"中清理了${affected}条数据${column ? `（"${column}"列）` : ''}。`
        }

        case 'normalize': {
          for (const row of rows) {
            const meta = JSON.parse(row.metadata || '{}')
            let changed = false
            const targetCols = column ? [column] : Object.keys(meta)
            for (const col of targetCols) {
              const val = meta[col]
              if (typeof val === 'string') {
                const normalized = val.trim().replace(/\s+/g, ' ')
                if (normalized !== val) {
                  meta[col] = normalized
                  changed = true
                }
              } else if (typeof val === 'number') {
                const rounded = Math.round(val * 100) / 100
                if (rounded !== val) {
                  meta[col] = rounded
                  changed = true
                }
              }
            }
            if (changed) {
              const contentParts = Object.entries(meta)
                .filter(([, v]) => v != null && v !== '')
                .map(([k, v]) => `${k}: ${v}`)
              updateBubble(row.id, { metadata: meta, content: contentParts.join('\n') })
              affected++
            }
          }
          return `格式统一完成：在"${sheet}"中规范了${affected}条数据${column ? `（"${column}"列）` : ''}。`
        }

        default:
          return `未知操作: "${operation}"。支持: dedup, fill, trim, normalize`
      }
    },
  }
}

// --- Tool 4: cross_analyze ---

export function createCrossAnalyzeTool(): ToolDefinition {
  return {
    name: 'cross_analyze',
    description: '关联分析多个Excel表，发现共同字段并做交叉对比',
    parameters: {
      sheets: { type: 'string', description: '工作表名，逗号分隔（如：订单表,客户表）', required: true },
      key_column: { type: 'string', description: '关联列名（可选，不填则自动查找共同列）', required: false },
    },
    async execute(args, ctx?) {
      const sheetsStr = args.sheets as string
      const keyColumn = args.key_column as string | undefined
      const spaceIds = ctx?.spaceIds

      if (!sheetsStr) return 'Error: 请指定要关联的工作表名（用逗号分隔）'

      const sheetNames = sheetsStr.split(/[,，]/).map(s => s.trim()).filter(Boolean)
      if (sheetNames.length < 2) return 'Error: 请至少指定两个工作表'

      const allSummaries = getExcelSummaries(spaceIds)
      const sheetData: Array<{ name: string; columns: string[]; rowCount: number; rows: Record<string, unknown>[] }> = []

      for (const name of sheetNames) {
        const summary = allSummaries.find((s: any) => {
          const tags = JSON.parse(s.tags || '[]')
          return tags.includes(name) || s.title.includes(name)
        })
        if (!summary) return `未找到名为"${name}"的工作表。`

        const meta = JSON.parse(summary.metadata || '{}')
        const rows = getExcelRows(name, spaceIds, undefined, 10000)
        const parsedRows = rows.map((r: any) => JSON.parse(r.metadata || '{}'))

        sheetData.push({
          name,
          columns: meta.columns || [],
          rowCount: meta.rowCount || parsedRows.length,
          rows: parsedRows,
        })
      }

      // Find common columns
      const allColumnSets = sheetData.map(s => new Set(s.columns))
      const commonColumns = [...allColumnSets[0]].filter(col =>
        allColumnSets.every(set => set.has(col))
      )

      const result: string[] = []
      result.push(`关联分析：${sheetNames.join(' x ')}`)
      result.push(`共同列: ${commonColumns.length > 0 ? commonColumns.join(', ') : '无'}`)
      result.push('')

      for (const sd of sheetData) {
        result.push(`${sd.name}: ${sd.rowCount}行, ${sd.columns.length}列 [${sd.columns.join(', ')}]`)
      }
      result.push('')

      const joinCol = keyColumn || commonColumns[0]
      if (!joinCol) {
        result.push('两个表没有共同列名，无法自动关联。请指定 key_column 参数。')
        return result.join('\n')
      }

      result.push(`关联列: "${joinCol}"`)

      const sheet1 = sheetData[0]
      const sheet2 = sheetData[1]

      const map1 = new Map<string, Record<string, unknown>[]>()
      for (const row of sheet1.rows) {
        const key = String(row[joinCol] ?? '')
        if (!map1.has(key)) map1.set(key, [])
        map1.get(key)!.push(row)
      }

      const map2 = new Map<string, Record<string, unknown>[]>()
      for (const row of sheet2.rows) {
        const key = String(row[joinCol] ?? '')
        if (!map2.has(key)) map2.set(key, [])
        map2.get(key)!.push(row)
      }

      const keys1 = new Set(map1.keys())
      const keys2 = new Set(map2.keys())
      const matched = [...keys1].filter(k => keys2.has(k))
      const onlyIn1 = [...keys1].filter(k => !keys2.has(k))
      const onlyIn2 = [...keys2].filter(k => !keys1.has(k))

      result.push(`匹配: ${matched.length}个共同值`)
      result.push(`仅在"${sheet1.name}": ${onlyIn1.length}个`)
      result.push(`仅在"${sheet2.name}": ${onlyIn2.length}个`)
      result.push('')

      if (matched.length > 0) {
        const sample = matched.slice(0, 5)
        result.push('匹配样本:')
        for (const key of sample) {
          result.push(`  ${joinCol}="${key}":`)
          const r1 = map1.get(key)![0]
          const r2 = map2.get(key)![0]
          const cols1 = sheet1.columns.filter(c => c !== joinCol).slice(0, 3)
          const cols2 = sheet2.columns.filter(c => c !== joinCol).slice(0, 3)
          result.push(`    ${sheet1.name}: ${cols1.map(c => `${c}=${r1[c]}`).join(', ')}`)
          result.push(`    ${sheet2.name}: ${cols2.map(c => `${c}=${r2[c]}`).join(', ')}`)
        }
      }

      if (onlyIn1.length > 0) {
        result.push(`\n仅在"${sheet1.name}"的样本: ${onlyIn1.slice(0, 5).join(', ')}`)
      }
      if (onlyIn2.length > 0) {
        result.push(`仅在"${sheet2.name}"的样本: ${onlyIn2.slice(0, 5).join(', ')}`)
      }

      const output = result.join('\n')
      if (output.length > 4000) {
        return output.substring(0, 4000) + '\n...(数据过多已截断)'
      }
      return output
    },
  }
}
