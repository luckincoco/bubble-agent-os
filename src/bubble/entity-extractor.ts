import { ulid } from 'ulid'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

/**
 * Entity Extractor — lightweight rule-based NER for Chinese text.
 *
 * Extracts entities from bubble content and stores them in bubble_entities table.
 * Uses regex patterns and heuristics rather than LLM to keep it fast and cheap.
 *
 * Entity types: person, company, product, location, phone, amount, date
 */

export type EntityType = 'person' | 'company' | 'product' | 'location' | 'phone' | 'amount' | 'date'

export interface ExtractedEntity {
  text: string
  type: EntityType
}

// ── Pattern definitions ──

// Company names: end with typical suffixes
const COMPANY_RE = /[\u4e00-\u9fff]{2,10}(?:有限公司|集团|科技|贸易|实业|钢铁|金属|建材|物流|商贸|工程|材料)/g

// Phone numbers
const PHONE_RE = /(?:1[3-9]\d{9}|0\d{2,3}-?\d{7,8})/g

// Amount patterns (Chinese currency)
const AMOUNT_RE = /(?:\d+\.?\d*)\s*(?:万元|元|块|万|亿|千)/g

// Date patterns
const DATE_RE = /(?:\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号])/g

// Location patterns: known suffixes
const LOCATION_RE = /[\u4e00-\u9fff]{2,6}(?:省|市|区|县|镇|村|路|街|大道|工业园|开发区|仓库|码头)/g

// Product patterns (steel/metal specific for this domain)
const PRODUCT_RE = /(?:螺纹钢|线材|盘螺|热卷|冷轧|中板|角钢|槽钢|工字钢|H型钢|方管|圆管|镀锌管|焊管|无缝管|不锈钢)(?:\s*[\d.]+(?:\*[\d.]+)*)?/g

// Person name: "X总", "X经理", "X老板" patterns (most reliable for Chinese names)
const PERSON_TITLE_RE = /([\u4e00-\u9fff]{1,3})(?:总|经理|老板|主任|师傅|工|哥|姐|先生|女士|老师)/g

/**
 * Extract entities from text content.
 */
export function extractEntities(content: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = []
  const seen = new Set<string>()

  const add = (text: string, type: EntityType) => {
    const key = `${type}:${text}`
    if (!seen.has(key) && text.length >= 2) {
      seen.add(key)
      entities.push({ text, type })
    }
  }

  // Company
  for (const m of content.matchAll(COMPANY_RE)) {
    add(m[0], 'company')
  }

  // Phone
  for (const m of content.matchAll(PHONE_RE)) {
    add(m[0], 'phone')
  }

  // Amount
  for (const m of content.matchAll(AMOUNT_RE)) {
    add(m[0], 'amount')
  }

  // Date
  for (const m of content.matchAll(DATE_RE)) {
    add(m[0], 'date')
  }

  // Location
  for (const m of content.matchAll(LOCATION_RE)) {
    add(m[0], 'location')
  }

  // Product
  for (const m of content.matchAll(PRODUCT_RE)) {
    add(m[0], 'product')
  }

  // Person (via title suffix)
  for (const m of content.matchAll(PERSON_TITLE_RE)) {
    add(m[1], 'person')
  }

  return entities
}

/**
 * Store extracted entities into bubble_entities table.
 * Returns number of entities stored.
 */
export function storeEntities(bubbleId: string, entities: ExtractedEntity[]): number {
  if (entities.length === 0) return 0

  const db = getDatabase()
  const now = Date.now()
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO bubble_entities (id, bubble_id, entity_text, entity_type, created_at) VALUES (?, ?, ?, ?, ?)'
  )

  let count = 0
  for (const entity of entities) {
    try {
      stmt.run(ulid(), bubbleId, entity.text, entity.type, now)
      count++
    } catch {
      // IGNORE duplicate (same bubble_id + entity_text + entity_type)
    }
  }

  return count
}

/**
 * Find all bubble IDs that mention a specific entity.
 */
export function findBubblesByEntity(entityText: string, entityType?: EntityType, limit = 50): string[] {
  const db = getDatabase()
  let sql = 'SELECT DISTINCT bubble_id FROM bubble_entities WHERE entity_text = ?'
  const params: unknown[] = [entityText]

  if (entityType) {
    sql += ' AND entity_type = ?'
    params.push(entityType)
  }

  sql += ' ORDER BY created_at DESC LIMIT ?'
  params.push(limit)

  const rows = db.prepare(sql).all(...params) as Array<{ bubble_id: string }>
  return rows.map(r => r.bubble_id)
}

/**
 * Find co-occurring entities: entities that appear in the same bubbles as the given entity.
 */
export function findRelatedEntities(entityText: string, limit = 20): Array<{ text: string; type: EntityType; coCount: number }> {
  const db = getDatabase()
  const sql = `
    SELECT e2.entity_text as text, e2.entity_type as type, COUNT(*) as co_count
    FROM bubble_entities e1
    JOIN bubble_entities e2 ON e1.bubble_id = e2.bubble_id
    WHERE e1.entity_text = ? AND e2.entity_text != ?
    GROUP BY e2.entity_text, e2.entity_type
    ORDER BY co_count DESC
    LIMIT ?
  `
  return db.prepare(sql).all(entityText, entityText, limit) as Array<{ text: string; type: EntityType; coCount: number }>
}

/**
 * Extract and store entities for a bubble. One-shot convenience function.
 */
export function indexBubbleEntities(bubbleId: string, content: string): number {
  const entities = extractEntities(content)
  if (entities.length === 0) return 0
  const count = storeEntities(bubbleId, entities)
  if (count > 0) {
    logger.debug(`Indexed ${count} entities for bubble ${bubbleId}`)
  }
  return count
}
