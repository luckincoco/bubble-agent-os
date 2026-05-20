import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import * as XLSX from 'xlsx'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import type { BubbleType } from '../../shared/types.js'
import { createBubble } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { logger } from '../../shared/logger.js'
import { EXPORTS_DIR } from '../../connector/tools/excel.js'
import {
  detectSheetCategory, translateRow, generateKnowledgeCards, isBaseInfoSheet,
  isTransactionSheet, isTranslatableSheet, computePurchaseAggregations,
  computeSalesAggregations, type KnowledgeCard, type AggregationBubble,
  type SheetCategory,
} from '../../connector/tools/excel-translator.js'
import { parsePDF, parseDocx, parseTxt, splitIntoChunks, detectFileType } from '../../connector/tools/doc-import.js'
import { bridgeExcelSheet, type BridgeResult } from '../../connector/biz/excel-bridge.js'
import { inferAllSheets, applyColumnMap, resolveCategory, fuzzyMatchColumns, type SheetPreview } from '../../connector/tools/schema-inference.js'

// ── Smart header row detection for multi-layer headers ──────────────

function findHeaderRow(ws: XLSX.WorkSheet): number {
  const ref = ws['!ref']
  if (!ref) return 0

  const range = XLSX.utils.decode_range(ref)
  const merges = ws['!merges'] || []
  const totalCols = range.e.c - range.s.c + 1

  const wideMergeRows = new Set<number>()
  for (const m of merges) {
    const span = m.e.c - m.s.c + 1
    if (span > totalCols * 0.4) {
      for (let r = m.s.r; r <= m.e.r; r++) wideMergeRows.add(r)
    }
  }

  const maxScan = Math.min(range.s.r + 8, range.e.r)
  for (let r = range.s.r; r <= maxScan; r++) {
    if (wideMergeRows.has(r)) continue

    const cellValues = new Set<string>()
    let nonEmpty = 0
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c })
      const cell = ws[addr]
      if (cell && cell.v != null && String(cell.v).trim() !== '') {
        nonEmpty++
        cellValues.add(String(cell.v).trim())
      }
    }

    if (nonEmpty >= 3 && cellValues.size >= nonEmpty * 0.6) {
      let stringCount = 0
      for (let c = range.s.c; c <= range.e.c; c++) {
        const addr = XLSX.utils.encode_cell({ r, c })
        const cell = ws[addr]
        if (cell && cell.t === 's') stringCount++
      }
      if (stringCount >= nonEmpty * 0.5) {
        return r
      }
    }
  }

  return range.s.r
}

// ── Sanitize XLSX cell values ──────────────────────────────────────

function sanitizeCellValue(v: unknown): string | number | boolean | null | undefined {
  if (v == null) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const prim = (v as { valueOf(): unknown }).valueOf()
    if (typeof prim === 'number' && !isNaN(prim)) return prim
    if (typeof prim === 'string') return prim
    const s = String(v)
    return s === '[object Object]' ? '' : s
  }
  return String(v)
}

function sanitizeSheetRows(rawRows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rawRows
    .map(row => {
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        clean[k] = sanitizeCellValue(v)
      }
      return clean
    })
    .filter(row => {
      const vals = Object.values(row)
      const nonEmpty = vals.filter(v => v != null && v !== '')
      if (nonEmpty.length < 2) return false
      return vals.some(v => typeof v === 'string' && v.trim() !== '')
    })
}

