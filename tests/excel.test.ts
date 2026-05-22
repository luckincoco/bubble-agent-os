import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

vi.mock('xlsx', () => ({
  utils: {
    json_to_sheet: vi.fn(() => ({})),
    book_new: vi.fn(() => ({ A: {} })),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}))

import {
  createQueryExcelTool,
  createExportExcelTool,
  createCleanExcelTool,
  createCrossAnalyzeTool,
} from '../src/connector/tools/excel.js'

let tmpDir: string

function insertSummary(id: string, title: string, sheetName: string, columns: string[], rowCount: number, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'summary', ?, ?, ?, ?, 'importer', 0.9, 0.1, 0, ?, ?, ?, ?, 0)
  `).run(
    id,
    title,
    overrides.content || `内容: ${sheetName}表`,
    JSON.stringify({ columns, rowCount }),
    JSON.stringify(['excel-summary', sheetName]),
    now, now, now,
    overrides.spaceId || null,
  )
}

function insertRow(id: string, sheetName: string, metadata: Record<string, unknown>, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const now = Date.now()
  const contentParts = Object.entries(metadata)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'excel-row', ?, ?, ?, ?, 'importer', 0.9, 0.1, 0, ?, ?, ?, ?, 0)
  `).run(
    id,
    `行: ${sheetName}`,
    contentParts.join('\n'),
    JSON.stringify(metadata),
    JSON.stringify(['excel-row', sheetName]),
    now, now, now,
    overrides.spaceId || null,
  )
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'excel-test-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubbles').run()
})

const mockCtx = { spaceIds: undefined }

// ── query_excel ───────────────────────────────────────────────

describe('query_excel', () => {
  const tool = createQueryExcelTool()

  it('lists all sheets when no sheet parameter', async () => {
    insertSummary('s1', '采购表', '采购单', ['供应商', '吨位'], 10)
    const result = await tool.execute({}, mockCtx as any)
    expect(result).toContain('采购表')
    expect(result).toContain('10行')
  })

  it('shows empty message when no excel data', async () => {
    const result = await tool.execute({}, mockCtx as any)
    expect(result).toContain('没有已导入的Excel数据')
  })

  it('shows sheet content when sheet parameter is provided', async () => {
    insertSummary('s2', '采购表', '采购单', ['供应商', '吨位'], 10, { content: '# 采购数据\n供应商: 宝钢, 吨位: 50' })
    const result = await tool.execute({ sheet: '采购单' }, mockCtx as any)
    expect(result).toContain('采购数据')
  })

  it('finds sheet by title when tags do not match', async () => {
    insertSummary('s3', '采购记录', '采购单', ['供应商'], 5, { content: '采购数据内容' })
    const result = await tool.execute({ sheet: '采购记录' }, mockCtx as any)
    expect(result).toContain('采购数据内容')
  })

  it('searches rows by keyword', async () => {
    insertSummary('s4', '采购表', '采购单', ['供应商'], 10, { content: '采购数据' })
    insertRow('r1', '采购单', { 供应商: '宝钢', 吨位: '50' })
    insertRow('r2', '采购单', { 供应商: '鞍钢', 吨位: '30' })

    const result = await tool.execute({ sheet: '采购单', keyword: '宝钢' }, mockCtx as any)
    expect(result).toContain('宝钢')
    expect(result).not.toContain('鞍钢')
  })

  it('truncates content over 4000 chars', async () => {
    insertSummary('s5', '长表', '长表', ['数据'], 1, { content: 'x'.repeat(5000) })
    const result = await tool.execute({ sheet: '长表' }, mockCtx as any)
    expect(result).toContain('已截断')
  })
})

// ── export_excel ──────────────────────────────────────────────

describe('export_excel', () => {
  const tool = createExportExcelTool()

  it('exports sheet data to xlsx', async () => {
    insertSummary('e1', '采购表', '采购单', ['供应商'], 2)
    insertRow('er1', '采购单', { 供应商: '宝钢' })
    insertRow('er2', '采购单', { 供应商: '鞍钢' })

    const result = await tool.execute({ sheet: '采购单' }, mockCtx as any)
    expect(result).toContain('已生成')
    expect(result).toContain('2行')
    expect(result).toContain('/api/exports/')
  })

  it('returns error when sheet is empty', async () => {
    const result = await tool.execute({ sheet: '' }, mockCtx as any)
    expect(result).toContain('请指定')
  })

  it('returns error when no data found', async () => {
    const result = await tool.execute({ sheet: '不存在' }, mockCtx as any)
    expect(result).toContain('没有找到数据')
  })
})

