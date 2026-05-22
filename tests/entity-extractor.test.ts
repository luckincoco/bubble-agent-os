import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { EntityExtractor } from '../src/temporal/entity-extractor.js'
import type { Episode } from '../src/temporal/episode-store.js'
import type { LLMProvider } from '../src/shared/types.js'

let tmpDir: string
let spaceId: string

function mockLlm(response: string): LLMProvider {
  return {
    chat: async () => ({ content: response }),
  } as LLMProvider
}

const sampleEpisode: Episode = {
  id: 'ep-test-1',
  type: 'conversation',
  source: 'feishu',
  actorId: 'user-1',
  spaceId: 'space-1',
  content: '今天宝钢的螺纹钢报价是3800元一吨，比上周涨了100块。',
  summary: '钢价查询',
  metadata: {},
  parentEpisodeId: null,
  createdAt: Date.now(),
}

function makeEpisode(overrides: Partial<Episode> = {}): Episode {
  return { ...sampleEpisode, ...overrides }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-ee-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.prepare('DELETE FROM bubble_links').run()
  db.prepare('DELETE FROM bubbles').run()
})

// ── extract ─────────────────────────────────────────────────

describe('extract', () => {
  it('parses entities from valid LLM response', async () => {
    const llm = mockLlm(JSON.stringify({
      entities: [{ name: '宝钢', type: 'company', attributes: { industry: 'steel' } }],
      relations: [],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('宝钢是一家钢铁企业')
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0].name).toBe('宝钢')
    expect(result.entities[0].type).toBe('company')
  })

  it('returns empty result when JSON is missing from response', async () => {
    const llm = mockLlm('抱歉，我无法提取实体信息。')
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('随便说说')
    expect(result.entities).toHaveLength(0)
    expect(result.relations).toHaveLength(0)
    expect(result.facts).toHaveLength(0)
  })

  it('returns empty result on malformed JSON', async () => {
    const llm = mockLlm('Some text { broken json')
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('test')
    expect(result.entities).toHaveLength(0)
  })

  it('returns empty arrays when LLM returns empty extraction', async () => {
    const llm = mockLlm(JSON.stringify({ entities: [], relations: [], facts: [] }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('普通聊天内容')
    expect(result.entities).toHaveLength(0)
    expect(result.relations).toHaveLength(0)
    expect(result.facts).toHaveLength(0)
  })

  it('extracts all three sections from LLM response', async () => {
    const llm = mockLlm(JSON.stringify({
      entities: [
        { name: '宝钢', type: 'company', attributes: {} },
        { name: '螺纹钢', type: 'product', attributes: {} },
      ],
      relations: [
        { source: '宝钢', target: '螺纹钢', relation: 'produces', temporal: true },
      ],
      facts: [
        { subject: '螺纹钢', predicate: 'price', object: '3800元/吨', temporal: true },
      ],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('宝钢螺纹钢报价3800')
    expect(result.entities).toHaveLength(2)
    expect(result.relations).toHaveLength(1)
    expect(result.facts).toHaveLength(1)
    expect(result.relations[0].relation).toBe('produces')
    expect(result.facts[0].object).toBe('3800元/吨')
  })

  it('handles LLM response wrapped in markdown code block', async () => {
    const llm = mockLlm('```json\n{"entities":[],"relations":[],"facts":[]}\n```')
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extract('test')
    expect(result.entities).toHaveLength(0)
  })
})

// ── extractFromEpisode ───────────────────────────────────────

describe('extractFromEpisode', () => {
  it('skips short content (< 20 chars)', async () => {
    const llm = mockLlm('{"entities":[{"name":"X","type":"company","attributes":{}}],"relations":[],"facts":[]}')
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(makeEpisode({ content: '你好' }), spaceId)
    expect(result).toEqual({ entitiesCreated: 0, linksCreated: 0 })
  })

  it('creates entity bubbles from extraction', async () => {
    const llm = mockLlm(JSON.stringify({
      entities: [{ name: '宝钢', type: 'company', attributes: {} }],
      relations: [],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(makeEpisode({ content: '宝钢是重要的钢铁企业，位于上海，年产钢材数千万吨，是国内最大的钢铁公司之一。' }), spaceId)

    expect(result.entitiesCreated).toBe(1)
    expect(result.linksCreated).toBe(0)

    const db = getDatabase()
    const bubble = db.prepare("SELECT * FROM bubbles WHERE type = 'entity' AND title = ?").get('宝钢') as any
    expect(bubble).toBeTruthy()
    expect(bubble.space_id).toBe(spaceId)
  })

  it('creates multiple entity bubbles', async () => {
    const llm = mockLlm(JSON.stringify({
      entities: [
        { name: '宝钢', type: 'company', attributes: {} },
        { name: '鞍钢', type: 'company', attributes: {} },
      ],
      relations: [],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(
      makeEpisode({ content: '宝钢和鞍钢都是大型钢铁企业，在中国钢铁行业中占有重要地位，产品远销国内外。' }),
      spaceId,
    )
    expect(result.entitiesCreated).toBe(2)
  })

  it('creates temporal links for relations', async () => {
    const llm = mockLlm(JSON.stringify({
      entities: [
        { name: '宝钢', type: 'company', attributes: {} },
        { name: '螺纹钢', type: 'product', attributes: {} },
      ],
      relations: [
        { source: '宝钢', target: '螺纹钢', relation: 'produces', temporal: true },
      ],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(
      makeEpisode({ content: '宝钢生产的螺纹钢质量很好，价格也很有竞争力，是目前市场上最受欢迎的产品之一。' }),
      spaceId,
    )
    expect(result.linksCreated).toBe(1)

    const db = getDatabase()
    const links = db.prepare('SELECT * FROM bubble_links').all() as any[]
    expect(links).toHaveLength(1)
    expect(links[0].relation).toBe('produces')
    expect(links[0].link_source).toBe('entity-extractor')
  })

  it('reuses existing entity bubble with same name', async () => {
    // Create entity bubble first
    const db = getDatabase()
    const now = Date.now()
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["entity","company"]', 'pre-seed', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('existing-bubble-id', '宝钢', 'company: 宝钢', now, now, now, spaceId)

    const llm = mockLlm(JSON.stringify({
      entities: [{ name: '宝钢', type: 'company', attributes: {} }],
      relations: [],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(
      makeEpisode({ content: '宝钢再次被提及，但实体已经存在于知识图谱中，不需要重复创建。' }),
      spaceId,
    )

    // Should NOT create a new bubble — reuse existing (entitiesCreated counts lookups, not creations)
    expect(result.entitiesCreated).toBe(1)
  })

  it('resolves contradiction when relation target changes', async () => {
    // Set up: existing "宝钢 → 线材" relation with produces
    const db = getDatabase()
    const now = Date.now()
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["entity","company"]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('bg-id', '宝钢', 'company: 宝钢', now, now, now, spaceId)
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["entity","product"]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('wx-id', '线材', 'product: 线材', now, now, now, spaceId)
    db.prepare(`
      INSERT INTO bubbles (id, type, title, content, metadata, tags, source, confidence, decay_rate, pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
      VALUES (?, 'entity', ?, ?, '{}', '["entity","product"]', 'test', 0.8, 0.1, 0, ?, ?, ?, ?, 0)
    `).run('lw-id', '螺纹钢', 'product: 螺纹钢', now, now, now, spaceId)
    // Existing "宝钢 produces 线材" link
    db.prepare(`
      INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, valid_from, created_at)
      VALUES (?, ?, 'produces', 1.0, 'entity-extractor', ?, ?)
    `).run('bg-id', 'wx-id', now - 10000, now)

    const llm = mockLlm(JSON.stringify({
      entities: [
        { name: '宝钢', type: 'company', attributes: {} },
        { name: '螺纹钢', type: 'product', attributes: {} },
      ],
      relations: [
        { source: '宝钢', target: '螺纹钢', relation: 'produces', temporal: true },
      ],
      facts: [],
    }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(
      makeEpisode({ content: '宝钢现在主要生产螺纹钢了，线材产量已经大幅减少，客户需求已经发生了变化。' }),
      spaceId,
    )

    // 1 link created (the new one, after resolving contradiction)
    expect(result.linksCreated).toBe(1)
    // Old link should be invalidated
    const oldLink = db.prepare('SELECT * FROM bubble_links WHERE target_id = ?').get('wx-id') as any
    expect(oldLink.valid_until).not.toBeNull()
    // New link should be active
    const newLink = db.prepare('SELECT * FROM bubble_links WHERE target_id = ?').get('lw-id') as any
    expect(newLink.valid_until).toBeNull()
  })

  it('handle LLM failure gracefully', async () => {
    const llm = { chat: async () => { throw new Error('API timeout') } } as LLMProvider
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(makeEpisode(), spaceId)
    expect(result).toEqual({ entitiesCreated: 0, linksCreated: 0 })
  })

  it('returns zero when no entities extracted', async () => {
    const llm = mockLlm(JSON.stringify({ entities: [], relations: [], facts: [] }))
    const extractor = new EntityExtractor(llm)
    const result = await extractor.extractFromEpisode(
      makeEpisode({ content: '今天天气不错，适合出门走走，感受一下春天的温暖阳光和新鲜空气。' }),
      spaceId,
    )
    expect(result).toEqual({ entitiesCreated: 0, linksCreated: 0 })
  })
})
