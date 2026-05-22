import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import {
  extractEntities,
  storeEntities,
  findBubblesByEntity,
  findRelatedEntities,
  indexBubbleEntities,
  type ExtractedEntity,
} from '../src/bubble/entity-extractor.js'

let tmpDir: string

function insertBubble(id: string): void {
  const db = getDatabase()
  const now = Date.now()
  db.prepare(`
    INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, 'entity', ?, ?, '{}', '[]', 'test', 0.8, 0.1, 0, ?, ?, ?, NULL, 0)
  `).run(id, id, id, now, now, now)
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-be-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_entities').run()
  db.prepare('DELETE FROM bubbles').run()
})

// ── extractEntities ─────────────────────────────────────────

describe('extractEntities', () => {
  it('extracts company names with Chinese suffixes', () => {
    const result = extractEntities('上海宝钢集团有限公司达成合作')
    expect(result.some(e => e.text === '上海宝钢集团有限公司' && e.type === 'company')).toBe(true)
  })

  it('extracts phone numbers', () => {
    const result = extractEntities('联系人电话：13800138000')
    expect(result.some(e => e.text === '13800138000' && e.type === 'phone')).toBe(true)
  })

  it('extracts landline numbers', () => {
    const result = extractEntities('座机：021-55551234')
    expect(result.some(e => e.type === 'phone')).toBe(true)
  })

  it('extracts amounts in Chinese currency', () => {
    const result = extractEntities('合同金额：500万元')
    expect(result.some(e => e.text === '500万元' && e.type === 'amount')).toBe(true)
  })

  it('extracts amounts with 元 suffix', () => {
    const result = extractEntities('单价3500元每吨')
    expect(result.some(e => e.type === 'amount')).toBe(true)
  })

  it('extracts dates in yyyy年mm月dd日 format', () => {
    const result = extractEntities('交货日期：2024年3月15日')
    expect(result.some(e => e.text === '2024年3月15日' && e.type === 'date')).toBe(true)
  })

  it('extracts dates in mm月dd日 format', () => {
    const result = extractEntities('下单时间：5月20日')
    expect(result.some(e => e.type === 'date')).toBe(true)
  })

  it('extracts locations with regional suffixes', () => {
    const result = extractEntities('发货地址：上海市宝山区')
    expect(result.some(e => e.type === 'location')).toBe(true)
  })

  it('extracts steel product names', () => {
    const result = extractEntities('采购螺纹钢用于建筑项目')
    expect(result.some(e => e.text === '螺纹钢' && e.type === 'product')).toBe(true)
  })

  it('extracts multiple product types', () => {
    const result = extractEntities('现有螺纹钢500吨，线材300吨，盘螺200吨')
    const products = result.filter(e => e.type === 'product')
    expect(products.length).toBeGreaterThanOrEqual(3)
  })

  it('extracts person names with title suffixes', () => {
    const result = extractEntities('小王总洽谈具体事宜')
    expect(result.some(e => e.text === '小王' && e.type === 'person')).toBe(true)
  })

  it('deduplicates same entity type+text', () => {
    const result = extractEntities('螺纹钢和螺纹钢都是螺纹钢')
    const products = result.filter(e => e.type === 'product' && e.text === '螺纹钢')
    expect(products).toHaveLength(1)
  })

  it('filters out entities shorter than 2 chars', () => {
    const result = extractEntities('李总您好')
    // '李' matches PERSON_TITLE_RE but has length 1 < 2
    expect(result.every(e => e.text.length >= 2)).toBe(true)
  })

  it('returns empty for no matches', () => {
    const result = extractEntities('你好，今天天气不错')
    expect(result).toHaveLength(0)
  })

  it('extracts multiple entity types from mixed content', () => {
    const result = extractEntities(
      '上海宝钢集团销售经理小王总报价：螺纹钢单价3800元每吨，联系手机13800138000，交货期2024年6月15日'
    )
    expect(result.some(e => e.type === 'company')).toBe(true)
    expect(result.some(e => e.type === 'person')).toBe(true)
    expect(result.some(e => e.type === 'product')).toBe(true)
    expect(result.some(e => e.type === 'amount')).toBe(true)
    expect(result.some(e => e.type === 'phone')).toBe(true)
    expect(result.some(e => e.type === 'date')).toBe(true)
  })
})

// ── storeEntities ───────────────────────────────────────────

describe('storeEntities', () => {
  it('stores entities in bubble_entities table', () => {
    insertBubble('b1')
    const entities: ExtractedEntity[] = [
      { text: '螺纹钢', type: 'product' },
      { text: '宝钢集团', type: 'company' },
    ]
    const count = storeEntities('b1', entities)
    expect(count).toBe(2)

    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM bubble_entities WHERE bubble_id = ?').all('b1') as any[]
    expect(rows).toHaveLength(2)
  })

  it('returns 0 for empty entities list', () => {
    const count = storeEntities('b1', [])
    expect(count).toBe(0)
  })
})

// ── findBubblesByEntity ─────────────────────────────────────

describe('findBubblesByEntity', () => {
  it('finds bubble IDs by entity text', () => {
    insertBubble('b1'); insertBubble('b2')
    storeEntities('b1', [{ text: '螺纹钢', type: 'product' }])
    storeEntities('b2', [{ text: '螺纹钢', type: 'product' }])

    const ids = findBubblesByEntity('螺纹钢')
    expect(ids).toHaveLength(2)
    expect(ids).toContain('b1')
    expect(ids).toContain('b2')
  })

  it('filters by entity type', () => {
    insertBubble('b1')
    storeEntities('b1', [{ text: '螺纹钢', type: 'product' }])
    storeEntities('b1', [{ text: '螺纹钢', type: 'company' }]) // different type

    const ids = findBubblesByEntity('螺纹钢', 'product')
    expect(ids).toHaveLength(1)
  })

  it('returns empty for unknown entity', () => {
    const ids = findBubblesByEntity('nonexistent')
    expect(ids).toHaveLength(0)
  })
})

// ── findRelatedEntities ─────────────────────────────────────

describe('findRelatedEntities', () => {
  it('finds co-occurring entities', () => {
    insertBubble('b1')
    storeEntities('b1', [
      { text: '螺纹钢', type: 'product' },
      { text: '宝钢', type: 'company' },
      { text: '500万元', type: 'amount' },
    ])

    const related = findRelatedEntities('螺纹钢')
    expect(related.length).toBeGreaterThanOrEqual(2)
    const texts = related.map(r => r.text)
    expect(texts).toContain('宝钢')
    expect(texts).toContain('500万元')
  })

  it('returns empty for unknown entity', () => {
    const related = findRelatedEntities('nonexistent')
    expect(related).toHaveLength(0)
  })
})

// ── indexBubbleEntities ─────────────────────────────────────

describe('indexBubbleEntities', () => {
  it('extracts and stores in one call', () => {
    insertBubble('b1')
    const count = indexBubbleEntities('b1', '采购螺纹钢500吨，联系宝钢集团张经理，电话13800138000')
    expect(count).toBeGreaterThan(0)

    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM bubble_entities WHERE bubble_id = ?').all('b1') as any[]
    expect(rows.length).toBeGreaterThan(0)
  })

  it('returns 0 for content with no entities', () => {
    insertBubble('b1')
    const count = indexBubbleEntities('b1', '你好')
    expect(count).toBe(0)
  })
})