// ── clean_excel ───────────────────────────────────────────────

describe('clean_excel', () => {
  const tool = createCleanExcelTool()
  let dedupResult: string

  it('requires sheet name', async () => {
    const result = await tool.execute({ sheet: '', operation: 'dedup' }, mockCtx as any)
    expect(result).toContain('请指定工作表名')
  })

  it('requires operation type', async () => {
    const result = await tool.execute({ sheet: '采购单', operation: '' }, mockCtx as any)
    expect(result).toContain('请指定操作类型')
  })

  it('rejects unknown operation', async () => {
    insertSummary('unk1', '采购表', '采购单', ['供应商'], 1)
    insertRow('unkr1', '采购单', { 供应商: '宝钢' })
    const result = await tool.execute({ sheet: '采购单', operation: 'unknown_op' }, mockCtx as any)
    expect(result).toContain('未知操作')
  })

  it('dedup removes duplicate rows by content', async () => {
    insertSummary('d1', '采购表', '采购单', ['供应商'], 3)
    insertRow('dup1', '采购单', { 供应商: '宝钢' })
    insertRow('dup2', '采购单', { 供应商: '宝钢' }) // duplicate content
    insertRow('dup3', '采购单', { 供应商: '鞍钢' })

    const result = await tool.execute({ sheet: '采购单', operation: 'dedup' }, mockCtx as any)
    expect(result).toContain('删除了1条重复数据')

    // Verify via DB
    const db = getDatabase()
    const remaining = db.prepare("SELECT id FROM bubbles WHERE tags LIKE '%excel-row%'").all() as any[]
    expect(remaining).toHaveLength(2)
  })

  it('fill fills empty values in specified column', async () => {
    insertSummary('d2', '采购表', '采购单', ['供应商', '吨位'], 2)
    insertRow('fill1', '采购单', { 供应商: '宝钢', 吨位: '' })
    insertRow('fill2', '采购单', { 供应商: '鞍钢', 吨位: '50' })

    const result = await tool.execute({ sheet: '采购单', operation: 'fill', column: '吨位', fill_value: '0' }, mockCtx as any)
    expect(result).toContain('填充了1条')
  })

  it('trim removes whitespace', async () => {
    insertSummary('d3', '采购表', '采购单', ['供应商'], 2)
    insertRow('trim1', '采购单', { 供应商: ' 宝钢 ' })
    insertRow('trim2', '采购单', { 供应商: '鞍钢' })

    const result = await tool.execute({ sheet: '采购单', operation: 'trim', column: '供应商' }, mockCtx as any)
    expect(result).toContain('清理了1条')
  })

  it('normalize formats numbers', async () => {
    insertSummary('d4', '采购表', '采购单', ['金额'], 2)
    insertRow('norm1', '采购单', { 金额: 100.456 })
    insertRow('norm2', '采购单', { 金额: 200 })

    const result = await tool.execute({ sheet: '采购单', operation: 'normalize', column: '金额' }, mockCtx as any)
    expect(result).toContain('规范了1条')
  })
})

// ── cross_analyze ─────────────────────────────────────────────

describe('cross_analyze', () => {
  const tool = createCrossAnalyzeTool()

  it('requires at least two sheets', async () => {
    const result = await tool.execute({ sheets: '采购单' }, mockCtx as any)
    expect(result).toContain('至少指定两个工作表')
  })

  it('analyzes relationships between two sheets', async () => {
    insertSummary('c1', '采购表', '采购单', ['供应商', '吨位'], 2)
    insertSummary('c2', '客户表', '客户', ['供应商', '联系人'], 2)
    insertRow('cr1', '采购单', { 供应商: '宝钢', 吨位: '50' })
    insertRow('cr2', '采购单', { 供应商: '鞍钢', 吨位: '30' })
    insertRow('cr3', '客户', { 供应商: '宝钢', 联系人: '张经理' })

    const result = await tool.execute({ sheets: '采购单,客户' }, mockCtx as any)
    expect(result).toContain('关联分析')
    expect(result).toContain('供应商')
    expect(result).toContain('匹配')
    expect(result).toContain('1个共同值') // 宝钢 is in both
  })
})
