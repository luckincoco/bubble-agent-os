import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Reflector } from '../src/memory/reflector.js'
import type { LLMProvider, Bubble } from '../src/shared/types.js'

// Keep model.js and links.js real by default, spy per-test
vi.mock('../src/bubble/model.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod }
})

vi.mock('../src/bubble/links.js', async (importOriginal) => {
  const mod = await importOriginal()
  return { ...mod }
})

vi.mock('../src/memory/draft-observations.js', () => ({
  createDraft: vi.fn(),
}))

import * as model from '../src/bubble/model.js'
import * as links from '../src/bubble/links.js'
import { createDraft } from '../src/memory/draft-observations.js'

const dummyLLM: LLMProvider = { chat: vi.fn(), chatStream: vi.fn() }

let tmpDir: string
let spaceId: string

function makeBubble(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id, type: 'memory', title: '', content: '',
    metadata: {}, tags: [], embedding: undefined, source: 'user',
    confidence: 0.8, decayRate: 0.1, pinned: false,
    createdAt: Date.now(), updatedAt: Date.now(), accessedAt: Date.now(),
    spaceId, abstractionLevel: 0, summary: null,
    ...overrides,
  }
}

function insertBubble(overrides: Record<string, unknown> = {}): string {
  const db = getDatabase()
  const id = (overrides.id as string) || `b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  db.prepare(`INSERT INTO bubbles
    (id, type, title, content, metadata, tags, source, confidence, decay_rate,
     pinned, created_at, updated_at, accessed_at, space_id, abstraction_level)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.1, 0, ?, ?, ?, ?, ?)`)
    .run(
      id,
      overrides.type as string || 'memory',
      overrides.title as string || 'test',
      overrides.content as string || 'test content',
      (overrides.metadata as string) || '{}',
      JSON.stringify((overrides.tags as string[]) || []),
      overrides.source as string || 'user',
      overrides.confidence ?? 0.8,
      (overrides.created_at as number) ?? now,
      (overrides.updated_at as number) ?? now,
      (overrides.accessed_at as number) ?? now,
      overrides.space_id as string || spaceId,
      (overrides.abstraction_level as number) ?? 0,
    )
  return id
}

function makeMockLLM(response: unknown): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ content: JSON.stringify(response) }),
    chatStream: vi.fn(),
  }
}

function makeSequentialLLM(...responses: string[]): LLMProvider {
  const mock = vi.fn()
  responses.forEach(r => mock.mockResolvedValueOnce({ content: r }))
  return { chat: mock, chatStream: vi.fn() }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-rfl-'))
  initDatabase(tmpDir, 'test-password-123')
  const db = getDatabase()
  const space = db.prepare('SELECT id FROM spaces LIMIT 1').get() as { id: string }
  spaceId = space.id
})

beforeEach(() => {
  vi.restoreAllMocks()
  const db = getDatabase()
  db.prepare('DELETE FROM bubbles').run()
  db.prepare('DELETE FROM bubble_links').run()
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── groupByTags (pure function) ───────────────────────────────────

describe('groupByTags', () => {
  function groupByTags(memories: Bubble[]): Bubble[][] {
    const reflector = new Reflector(dummyLLM) as unknown as { groupByTags(m: Bubble[]): Bubble[][] }
    return reflector.groupByTags(memories)
  }

  it('groups memories by shared tags and filters system tags', () => {
    const memories = [
      makeBubble('m1', { tags: ['finance', 'report'] }),
      makeBubble('m2', { tags: ['finance', 'quarterly'] }),
      makeBubble('m3', { tags: ['finance', 'report', 'novel'] }),
      makeBubble('m4', { tags: ['report', 'quarterly'] }),
    ]
    const groups = groupByTags(memories)
    // finance: m1,m2,m3=3, report: m1,m3,m4=3, quarterly: m2,m4=2 (filtered), novel: filtered
    expect(groups.length).toBe(2)
    const allTags = groups.map(g => g.length)
    expect(allTags).toEqual([3, 3])
  })

  it('filters out groups with fewer than 3 members', () => {
    const memories = [
      makeBubble('m1', { tags: ['tagA'] }),
      makeBubble('m2', { tags: ['tagA'] }),
      makeBubble('m3', { tags: ['tagB'] }),
    ]
    const groups = groupByTags(memories)
    expect(groups.length).toBe(0)
  })

  it('sorts groups by size descending', () => {
    const memories = [
      makeBubble('m1', { tags: ['a'] }),
      makeBubble('m2', { tags: ['a'] }),
      makeBubble('m3', { tags: ['a'] }),
      makeBubble('m4', { tags: ['a'] }),
      makeBubble('m5', { tags: ['b'] }),
      makeBubble('m6', { tags: ['b'] }),
      makeBubble('m7', { tags: ['b'] }),
      makeBubble('m8', { tags: ['c'] }),
      makeBubble('m9', { tags: ['c'] }),
      makeBubble('m10', { tags: ['c'] }),
    ]
    const groups = groupByTags(memories)
    expect(groups[0].length).toBe(4) // a
    expect(groups[1].length).toBe(3) // b
    expect(groups[2].length).toBe(3) // c
  })
})

// ── findExistingObservation ───────────────────────────────────────

describe('findExistingObservation', () => {
  function findExistingObservation(group: Bubble[]) {
    const reflector = new Reflector(dummyLLM) as unknown as { findExistingObservation(g: Bubble[]): Bubble | null }
    return reflector.findExistingObservation(group)
  }

  it('no existing observation returns null', () => {
    vi.spyOn(model, 'searchBubbles').mockReturnValue([])
    const result = findExistingObservation([
      makeBubble('m1', { tags: ['test-tag'] }),
      makeBubble('m2', { tags: ['test-tag'] }),
      makeBubble('m3', { tags: ['test-tag'] }),
    ])
    expect(result).toBeNull()
  })

  it('returns first matching observation', () => {
    const fakeObs = makeBubble('obs1', { type: 'observation', title: '已有观察' })
    vi.spyOn(model, 'searchBubbles').mockReturnValue([fakeObs])
    const result = findExistingObservation([
      makeBubble('m1', { tags: ['test-tag'] }),
      makeBubble('m2', { tags: ['test-tag'] }),
      makeBubble('m3', { tags: ['test-tag'] }),
    ])
    expect(result).not.toBeNull()
    expect(result!.id).toBe('obs1')
  })
})

// ── getSuggestions ────────────────────────────────────────────────

describe('getSuggestions', () => {
  it('filters by minConfidence', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.9, abstraction_level: 1 })
    insertBubble({ id: 'obs2', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.5, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const result = reflector.getSuggestions(spaceId)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('obs1')
  })

  it('filters out stale and weakening trends', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.9, abstraction_level: 1 })
    insertBubble({ id: 'obs2', type: 'observation',
      metadata: JSON.stringify({ trend: 'stale', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.8, abstraction_level: 1 })
    insertBubble({ id: 'obs3', type: 'observation',
      metadata: JSON.stringify({ trend: 'weakening', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.8, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const result = reflector.getSuggestions(spaceId)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('obs1')
  })
})

// ── getTopDomains ─────────────────────────────────────────────────

describe('getTopDomains', () => {
  it('computes weight from domainWeight or evidenceCount*confidence', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 3, firstSeen: 1, lastSeen: 1, reviewCount: 0, domainWeight: 5.0 }),
      tags: ['observation', 'auto-discovered', 'keyword1'], confidence: 0.9, abstraction_level: 1 })
    insertBubble({ id: 'obs2', type: 'observation',
      metadata: JSON.stringify({ trend: 'new', evidenceIds: [], evidenceCount: 2, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered', 'keyword2'], confidence: 0.8, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const domains = reflector.getTopDomains(5, spaceId)
    expect(domains).toHaveLength(2)
    expect(domains[0].weight).toBe(5.0)
    expect(domains[1].weight).toBeCloseTo(2 * 0.8, 1)
    expect(domains[0].keywords).toEqual(['keyword1'])
  })

  it('filters out entries with weight <= 0 or no keywords', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 3, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered', 'kw1'], confidence: 0.9, abstraction_level: 1 })
    // keyword list would be empty after filtering observation/auto-discovered
    insertBubble({ id: 'obs2', type: 'observation',
      metadata: JSON.stringify({ trend: 'new', evidenceIds: [], evidenceCount: 0, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.0, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const domains = reflector.getTopDomains(5, spaceId)
    expect(domains).toHaveLength(1)
    expect(domains[0].keywords).toEqual(['kw1'])
  })
})

// ── getQualitySignals ─────────────────────────────────────────────

describe('getQualitySignals', () => {
  it('maps evidence IDs to observation quality signals', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: ['e1', 'e2'], evidenceCount: 2, firstSeen: 1, lastSeen: 1, reviewCount: 1 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.85, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const signals = reflector.getQualitySignals(spaceId)
    expect(signals.size).toBe(2)
    expect(signals.get('e1')).toBeDefined()
    expect(signals.get('e1')!.validated).toBe(true)
    expect(signals.get('e1')!.observationTrend).toBe('stable')
    expect(signals.get('e1')!.observationConfidence).toBe(0.85)
    expect(signals.get('e2')).toBeDefined()
  })

  it('keeps strongest signal when evidence is in multiple observations', () => {
    insertBubble({ id: 'obs1', type: 'observation',
      metadata: JSON.stringify({ trend: 'new', evidenceIds: ['e1'], evidenceCount: 1, firstSeen: 1, lastSeen: 1, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.6, abstraction_level: 1 })
    insertBubble({ id: 'obs2', type: 'observation',
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: ['e1'], evidenceCount: 3, firstSeen: 1, lastSeen: 1, reviewCount: 2 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.9, abstraction_level: 1 })

    const reflector = new Reflector(dummyLLM)
    const signals = reflector.getQualitySignals(spaceId)
    expect(signals.size).toBe(1)
    expect(signals.get('e1')!.observationConfidence).toBe(0.9)
    expect(signals.get('e1')!.observationTrend).toBe('stable')
  })
})

// ── validateSynthesis ─────────────────────────────────────────────

describe('validateSynthesis', () => {
  it('no composed_of children returns all zeros', () => {
    insertBubble({ id: 'syn1', type: 'synthesis' })

    const reflector = new Reflector(dummyLLM)
    const result = reflector.validateSynthesis('syn1', spaceId)
    expect(result.alignedObservations).toBe(0)
    expect(result.contradictedObservations).toBe(0)
    expect(result.noveltyScore).toBe(0)
  })

  it('counts aligned vs contradicted observations', () => {
    insertBubble({ id: 'syn1', type: 'synthesis' })
    const c1 = insertBubble({ id: 'c1', type: 'memory' })
    const c2 = insertBubble({ id: 'c2', type: 'memory' })
    const c3 = insertBubble({ id: 'c3', type: 'memory' })
    // Link synthesis → children
    links.addLink('syn1', c1, 'composed_of', 1.0, 'system')
    links.addLink('syn1', c2, 'composed_of', 1.0, 'system')
    links.addLink('syn1', c3, 'composed_of', 1.0, 'system')

    // Observation with evidence = [c1, c2] → aligned
    insertBubble({ id: 'obs1', type: 'observation', abstraction_level: 1,
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [c1, c2], evidenceCount: 2, firstSeen: 1, lastSeen: 1, reviewCount: 1 }),
      tags: ['observation', 'auto-discovered'] })
    // Observation with evidence = [c3] → stale → contradicted
    insertBubble({ id: 'obs2', type: 'observation', abstraction_level: 1,
      metadata: JSON.stringify({ trend: 'stale', evidenceIds: [c3], evidenceCount: 1, firstSeen: 1, lastSeen: 1, reviewCount: 1 }),
      tags: ['observation', 'auto-discovered'] })

    const reflector = new Reflector(dummyLLM)
    const result = reflector.validateSynthesis('syn1', spaceId)
    expect(result.alignedObservations).toBe(1)  // obs1 → stable
    expect(result.contradictedObservations).toBe(1)  // obs2 → stale
  })

  it('calculates novelty score from uncovered children', () => {
    insertBubble({ id: 'syn2', type: 'synthesis' })
    const c1 = insertBubble({ id: 'nc1', type: 'memory' })
    const c2 = insertBubble({ id: 'nc2', type: 'memory' })
    const c3 = insertBubble({ id: 'nc3', type: 'memory' })
    links.addLink('syn2', c1, 'composed_of', 1.0, 'system')
    links.addLink('syn2', c2, 'composed_of', 1.0, 'system')
    links.addLink('syn2', c3, 'composed_of', 1.0, 'system')

    // Observation only covers c1 and c2
    insertBubble({ id: 'obs3', type: 'observation', abstraction_level: 1,
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: ['nc1', 'nc2'], evidenceCount: 2, firstSeen: 1, lastSeen: 1, reviewCount: 1 }),
      tags: ['observation', 'auto-discovered'] })

    const reflector = new Reflector(dummyLLM)
    const result = reflector.validateSynthesis('syn2', spaceId)
    // childIds = {nc1, nc2, nc3}, allEvidenceIds = {nc1, nc2}
    // novelChildren = {nc3}.length = 1, noveltyScore = 1/3 ≈ 0.333
    expect(result.alignedObservations).toBe(1)
    expect(result.noveltyScore).toBeCloseTo(1 / 3, 2)
  })
})

// ── discover ──────────────────────────────────────────────────────

describe('discover', () => {
  it('fewer than 3 memories returns 0', async () => {
    vi.spyOn(model, 'findBubblesByType').mockReturnValue([
      makeBubble('m1'),
      makeBubble('m2'),
    ])

    const reflector = new Reflector(dummyLLM) as unknown as { discover(s?: string): Promise<number> }
    const result = await reflector.discover(spaceId)
    expect(result).toBe(0)
  })

  it('LLM finds pattern → creates observation and evidence links', async () => {
    // Seed real bubbles in DB so findBubblesByType finds them
    insertBubble({ id: 'm1', type: 'memory', tags: ['finance'], content: 'Q1 report completed' })
    insertBubble({ id: 'm2', type: 'memory', tags: ['finance'], content: 'Q2 report started' })
    insertBubble({ id: 'm3', type: 'memory', tags: ['finance'], content: 'Q2 report completed' })
    // searchBubbles for findExistingObservation returns empty
    vi.spyOn(model, 'searchBubbles').mockReturnValue([])
    // Mock createBubble to return a known ID (avoid FK issues with real addLink)
    vi.spyOn(model, 'createBubble').mockReturnValue({ id: 'new-obs' })
    vi.spyOn(links, 'addLink').mockReturnValue(undefined)

    const llm = makeMockLLM({
      found: true,
      title: '财务报告模式',
      content: '用户有定期生成财务报告的模式',
      evidenceIndices: [0, 1, 2],
      confidence: 0.7,
    })

    const reflector = new Reflector(llm) as unknown as { discover(s?: string): Promise<number> }
    const result = await reflector.discover(spaceId)

    expect(result).toBe(1)
    expect(model.createBubble).toHaveBeenCalledWith(expect.objectContaining({
      type: 'observation',
      title: '财务报告模式',
    }))
    // evidence_for links for each evidence (m1, m2, m3)
    expect(links.addLink).toHaveBeenCalledWith('new-obs', 'm1', 'evidence_for', 1.0, 'system')
    expect(links.addLink).toHaveBeenCalledWith('new-obs', 'm2', 'evidence_for', 1.0, 'system')
    expect(links.addLink).toHaveBeenCalledWith('new-obs', 'm3', 'evidence_for', 1.0, 'system')
  })

  it('draft mode calls createDraft instead of createBubble', async () => {
    insertBubble({ id: 'm1', type: 'memory', tags: ['topic'], content: '相关内容1' })
    insertBubble({ id: 'm2', type: 'memory', tags: ['topic'], content: '相关内容2' })
    insertBubble({ id: 'm3', type: 'memory', tags: ['topic'], content: '相关内容3' })
    vi.spyOn(model, 'searchBubbles').mockReturnValue([])

    const llm = makeMockLLM({
      found: true,
      title: '测试模式',
      content: '这是一个测试模式',
      evidenceIndices: [0, 1, 2],
      confidence: 0.7,
    })

    const reflector = new Reflector(llm)
    reflector.setDraftMode(true)
    const spyCreateBubble = vi.spyOn(model, 'createBubble')

    const result = await (reflector as unknown as { discover(s?: string): Promise<number> }).discover(spaceId)

    expect(result).toBe(1)
    expect(createDraft).toHaveBeenCalled()
    expect(spyCreateBubble).not.toHaveBeenCalled()
  })
})

// ── validate ──────────────────────────────────────────────────────

describe('validate', () => {
  it('no new memories since last validation skips LLM calls', async () => {
    insertBubble({ id: 'm1', type: 'memory', created_at: Date.now() - 60000 })
    const spyFind = vi.spyOn(model, 'findBubblesByType')

    const reflector = new Reflector(dummyLLM) as unknown as { lastValidatedAt: number; validate(s?: string): Promise<{ validated: number; staled: number }> }
    reflector.lastValidatedAt = Date.now()

    const result = await reflector.validate(spaceId)
    expect(result).toEqual({ validated: 0, staled: 0 })
    expect(spyFind).not.toHaveBeenCalled()
  })

  it('marks stale observation when lastSeen exceeds 30 days', async () => {
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000
    insertBubble({ id: 'obs1', type: 'observation', abstraction_level: 1,
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: [], evidenceCount: 0, firstSeen: thirtyOneDaysAgo, lastSeen: thirtyOneDaysAgo, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'] })
    vi.spyOn(model, 'updateBubble')

    const reflector = new Reflector(dummyLLM) as unknown as { validate(s?: string): Promise<{ validated: number; staled: number }> }
    const result = await reflector.validate(spaceId)

    expect(result.staled).toBe(1)
    expect(result.validated).toBe(0)
    expect(model.updateBubble).toHaveBeenCalledWith('obs1', expect.objectContaining({
      metadata: expect.objectContaining({ trend: 'stale' }),
    }))
  })

  it('LLM re-evaluation updates trend and confidence', async () => {
    // Seed the observation in DB and the new-memory bubble (for link FK)
    insertBubble({ id: 'obs1', type: 'observation', abstraction_level: 1,
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: ['e1'], evidenceCount: 1, firstSeen: Date.now() - 86400000, lastSeen: Date.now() - 86400000, reviewCount: 0 }),
      tags: ['observation', 'auto-discovered'], confidence: 0.8 })
    insertBubble({ id: 'new-m1', type: 'memory', content: '新记忆' })
    vi.spyOn(model, 'updateBubble')
    vi.spyOn(model, 'searchBubbles').mockReturnValue([
      makeBubble('new-m1', { type: 'memory', createdAt: Date.now() - 3600000, content: '新记忆' }),
    ])
    vi.spyOn(links, 'findLinksByRelation').mockReturnValue([])

    const llm = makeMockLLM({
      newTrend: 'strengthening',
      reason: '新记忆支持观察',
      newEvidenceIndices: [0],
    })

    const reflector = new Reflector(llm) as unknown as { validate(s?: string): Promise<{ validated: number; staled: number }> }
    const result = await reflector.validate(spaceId)

    expect(result.validated).toBe(1)
    expect(result.staled).toBe(0)
    expect(model.updateBubble).toHaveBeenCalledWith('obs1', expect.objectContaining({
      confidence: 0.9, // 0.8 + 0.1 = strengthening boost
      metadata: expect.objectContaining({ trend: 'strengthening' }),
    }))
  })
})

// ── run ───────────────────────────────────────────────────────────

describe('run', () => {
  it('executes full discover→validate cycle', async () => {
    // Seed memories for discover phase
    insertBubble({ id: 'm1', type: 'memory', tags: ['finance'], content: '数据1' })
    insertBubble({ id: 'm2', type: 'memory', tags: ['finance'], content: '数据2' })
    insertBubble({ id: 'm3', type: 'memory', tags: ['finance'], content: '数据3' })
    // Seed observation for validate phase
    const now = Date.now()
    insertBubble({ id: 'obs1', type: 'observation', abstraction_level: 1,
      content: '已有内容',
      tags: ['observation', 'auto-discovered'],
      metadata: JSON.stringify({ trend: 'stable', evidenceIds: ['e1'], evidenceCount: 1, firstSeen: now - 86400000, lastSeen: now - 86400000, reviewCount: 1 }),
      confidence: 0.8 })

    vi.spyOn(model, 'searchBubbles').mockReturnValue([])
    vi.spyOn(model, 'createBubble').mockReturnValue({ id: 'new-obs' })
    vi.spyOn(links, 'addLink').mockReturnValue(undefined)

    const llm = makeSequentialLLM(
      JSON.stringify({ found: true, title: '财务模式', content: '定期财务报告模式', evidenceIndices: [0, 1, 2], confidence: 0.7 }),
      JSON.stringify({ newTrend: 'stable', reason: '无关', newEvidenceIndices: [] }),
    )

    const reflector = new Reflector(llm)
    const result = await reflector.run(spaceId)

    expect(result.discovered).toBe(1)
    expect(result.validated).toBe(0) // no new memories for validate (searchBubbles returns [])
    expect(result.staled).toBe(0)
  })
})
