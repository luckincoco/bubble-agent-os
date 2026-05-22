import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'

// ── vi.hoisted: shared mock objects ────────────────────────

const mockGetBubble = vi.hoisted(() => vi.fn())
const mockGetLinks = vi.hoisted(() => vi.fn())
const mockGetGraphSubset = vi.hoisted(() => vi.fn())
const mockBuildEvidenceChain = vi.hoisted(() => vi.fn())

// ── Module-level mocks ─────────────────────────────────────

vi.mock('../src/bubble/model.js', () => ({ getBubble: mockGetBubble }))
vi.mock('../src/bubble/links.js', () => ({
  getLinks: mockGetLinks,
  getGraphSubset: mockGetGraphSubset,
}))
vi.mock('../src/memory/evidence-chain.js', () => ({
  buildEvidenceChain: mockBuildEvidenceChain,
}))

// ── Imports ────────────────────────────────────────────────

import { registerKnowledgeRoutes } from '../src/server/knowledge-routes.js'
import type { UserContext } from '../src/shared/types.js'

// ════════════════════════════════════════════════════════════
//  registerKnowledgeRoutes
// ════════════════════════════════════════════════════════════

describe('registerKnowledgeRoutes', () => {
  const mockMemory = {
    getKnowledgeStats: vi.fn(),
    getKnowledgeIndex: vi.fn(),
    search: vi.fn(),
  }

  const defaultUserCtx: UserContext = {
    userId: 'test-user',
    spaceIds: ['space-1'],
    activeSpaceId: 'space-1',
  }

  const mockGetUserCtx = vi.fn(() => defaultUserCtx)

  function buildApp() {
    const app = Fastify()
    registerKnowledgeRoutes(app, {
      memory: mockMemory as any,
      getUserCtx: mockGetUserCtx,
    })
    return app
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetUserCtx.mockReturnValue(defaultUserCtx)
  })

  // ── GET /api/knowledge/stats ──────────────────────────────

  it('GET /stats calls memory.getKnowledgeStats', async () => {
    mockMemory.getKnowledgeStats.mockReturnValue({ total: 42 })
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/stats' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ total: 42 })
    expect(mockMemory.getKnowledgeStats).toHaveBeenCalledWith(['space-1'])
  })

  // ── GET /api/knowledge (index with filters) ──────────────

  it('GET / passes parsed filters to getKnowledgeIndex', async () => {
    mockMemory.getKnowledgeIndex.mockReturnValue({ bubbles: [], total: 0 })
    const app = buildApp()

    await app.inject({
      method: 'GET',
      url: '/api/knowledge?types=observation,reflection&tags=test&page=2&pageSize=10',
    })

    expect(mockMemory.getKnowledgeIndex).toHaveBeenCalledWith(
      ['space-1'],
      expect.objectContaining({
        types: ['observation', 'reflection'],
        tags: ['test'],
      }),
      2,
      10,
    )
  })

  it('GET / clamps pageSize to max 100', async () => {
    mockMemory.getKnowledgeIndex.mockReturnValue({ bubbles: [], total: 0 })
    const app = buildApp()

    await app.inject({
      method: 'GET',
      url: '/api/knowledge?pageSize=999',
    })

    expect(mockMemory.getKnowledgeIndex).toHaveBeenCalledWith(
      ['space-1'],
      expect.any(Object),
      1,
      100,
    )
  })

  // ── GET /api/knowledge/search ────────────────────────────

  it('GET /search returns 400 when q is missing', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/knowledge/search' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  it('GET /search with q calls memory.search', async () => {
    mockMemory.search.mockResolvedValue({ results: [] })
    const app = buildApp()

    await app.inject({
      method: 'GET',
      url: '/api/knowledge/search?q=steel+price&limit=10',
    })

    expect(mockMemory.search).toHaveBeenCalledWith(
      'steel price',
      10,
      ['space-1'],
      'test-user',
      expect.any(Object),
    )
  })

  // ── GET /api/knowledge/:id ───────────────────────────────

  it('GET /:id returns bubble and links when found', async () => {
    const fakeBubble = { id: 'b1', title: 'Test' }
    const fakeLinks = [{ sourceId: 'b1', targetId: 'b2' }]
    mockGetBubble.mockReturnValue(fakeBubble)
    mockGetLinks.mockReturnValue(fakeLinks)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/b1' })

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.payload)).toEqual({ bubble: fakeBubble, links: fakeLinks })
    expect(mockGetBubble).toHaveBeenCalledWith('b1', ['space-1'])
  })

  it('GET /:id returns 404 when bubble not found', async () => {
    mockGetBubble.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/missing' })

    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.payload)).toHaveProperty('error')
  })

  // ── GET /api/knowledge/:id/evidence ──────────────────────

  it('GET /:id/evidence calls buildEvidenceChain', async () => {
    mockGetBubble.mockReturnValue({ id: 'b1', createdAt: 1000 })
    mockBuildEvidenceChain.mockReturnValue({
      root: { id: 'b1' }, nodes: [], totalCount: 0,
      oldestEvidence: 1000, newestEvidence: 1000, sourceBreakdown: {},
    })
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/b1/evidence?maxDepth=3' })

    expect(res.statusCode).toBe(200)
    expect(mockBuildEvidenceChain).toHaveBeenCalledWith('b1', 3)
  })

  it('GET /:id/evidence returns 404 when bubble not found', async () => {
    mockGetBubble.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/missing/evidence' })

    expect(res.statusCode).toBe(404)
  })

  // ── GET /api/knowledge/:id/graph ─────────────────────────

  it('GET /:id/graph calls getGraphSubset', async () => {
    mockGetBubble.mockReturnValue({ id: 'b1' })
    mockGetGraphSubset.mockReturnValue({ nodes: [], edges: [] })
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/b1/graph?depth=2' })

    expect(res.statusCode).toBe(200)
    expect(mockGetGraphSubset).toHaveBeenCalledWith('b1', 2, 'space-1')
  })

  it('GET /:id/graph returns 404 when bubble not found', async () => {
    mockGetBubble.mockReturnValue(null)
    const app = buildApp()

    const res = await app.inject({ method: 'GET', url: '/api/knowledge/missing/graph' })

    expect(res.statusCode).toBe(404)
  })

  // ── spaceId filtering ────────────────────────────────────

  it('passes spaceId override when query includes spaceId', async () => {
    mockGetBubble.mockReturnValue({ id: 'b1' })
    mockGetGraphSubset.mockReturnValue({ nodes: [], edges: [] })
    mockGetUserCtx.mockImplementation((_req: any) => ({
      userId: 'test-user',
      spaceIds: ['space-1', 'space-2'],
      activeSpaceId: 'space-1',
    }))
    const app = buildApp()

    await app.inject({ method: 'GET', url: '/api/knowledge/b1/graph?spaceId=space-2' })

    expect(mockGetGraphSubset).toHaveBeenCalledWith('b1', 2, 'space-2')
  })
})