export function registerImportRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { getUserCtx, modules } = deps

  // ── Excel Import ──────────────────────────────────────────────

  app.post('/api/import-excel', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传Excel文件' })

    const { spaceId } = (req.query || {}) as { spaceId?: string }
    const targetSpace = spaceId && (ctx.spaceIds.length === 0 || ctx.spaceIds.includes(spaceId))
      ? spaceId
      : ctx.activeSpaceId

    const buf = await file.toBuffer()
    const workbook = XLSX.read(buf)
    if (!workbook.SheetNames.length) return reply.code(400).send({ error: 'Excel中没有工作表' })

    let totalCreated = 0
    let knowledgeCardsCreated = 0
    let aggregationsCreated = 0
    const bridgeResults: BridgeResult[] = []
    const sheetsProcessed: Array<{ sheet: string; rows: number; columns: string[]; category: string }> = []

    const llm = modules?.llm
    const sheetPreviews: SheetPreview[] = []
    const sheetRowsCache = new Map<string, Record<string, unknown>[]>()

    for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName]!
      const headerRow = findHeaderRow(ws)
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { range: headerRow })
      const rows = sanitizeSheetRows(rawRows)
      if (!rows.length) continue
      if (headerRow > 0) {
        logger.info(`Excel import: sheet "${sheetName}" header detected at row ${headerRow + 1} (skipped ${headerRow} title rows)`)
      }
      sheetRowsCache.set(sheetName, rows)
      const headers = Object.keys(rows[0]!)
      sheetPreviews.push({ sheetName, headers, sampleRows: rows.slice(0, 3) })
    }

    const inferences = llm
      ? await inferAllSheets(llm, sheetPreviews)
      : new Map()

    for (const sheetName of workbook.SheetNames) {
      let rows = sheetRowsCache.get(sheetName)
      if (!rows?.length) continue
      logger.info(`Excel import: sheet "${sheetName}" raw=${XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]!).length} rows, after sanitize=${rows.length} rows`)

      const inference = inferences.get(sheetName)
      if (inference && Object.keys(inference.columnMap).length > 0) {
        rows = applyColumnMap(rows, inference.columnMap)
        sheetRowsCache.set(sheetName, rows)
      }

      const headers = Object.keys(rows[0]!)
      let category = resolveCategory(sheetName, inference)
      const newBubbleIds: string[] = []

      // Phase 1: Knowledge cards from base-info sheets
      if (isBaseInfoSheet(category)) {
        const cards = generateKnowledgeCards(rows, category)
        for (const card of cards) {
          const bubble = createBubble({
            type: card.type as BubbleType,
            title: card.title,
            content: card.content,
            metadata: card.metadata,
            tags: [...card.tags, sheetName, 'knowledge-card'],
            source: 'excel-translated',
            confidence: card.confidence,
            decayRate: card.decayRate,
            pinned: card.pinned,
            abstractionLevel: card.abstractionLevel,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          knowledgeCardsCreated++
          totalCreated++
        }
        logger.info(`Excel import: sheet "${sheetName}" (${category}) → ${cards.length} knowledge cards`)
      }

      // Phase 2: Translated row bubbles for transaction sheets
      if (isTranslatableSheet(category)) {
        for (const row of rows) {
          const values = headers.map(h => row[h]).filter(v => v != null && v !== '')
          if (!values.length) continue

          const translated = translateRow(row, sheetName, category)

          const bubble = createBubble({
            type: 'memory' as BubbleType,
            title: translated.title,
            content: translated.content,
            metadata: translated.metadata,
            tags: [...translated.tags, sheetName, 'excel-row'],
            source: 'excel-translated',
            confidence: 0.95,
            pinned: false,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          totalCreated++
        }
      } else if (!isBaseInfoSheet(category)) {
        for (const row of rows) {
          const values = headers.map(h => row[h]).filter(v => v != null && v !== '')
          if (!values.length) continue

          const title = `${sheetName} - ${String(values[0])}`
          const contentParts = headers
            .map(h => ({ key: h, val: row[h] }))
            .filter(p => p.val != null && p.val !== '')
            .map(p => `${p.key}: ${p.val}`)
          const content = contentParts.join('\n')

          const metadata: Record<string, unknown> = {}
          for (const h of headers) {
            if (row[h] != null && row[h] !== '') metadata[h] = row[h]
          }

          const bubble = createBubble({
            type: 'entity' as BubbleType,
            title,
            content,
            metadata,
            tags: [sheetName, 'excel-row'],
            source: 'excel',
            confidence: 1.0,
            pinned: false,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          totalCreated++
        }
      }

      // Phase 2.5: Bridge to biz structured tables
      if (isTranslatableSheet(category)) {
        try {
          const br = bridgeExcelSheet(rows, category, { confirmImmediately: true, createdBy: 'excel-import', spaceId: targetSpace })
          bridgeResults.push(br)
        } catch (err) {
          logger.error(`ExcelBridge error for sheet "${sheetName}":`, err instanceof Error ? err.message : String(err))
        }
      } else if (category === 'unknown' || category === 'inventory' || category === 'receivable' || category === 'payable') {
        const translatableTypes: SheetCategory[] = ['purchase', 'sales', 'logistics', 'payment']
        let bestMatch: { cat: SheetCategory; map: Record<string, string>; score: number } | null = null

        for (const tryType of translatableTypes) {
          const colMap = fuzzyMatchColumns(headers, tryType)
          if (colMap) {
            const score = Object.keys(colMap).length
            if (!bestMatch || score > bestMatch.score) {
              bestMatch = { cat: tryType, map: colMap, score }
            }
          }
        }

        if (bestMatch) {
          logger.info(`Excel import: sheet "${sheetName}" was "${category}", fuzzy-matched to "${bestMatch.cat}" (${bestMatch.score} columns)`)
          const mappedRows = applyColumnMap(rows, bestMatch.map)
          try {
            const br = bridgeExcelSheet(mappedRows, bestMatch.cat, { confirmImmediately: true, createdBy: 'excel-import', spaceId: targetSpace })
            bridgeResults.push(br)
            category = bestMatch.cat
          } catch (err) {
            logger.error(`ExcelBridge fallback error for sheet "${sheetName}":`, err instanceof Error ? err.message : String(err))
          }
        } else {
          logger.warn(`Excel import: sheet "${sheetName}" (${category}) — could not match to any biz type, skipping bridge`)
        }
      }

      // Phase 3: Pre-computed aggregations for transaction sheets
      if (isTransactionSheet(category)) {
        const aggBubbles: AggregationBubble[] = category === 'purchase'
          ? computePurchaseAggregations(rows)
          : computeSalesAggregations(rows)

        for (const agg of aggBubbles) {
          const bubble = createBubble({
            type: 'synthesis' as BubbleType,
            title: agg.title,
            content: agg.content,
            metadata: agg.metadata,
            tags: [...agg.tags, sheetName, 'excel-aggregation'],
            source: 'excel-translated',
            confidence: 1.0,
            pinned: true,
            abstractionLevel: agg.abstractionLevel,
            spaceId: targetSpace,
          })
          newBubbleIds.push(bubble.id)
          aggregationsCreated++
          totalCreated++
        }
        logger.info(`Excel import: sheet "${sheetName}" (${category}) → ${aggBubbles.length} aggregation bubbles`)
      }

      // Phase 4: Build summary bubble
      const numericStats: Record<string, { sum: number; min: number; max: number; count: number }> = {}
      for (const h of headers) {
        const nums: number[] = []
        for (const r of rows) {
          const v = r[h]
          if (v != null && v !== '' && !isNaN(Number(v))) nums.push(Number(v))
        }
        if (nums.length > rows.length * 0.5) {
          numericStats[h] = {
            sum: nums.reduce((a, b) => a + b, 0),
            min: Math.min(...nums),
            max: Math.max(...nums),
            count: nums.length,
          }
        }
      }

      const tableHeader = `| ${headers.join(' | ')} |`
      const tableSep = `| ${headers.map(() => '---').join(' | ')} |`
      const tableRows = rows.map(r =>
        `| ${headers.map(h => r[h] != null ? String(r[h]) : '').join(' | ')} |`
      )

      const statsLines: string[] = []
      for (const [colName, st] of Object.entries(numericStats)) {
        statsLines.push(`${colName}: 合计=${st.sum}, 最小=${st.min}, 最大=${st.max}, 有效行数=${st.count}`)
      }

      const semanticLines: string[] = []
      const textCols: Record<string, Set<string>> = {}
      for (const h of headers) {
        const uniqueVals = new Set<string>()
        for (const r of rows) {
          const v = r[h]
          if (v != null && v !== '' && isNaN(Number(v))) uniqueVals.add(String(v))
        }
        if (uniqueVals.size > 0 && uniqueVals.size <= rows.length * 0.8) {
          textCols[h] = uniqueVals
        }
      }

      semanticLines.push(`这是一份「${sheetName}」表格（类型: ${category}），共${rows.length}条记录。`)

      for (const [colName, vals] of Object.entries(textCols)) {
        if (vals.size <= 10) {
          semanticLines.push(`${colName}包含: ${[...vals].join('、')}（共${vals.size}种）`)
        } else {
          const sample = [...vals].slice(0, 5).join('、')
          semanticLines.push(`${colName}共${vals.size}种，如: ${sample}等`)
        }
      }

      for (const [colName, st] of Object.entries(numericStats)) {
        const avg = (st.sum / st.count).toFixed(2)
        semanticLines.push(`${colName}合计${st.sum}，平均${avg}，范围${st.min}~${st.max}`)
      }

      const firstTextCol = Object.keys(textCols)[0]
      const firstNumCol = Object.keys(numericStats)[0]
      if (firstTextCol && firstNumCol && textCols[firstTextCol].size <= 20) {
        const grouped: Record<string, number> = {}
        for (const r of rows) {
          const key = String(r[firstTextCol] ?? '其他')
          const val = Number(r[firstNumCol])
          if (!isNaN(val)) grouped[key] = (grouped[key] || 0) + val
        }
        const sorted = Object.entries(grouped).sort((a, b) => b[1] - a[1])
        const topItems = sorted.slice(0, 5).map(([k, v]) => `${k}(${v})`).join('、')
        semanticLines.push(`按${firstTextCol}汇总${firstNumCol}: ${topItems}`)
      }

      const summaryContent = [
        `数据来源: Excel文件 工作表「${sheetName}」（${category}）`,
        `共 ${rows.length} 行数据，列: ${headers.join(', ')}`,
        '',
        '业务摘要:',
        semanticLines.join('\n'),
        '',
        statsLines.length ? `数值列统计:\n${statsLines.join('\n')}` : '',
        '',
        '完整数据表:',
        tableHeader,
        tableSep,
        ...tableRows,
      ].filter(Boolean).join('\n')

      const summaryBubble = createBubble({
        type: 'document' as BubbleType,
        title: `Excel数据总览: ${sheetName}`,
        content: summaryContent,
        metadata: { columns: headers, rowCount: rows.length, numericStats, source_file: file.filename, sheetCategory: category },
        tags: [sheetName, 'excel-summary'],
        source: 'excel',
        confidence: 1.0,
        pinned: true,
        spaceId: targetSpace,
      })

      for (const rowId of newBubbleIds) {
        addLink(rowId, summaryBubble.id, 'belongs_to', 0.6, 'system')
      }

      if (modules?.semanticBridge) {
        modules.semanticBridge.bridgeExcelImport(
          newBubbleIds, rows as Record<string, unknown>[], headers, summaryBubble.id, targetSpace,
        ).catch(err => logger.error('SemanticBridge error:', err instanceof Error ? err.message : String(err)))
      }

      if (modules?.surpriseDetector) {
        modules.surpriseDetector.scanExcelImport(
          rows as Record<string, unknown>[], headers, numericStats, sheetName, targetSpace,
        ).catch(err => logger.error('SurpriseDetector error:', err instanceof Error ? err.message : String(err)))
      }

      sheetsProcessed.push({ sheet: sheetName, rows: rows.length, columns: headers, category })
      logger.info(`Excel import: sheet "${sheetName}" (${category}) - ${newBubbleIds.length} bubbles + 1 summary`)
    }

    if (!sheetsProcessed.length) return reply.code(400).send({ error: 'Excel中没有数据行' })

    logger.info(`Excel import complete: ${totalCreated} total (${knowledgeCardsCreated} knowledge cards, ${aggregationsCreated} aggregations) across ${sheetsProcessed.length} sheets from "${file.filename}"`)

    const bizBridge = {
      created: { purchases: 0, sales: 0, logistics: 0, payments: 0 },
      skipped: { purchases: 0, sales: 0, logistics: 0, payments: 0 },
      errors: [] as Array<{ rowIndex: number; message: string }>,
    }
    for (const br of bridgeResults) {
      for (const k of ['purchases', 'sales', 'logistics', 'payments'] as const) {
        bizBridge.created[k] += br.created[k]
        bizBridge.skipped[k] += br.skipped[k]
      }
      bizBridge.errors.push(...br.errors)
    }
    const bizTotal = bizBridge.created.purchases + bizBridge.created.sales + bizBridge.created.logistics + bizBridge.created.payments
    if (bizTotal > 0) {
      logger.info(`Excel biz bridge: ${bizTotal} structured records created`)
    }

    const diagnostics = {
      inferenceReport: sheetsProcessed.map(sp => {
        const inf = inferences.get(sp.sheet)
        if (inf) {
          return { sheet: sp.sheet, method: 'llm' as const, category: sp.category, confidence: inf.confidence }
        }
        return { sheet: sp.sheet, method: 'regex-fallback' as const, category: sp.category, confidence: 0 }
      }),
    }

    const totalRowsParsed = sheetsProcessed.reduce((a, s) => a + s.rows, 0)
    const totalRecordsCreated = bizTotal
    const totalDuplicatesSkipped = bizBridge.skipped.purchases + bizBridge.skipped.sales + bizBridge.skipped.logistics + bizBridge.skipped.payments
    const validation = {
      totalRowsParsed,
      recordsCreated: totalRecordsCreated,
      duplicatesSkipped: totalDuplicatesSkipped,
      errors: bizBridge.errors.length,
      errorSamples: bizBridge.errors.slice(0, 3),
    }

    return { created: totalCreated, knowledgeCards: knowledgeCardsCreated, aggregations: aggregationsCreated, sheets: sheetsProcessed, bizBridge, diagnostics, validation }
  })

  // ── Document Import (PDF, Word, TXT) ─────────────────────────

  app.post('/api/import-doc', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传文档文件（支持PDF、Word、TXT）' })

    const filename = file.filename || 'unknown'
    const fileType = detectFileType(filename)
    if (!fileType) {
      return reply.code(400).send({ error: '不支持的文件格式，请上传 .pdf、.docx 或 .txt 文件' })
    }

    const targetSpace = ctx.activeSpaceId
    const buf = await file.toBuffer()

    let text: string
    let pageCount: number | undefined

    try {
      if (fileType === 'pdf') {
        const result = await parsePDF(buf)
        text = result.text
        pageCount = result.pageCount
      } else if (fileType === 'docx') {
        const result = await parseDocx(buf)
        text = result.text
      } else {
        text = parseTxt(buf).text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.code(400).send({ error: `文档解析失败: ${msg}` })
    }

    if (!text.trim()) return reply.code(400).send({ error: '文档内容为空' })

    const chunks = splitIntoChunks(text, 2000)
    const wordCount = text.length
    const newBubbleIds: string[] = []

    for (let i = 0; i < chunks.length; i++) {
      const bubble = createBubble({
        type: 'entity' as BubbleType,
        title: `${filename} - 第${i + 1}段`,
        content: chunks[i],
        metadata: { filename, fileType, chunkIndex: i, totalChunks: chunks.length },
        tags: [filename, 'doc-chunk', `chunk-${i + 1}`],
        source: 'doc-import',
        confidence: 1.0,
        pinned: false,
        spaceId: targetSpace,
      })
      newBubbleIds.push(bubble.id)
    }

    const summaryLines = [
      `文档来源: ${filename}`,
      `文件类型: ${fileType.toUpperCase()}`,
      pageCount != null ? `页数: ${pageCount}` : null,
      `总字数: ${wordCount}`,
      `分块数: ${chunks.length}`,
      '',
      '内容预览:',
      text.slice(0, 500) + (text.length > 500 ? '...' : ''),
    ].filter(l => l != null).join('\n')

    const summaryBubble = createBubble({
      type: 'document' as BubbleType,
      title: `文档总览: ${filename}`,
      content: summaryLines,
      metadata: { filename, fileType, pageCount, wordCount, chunkCount: chunks.length },
      tags: [filename, 'doc-summary'],
      source: 'doc-import',
      confidence: 1.0,
      pinned: true,
      spaceId: targetSpace,
    })

    for (const chunkId of newBubbleIds) {
      addLink(chunkId, summaryBubble.id, 'part_of', 0.9, 'system')
    }

    if (modules?.semanticBridge && 'bridgeDocImport' in modules.semanticBridge) {
      (modules.semanticBridge as any).bridgeDocImport(newBubbleIds, chunks, summaryBubble.id, targetSpace)
        ?.catch((err: unknown) => logger.error('SemanticBridge doc error:', err instanceof Error ? err.message : String(err)))
    }

    logger.info(`Doc import: "${filename}" (${fileType}) - ${chunks.length} chunks + 1 summary`)
    return { created: newBubbleIds.length + 1, filename, fileType, chunks: chunks.length, wordCount }
  })

  // ── Excel Export File Download ───────────────────────────────

  app.get('/api/exports/:filename', async (req: FastifyRequest, reply: FastifyReply) => {
    const { filename } = req.params as { filename: string }
    const safeName = decodeURIComponent(filename).replace(/[^a-zA-Z0-9_一-鿿.\-]/g, '_')
    const filePath = resolve(EXPORTS_DIR, safeName)

    if (!filePath.startsWith(EXPORTS_DIR) || !existsSync(filePath)) {
      return reply.code(404).send({ error: '文件不存在或已过期' })
    }

    const buf = readFileSync(filePath)
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeName)}"`)
    return reply.send(buf)
  })

  // ── Image Import (OCR) ───────────────────────────────────────

  app.post('/api/import-image', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getUserCtx(req)
    const file = await req.file()
    if (!file) return reply.code(400).send({ error: '请上传图片文件' })

    if (!modules?.tencentConfig) {
      return reply.code(503).send({ error: 'OCR 服务未配置（需要 TENCENT_SECRET_ID / TENCENT_SECRET_KEY）' })
    }

    const buf = await file.toBuffer()
    const filename = file.filename || 'image'

    try {
      const { recognizeImage } = await import('../../connector/ocr.js')
      const result = await recognizeImage(buf, modules.tencentConfig)

      if (!result.text.trim()) {
        return reply.code(400).send({ error: '图片中未识别到文字' })
      }

      const targetSpace = ctx.activeSpaceId
      const bubble = createBubble({
        type: 'document' as BubbleType,
        title: `OCR识别: ${filename}`,
        content: result.text,
        metadata: {
          source_file: filename,
          ocr_confidence: result.averageConfidence,
          ocr_regions: result.regions.length,
        },
        tags: ['ocr', filename],
        source: 'ocr',
        confidence: result.averageConfidence / 100,
        pinned: false,
        spaceId: targetSpace,
      })

      logger.info(`OCR import: "${filename}" -> ${result.regions.length} regions, bubble ${bubble.id}`)
      return {
        bubbleId: bubble.id,
        text: result.text,
        confidence: result.averageConfidence,
        regions: result.regions.length,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('OCR error:', msg)
      return reply.code(500).send({ error: `OCR 识别失败: ${msg}` })
    }
  })
}
