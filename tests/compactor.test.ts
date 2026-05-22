import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BubbleCompactor } from '../src/memory/compactor.js'
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

import * as model from '../src/bubble/model.js'
import * as links from '../src/bubble/links.js'

const dummyLLM: LLMProvider = { chat: vi.fn(), chatStream: vi.fn() }

let tmpDir: string
let spaceId: string

function makeBubble(id: string, overrides: Partial<Bubble> = {}): Bubble {
  return {
    id, type: 'memory', title: '', content: 'test content',
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

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-cmp-'))
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

// ── computeTemperature ───────────────────────────────────────────

describe('computeTemperature', () => {
  function computeTemp(bubbles: Bubble[]): number {
    const c = new BubbleCompactor(dummyLLM) as unknown as { computeTemperature(b: Bubble[]): number }
    return c.computeTemperature(bubbles)
  }

  it('default base temperature with enough candidates', () => {
    const bubbles = Array.from({ length: 10 }, (_, i) =>
      makeBubble(`b${i}`, { confidence: 0.7, createdAt: Date.now() }),
    )
    const temp = computeTemp(bubbles)
    // BASE(0.3) + confAdjust(0) + densityAdjust(0: 10 <= 50, not < 10) + ageAdjust(0)
    expect(temp).toBe(0.3)
  })

  it('low average confidence raises temperature', () => {
    const bubbles = Array.from({ length: 10 }, (_, i) =>
      makeBubble(`b${i}`, { confidence: 0.3, createdAt: Date.now() }),
    )
    const temp = computeTemp(bubbles)
    expect(temp).toBeGreaterThan(0.3)
    expect(temp).toBeLessThanOrEqual(0.55)
  })

  it('wide time spread lowers temperature', () => {
    const now = Date.now()
    const bubbles = Array.from({ length: 10 }, (_, i) =>
      makeBubble(`b${i}`, { confidence: 0.7, createdAt: now - (i < 5 ? 0 : 60 * 86400000) }),
    )
    const temp = computeTemp(bubbles)
    // BASE(0.3) + confAdjust(0) + densityAdjust(0: 10 not < 10) + ageAdjust(-0.05)
    expect(temp).toBe(0.25)
  })
})

// ── computeQualityBonus ──────────────────────────────────────────

describe('computeQualityBonus', () => {
  function qualityBonus(a: Bubble, b: Bubble, signals?: Map<string, { validated: boolean; observationTrend: string; observationConfidence: number }>): number {
    const c = new BubbleCompactor(dummyLLM) as unknown as { qualitySignals: Map<string, unknown>; computeQualityBonus(a: Bubble, b: Bubble): number }
    if (signals) c.qualitySignals = signals as unknown as Map<string, unknown>
    return c.computeQualityBonus(a, b)
  }

  it('no signals returns 0', () => {
    const result = qualityBonus(makeBubble('a'), makeBubble('b'))
    expect(result).toBe(0)
  })

  it('both strengthening adds +0.1', () => {
    const signals = new Map()
    signals.set('a', { validated: true, observationTrend: 'strengthening', observationConfidence: 0.8 })
    signals.set('b', { validated: true, observationTrend: 'strengthening', observationConfidence: 0.8 })
    const result = qualityBonus(makeBubble('a'), makeBubble('b'), signals)
    expect(result).toBe(0.1)
  })

  it('weakening reduces bonus', () => {
    const signals = new Map()
    signals.set('a', { validated: true, observationTrend: 'weakening', observationConfidence: 0.5 })
    signals.set('b', { validated: true, observationTrend: 'strengthening', observationConfidence: 0.8 })
    const result = qualityBonus(makeBubble('a'), makeBubble('b'), signals)
    // +0.1 requires BOTH strengthening; a is weakening → only -0.05 applies
    expect(result).toBe(-0.05)
  })
})

// ── pairSimilarity ───────────────────────────────────────────────

describe('pairSimilarity', () => {
  function pairSim(a: Bubble, b: Bubble, neighbors?: Map<string, Set<string>>): number {
    const c = new BubbleCompactor(dummyLLM) as unknown as {
      qualitySignals: Map<string, unknown>
      pairSimilarity(a: Bubble, b: Bubble, neighborSets: Map<string, Set<string>>): number
    }
    const ns = neighbors ?? new Map()
    return c.pairSimilarity(a, b, ns)
  }

  it('tag Jaccard similarity contributes 0.35 weight', () => {
    const a = makeBubble('a', { tags: ['x', 'y'] })
    const b = makeBubble('b', { tags: ['x', 'y'] })
    // tagSim = 2/2 = 1.0, graphSim = 0, timeSim depends
    const sim = pairSim(a, b)
    // 0.35 * 1.0 + 0 + 0.15 * timeSim + 0.15 * (0.5 + 0)
    const timeSim = Math.exp(0) // same createdAt → exp(0) = 1
    const expected = 0.35 + 0.15 * timeSim + 0.15 * 0.5
    expect(sim).toBeCloseTo(expected, 2)
  })

  it('graph link adds 0.35 when direct neighbor', () => {
    const a = makeBubble('a', { tags: [] })
    const b = makeBubble('b', { tags: [] })
    const ns = new Map()
    ns.set(a.id, new Set([b.id]))
    const sim = pairSim(a, b, ns)
    expect(sim).toBeGreaterThan(0.3)
  })

  it('no tags and no graph link gives baseline', () => {
    const a = makeBubble('a', { tags: [], createdAt: 1000 })
    const b = makeBubble('b', { tags: [], createdAt: 100000000000 }) // far future
    const sim = pairSim(a, b)
    // tagSim=0, graphSim=0, timeSim≈0, quality=0.5
    const expected = 0.15 * 0.5 // 0.075
    expect(sim).toBeCloseTo(expected, 2)
  })
})

// ── splitByTag ───────────────────────────────────────────────────

describe('splitByTag', () => {
  function splitBy(bubbles: Bubble[]): Bubble[][] {
    const c = new BubbleCompactor(dummyLLM) as unknown as { splitByTag(b: Bubble[]): Bubble[][] }
    return c.splitByTag(bubbles)
  }

  it('splits by most balanced tag', () => {
    const bubbles = [
      makeBubble('b1', { tags: ['a', 'b'] }),
      makeBubble('b2', { tags: ['a'] }),
      makeBubble('b3', { tags: ['b'] }),
      makeBubble('b4', { tags: ['b'] }),
    ]
    const groups = splitBy(bubbles)
    // 'a' appears in 2, 'b' appears in 3. balance: |2 - 2| = 0 vs |3 - 2| = 1
    // 'a' is more balanced (0 < 1), so split by 'a' → with a: [b1, b2], without a: [b3, b4]
    expect(groups.length).toBe(2)
    expect(groups[0].length).toBe(2)
    expect(groups[1].length).toBe(2)
  })

  it('no tags splits by midpoint', () => {
    const bubbles = [
      makeBubble('b1', { tags: [] }),
      makeBubble('b2', { tags: [] }),
      makeBubble('b3', { tags: [] }),
    ]
    const groups = splitBy(bubbles)
    expect(groups.length).toBe(2)
    expect(groups[0].length).toBe(2)
    expect(groups[1].length).toBe(1)
  })
})

// ── computeContributionWeights ───────────────────────────────────

describe('computeContributionWeights', () => {
  function contribWeights(bubbles: Bubble[]): Map<string, number> {
    const c = new BubbleCompactor(dummyLLM) as unknown as { computeContributionWeights(b: Bubble[]): Map<string, number> }
    return c.computeContributionWeights(bubbles)
  }

  it('normalizes weights by confidence sum', () => {
    const bubbles = [
      makeBubble('a', { confidence: 0.3 }),
      makeBubble('b', { confidence: 0.7 }),
    ]
    const w = contribWeights(bubbles)
    expect(w.get('a')).toBeCloseTo(0.3, 2)
    expect(w.get('b')).toBeCloseTo(0.7, 2)
    expect(w.get('a')! + w.get('b')!).toBeCloseTo(1.0, 2)
  })

  it('equal weights when all confidences are same', () => {
    const bubbles = [
      makeBubble('a', { confidence: 0.5 }),
      makeBubble('b', { confidence: 0.5 }),
    ]
    const w = contribWeights(bubbles)
    expect(w.get('a')).toBe(0.5)
    expect(w.get('b')).toBe(0.5)
  })
})

// ── buildCluster ─────────────────────────────────────────────────

describe('buildCluster', () => {
  function build(clusterBubbles: Bubble[], allBubbles: Bubble[], neighbors?: Map<string, Set<string>>) {
    const c = new BubbleCompactor(dummyLLM) as unknown as {
      buildCluster(cb: Bubble[], ab: Bubble[], ns: Map<string, Set<string>>): { bubbles: Bubble[]; sharedTags: string[]; cohesionScore: number }
    }
    return c.buildCluster(clusterBubbles, allBubbles, neighbors ?? new Map())
  }

  it('tags present in >50% become sharedTags', () => {
    const bubbles = [
      makeBubble('a', { tags: ['tag1', 'tag2'] }),
      makeBubble('b', { tags: ['tag1', 'tag3'] }),
      makeBubble('c', { tags: ['tag1', 'tag2'] }),
    ]
    const cluster = build(bubbles, bubbles)
    // tag1: 3/3=100% > 50%, tag2: 2/3=67% > 50%, tag3: 1/3=33% < 50%
    expect(cluster.sharedTags).toContain('tag1')
    expect(cluster.sharedTags).toContain('tag2')
    expect(cluster.sharedTags).not.toContain('tag3')
  })

  it('cohesion score is average pairwise similarity', () => {
    const bubbles = [
      makeBubble('a', { tags: ['x'], createdAt: Date.now() }),
      makeBubble('b', { tags: ['x'], createdAt: Date.now() }),
      makeBubble('c', { tags: ['x'], createdAt: Date.now() }),
    ]
    const cluster = build(bubbles, bubbles)
    expect(cluster.cohesionScore).toBeGreaterThan(0)
  })
})

// ── findClusters ─────────────────────────────────────────────────

describe('findClusters', () => {
  it('less than MIN_CLUSTER_SIZE returns empty', () => {
    const c = new BubbleCompactor(dummyLLM)
    const result = c.findClusters([makeBubble('a'), makeBubble('b')], 0.3)
    expect(result).toHaveLength(0)
  })

  it('produces clusters from similar bubbles', () => {
    // Bubbles with shared tag 'x' and no graph links — tag Jaccard = 1.0
    const bubbles = [
      makeBubble('a', { tags: ['x'], createdAt: Date.now() }),
      makeBubble('b', { tags: ['x'], createdAt: Date.now() }),
      makeBubble('c', { tags: ['x'], createdAt: Date.now() }),
      makeBubble('d', { tags: ['y'], createdAt: Date.now() }), // different tag
    ]
    const c = new BubbleCompactor(dummyLLM)
    const result = c.findClusters(bubbles, 0.3)
    // a,b,c have tag x (high similarity) → one cluster
    // d has tag y (different) → no cluster (only 1 bubble)
    expect(result.length).toBeGreaterThanOrEqual(1)
    // Verify at least one cluster has the x-tagged bubbles
    const xCluster = result.find(cl =>
      cl.bubbles.some(b => b.id === 'a') &&
      cl.bubbles.some(b => b.id === 'b') &&
      cl.bubbles.some(b => b.id === 'c'),
    )
    expect(xCluster).toBeDefined()
  })

  it('large cluster is split by tag', () => {
    // 13 bubbles with MAX_CLUSTER_SIZE = 12 → triggers splitByTag
    const bubbles = Array.from({ length: 13 }, (_, i) =>
      makeBubble(`b${i}`, { tags: ['shared'], createdAt: Date.now() + i * 1000 }),
    )
    const c = new BubbleCompactor(dummyLLM)
    const result = c.findClusters(bubbles, 0.3)
    // After findClusters, some clusters should exist with the split bubbles
    expect(result.length).toBeGreaterThan(0)
  })
})

// ── accelerateDecay ──────────────────────────────────────────────

describe('accelerateDecay', () => {
  function accel(
    children: Bubble[],
    weights: Map<string, number>,
    hasContradictions: boolean,
    negations: Array<{ sourceIndex: number; sourceId: string; absorbed: boolean; reason?: string }>,
  ) {
    const c = new BubbleCompactor(dummyLLM) as unknown as {
      accelerateDecay(children: Bubble[], weights: Map<string, number>, hasContradictions: boolean, negations: Array<{ sourceIndex: number; sourceId: string; absorbed: boolean; reason?: string }>): void
    }
    c.accelerateDecay(children, weights, hasContradictions, negations)
  }

  it('non-absorbed children get decay rate reduction (protection)', () => {
    vi.spyOn(model, 'updateBubble')
    const child = makeBubble('a', { decayRate: 0.1 })
    const negations = [{ sourceIndex: 0, sourceId: 'a', absorbed: false, reason: '偏离模式' }]
    accel([child], new Map([['a', 0.5]]), false, negations)
    // Non-absorbed: newRate = 0.1 * 0.8 = 0.08
    expect(model.updateBubble).toHaveBeenCalledWith('a', { decayRate: expect.closeTo(0.08, 5) })
  })

  it('absorbed children get decay rate increase (acceleration)', () => {
    vi.spyOn(model, 'updateBubble')
    const child = makeBubble('a', { decayRate: 0.1 })
    accel([child], new Map([['a', 0.2]]), false, [])
    // Absorbed: factor = 3.0 / (1 + 0.2 * 4.0) = 3.0 / 1.8 ≈ 1.667
    // newRate = 0.1 * 1.667 ≈ 0.167 (different from 0.1 → updateBubble called)
    expect(model.updateBubble).toHaveBeenCalledWith('a', { decayRate: expect.closeTo(0.1667, 3) })
  })

  it('contradictions halve acceleration factor', () => {
    vi.spyOn(model, 'updateBubble')
    const child = makeBubble('a', { decayRate: 0.1 })
    accel([child], new Map([['a', 0.2]]), true, [])
    // Without contradictions: factor = 3.0 / (1 + 0.2 * 4.0) ≈ 1.667
    // With contradictions: factor = 1.667 / 2 ≈ 0.833
    // newRate = 0.1 * 0.833 ≈ 0.0833
    expect(model.updateBubble).toHaveBeenCalledWith('a', { decayRate: expect.closeTo(0.0833, 3) })
  })
})

// ── abstractCluster ──────────────────────────────────────────────

describe('abstractCluster', () => {
  function abstractCluster(
    cluster: { bubbles: Bubble[]; sharedTags: string[]; cohesionScore: number },
    targetLevel: 1 | 2,
    temperature: number,
    llm?: LLMProvider,
  ) {
    const c = new BubbleCompactor(llm ?? dummyLLM) as unknown as {
      abstractCluster(cl: { bubbles: Bubble[]; sharedTags: string[]; cohesionScore: number }, tl: 1 | 2, temp: number): Promise<Bubble | null>
    }
    return c.abstractCluster(cluster, targetLevel, temperature)
  }

  it('cross-space cluster returns null', async () => {
    const cluster = {
      bubbles: [
        makeBubble('a', { spaceId: 'space-1' }),
        makeBubble('b', { spaceId: 'space-2' }),
      ],
      sharedTags: ['x'],
      cohesionScore: 0.5,
    }
    const result = await abstractCluster(cluster, 1, 0.3)
    expect(result).toBeNull()
  })

  it('LLM produces synthesis bubble and links', async () => {
    // Seed child bubbles for FK constraints
    insertBubble({ id: 'c1', type: 'memory', tags: ['data'], content: '数据1', abstraction_level: 0 })
    insertBubble({ id: 'c2', type: 'memory', tags: ['data'], content: '数据2', abstraction_level: 0 })
    insertBubble({ id: 'c3', type: 'memory', tags: ['data'], content: '数据3', abstraction_level: 0 })

    const cluster = {
      bubbles: [
        makeBubble('c1', { tags: ['data'], content: '数据1', spaceId }),
        makeBubble('c2', { tags: ['data'], content: '数据2', spaceId }),
        makeBubble('c3', { tags: ['data'], content: '数据3', spaceId }),
      ],
      sharedTags: ['data'],
      cohesionScore: 0.6,
    }

    vi.spyOn(model, 'createBubble').mockReturnValue({ id: 'new-syn' })
    vi.spyOn(links, 'addLink').mockReturnValue(undefined)

    const llm = makeMockLLM({
      title: '数据趋势',
      content: '用户持续记录数据，形成分析模式',
      tags: ['analysis'],
      confidence: 0.8,
      negations: [
        { index: 0, absorbed: true },
        { index: 1, absorbed: true },
        { index: 2, absorbed: false, reason: '数据3偏离主趋势' },
      ],
    })

    const result = await abstractCluster(cluster, 1, 0.3, llm)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('new-syn')
    expect(model.createBubble).toHaveBeenCalledWith(expect.objectContaining({
      type: 'synthesis',
      abstractionLevel: 1,
    }))
    // composed_of links
    expect(links.addLink).toHaveBeenCalledWith('new-syn', 'c1', 'composed_of', expect.any(Number), 'system')
    expect(links.addLink).toHaveBeenCalledWith('new-syn', 'c2', 'composed_of', expect.any(Number), 'system')
    expect(links.addLink).toHaveBeenCalledWith('new-syn', 'c3', 'composed_of', expect.any(Number), 'system')
  })

  it('LLM returns missing title returns null', async () => {
    const cluster = {
      bubbles: [makeBubble('a', { spaceId }), makeBubble('b', { spaceId }), makeBubble('c', { spaceId })],
      sharedTags: ['x'],
      cohesionScore: 0.5,
    }
    const llm = makeMockLLM({ content: '一些文本', confidence: 0.5 }) // no title
    const result = await abstractCluster(cluster, 1, 0.3, llm)
    expect(result).toBeNull()
  })
})

// ── compact ──────────────────────────────────────────────────────

describe('compact', () => {
  it('short-circuit returns empty result when no new L0 bubbles', async () => {
    const compactor = new BubbleCompactor(dummyLLM) as unknown as { lastCompactedAt: number; compact(s?: string): Promise<{ synthesized: number; portrayed: number; clustersFound: number; skipped: number; newBubbleIds: string[] }> }
    compactor.lastCompactedAt = Date.now() + 86400000 // future

    const result = await compactor.compact(spaceId)
    expect(result.synthesized).toBe(0)
    expect(result.skipped).toBe(0)
  })

  it('L0→L1 synthesis with seeded bubbles and LLM', async () => {
    // Seed L0 bubbles (abstraction_level=0) not linked as composed_of
    insertBubble({ id: 'l0-1', type: 'memory', tags: ['price', 'steel'], content: '钢价上涨', abstraction_level: 0 })
    insertBubble({ id: 'l0-2', type: 'memory', tags: ['price', 'steel'], content: '钢价波动', abstraction_level: 0 })
    insertBubble({ id: 'l0-3', type: 'memory', tags: ['price', 'steel'], content: '钢价回落', abstraction_level: 0 })

    vi.spyOn(model, 'createBubble').mockReturnValue({ id: 'syn-1' })
    vi.spyOn(links, 'addLink').mockReturnValue(undefined)
    vi.spyOn(model, 'updateBubble').mockReturnValue(true)

    const llm = makeMockLLM({
      title: '钢材价格趋势',
      content: '钢材价格呈现波动性变化，有涨有跌',
      tags: ['price', 'steel'],
      confidence: 0.75,
      negations: [
        { index: 0, absorbed: true },
        { index: 1, absorbed: true },
        { index: 2, absorbed: true },
      ],
    })

    const compactor = new BubbleCompactor(llm)
    const result = await compactor.compact(spaceId)

    expect(result.synthesized).toBeGreaterThanOrEqual(1)
    expect(result.newBubbleIds).toContain('syn-1')
  })

  it('L1→L2 portrait with abstracted bubbles', async () => {
    // Seed L1 bubbles (abstraction_level=1) for portrait phase
    insertBubble({ id: 'l1-1', type: 'synthesis', tags: ['portrait', 'decision'], content: '价格敏感型决策', abstraction_level: 1 })
    insertBubble({ id: 'l1-2', type: 'synthesis', tags: ['portrait', 'risk'], content: '风险规避倾向', abstraction_level: 1 })
    insertBubble({ id: 'l1-3', type: 'synthesis', tags: ['portrait', 'data'], content: '数据驱动习惯', abstraction_level: 1 })

    vi.spyOn(model, 'createBubble').mockReturnValue({ id: 'portrait-1' })
    vi.spyOn(links, 'addLink').mockReturnValue(undefined)
    vi.spyOn(model, 'updateBubble').mockReturnValue(true)

    const llm = makeMockLLM({
      title: '理性决策者',
      content: '用户是数据驱动的理性决策者，通过价格信号和风险评估做出采购决策',
      tags: ['portrait', 'decision'],
      confidence: 0.65,
      negations: [
        { index: 0, absorbed: true },
        { index: 1, absorbed: true },
        { index: 2, absorbed: true },
      ],
    })

    const compactor = new BubbleCompactor(llm)
    const result = await compactor.compact(spaceId)

    // L0 round finds 0 clusters (no L0 bubbles seeded), L1 finds 1 cluster → portrait
    expect(result.portrayed).toBeGreaterThanOrEqual(1)
    expect(result.newBubbleIds).toContain('portrait-1')
  })
})
