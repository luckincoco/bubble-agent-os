import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { TeachRecord } from '../src/connector/teach/parser.js'

const { mockCreateBubble, mockUpdateBubble, mockSearchBubbles, mockAddLink } = vi.hoisted(() => ({
  mockCreateBubble: vi.fn(),
  mockUpdateBubble: vi.fn(),
  mockSearchBubbles: vi.fn(),
  mockAddLink: vi.fn(),
}))

vi.mock('../src/bubble/model.js', () => ({
  createBubble: mockCreateBubble,
  updateBubble: mockUpdateBubble,
  searchBubbles: mockSearchBubbles,
}))
vi.mock('../src/bubble/links.js', () => ({
  addLink: mockAddLink,
}))

import { TeachStore } from '../src/connector/teach/store.js'

function makeRecord(overrides: Partial<TeachRecord> = {}): TeachRecord {
  return {
    action: 'remember',
    entityName: '供应商A',
    entityType: 'supplier',
    attribute: undefined,
    value: undefined,
    factText: '供应商A主营螺纹钢',
    tags: ['螺纹钢'],
    rawInput: '泡泡记住: 供应商A主营螺纹钢',
    ...overrides,
  }
}

describe('TeachStore', () => {
  let store: TeachStore

  beforeEach(() => {
    vi.clearAllMocks()
    store = new TeachStore()
  })

  it('creates instance with store and setEmbeddingProvider methods', () => {
    expect(store).toBeInstanceOf(TeachStore)
    expect(typeof store.store).toBe('function')
    expect(typeof store.setEmbeddingProvider).toBe('function')
  })

  it('remember action creates pinned entity bubble and returns confirmation', async () => {
    mockCreateBubble.mockReturnValue({ id: 'bubble-1' })
    mockSearchBubbles.mockReturnValue([])

    const result = await store.store(makeRecord())

    expect(result.bubbleId).toBe('bubble-1')
    expect(result.action).toBe('remember')
    expect(result.confirmation).toContain('已记住')
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'entity',
        title: '知识: 供应商A',
        pinned: true,
        source: 'teach',
      }),
    )
  })

  it('remember action includes attribute in title when present', async () => {
    mockCreateBubble.mockReturnValue({ id: 'b-1' })
    mockSearchBubbles.mockReturnValue([])

    await store.store(makeRecord({ attribute: '联系人', value: '张三' }))

    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({ title: '知识: 供应商A - 联系人' }),
    )
  })

  it('update action expires old matching bubbles', async () => {
    mockCreateBubble.mockReturnValue({ id: 'bubble-new' })
    mockSearchBubbles.mockReturnValue([
      { id: 'old-1', type: 'entity', pinned: true, tags: ['供应商A'],
        metadata: { source: 'teach' } },
    ])

    const result = await store.store(makeRecord({ action: 'update' }))

    expect(result.expired).toEqual(['old-1'])
    expect(mockUpdateBubble).toHaveBeenCalledWith('old-1', { pinned: false })
    expect(result.confirmation).toContain('已替换 1 条旧记录')
  })

  it('update with attribute only expires matching attribute', async () => {
    mockCreateBubble.mockReturnValue({ id: 'b-new' })
    mockSearchBubbles.mockReturnValue([
      { id: 'attr-matches', type: 'entity', pinned: true, tags: ['供应商A'],
        metadata: { source: 'teach', attribute: '联系人' } },
      { id: 'attr-differs', type: 'entity', pinned: true, tags: ['供应商A'],
        metadata: { source: 'teach', attribute: '电话' } },
    ])

    await store.store(makeRecord({ action: 'update', attribute: '联系人' }))

    expect(mockUpdateBubble).toHaveBeenCalledWith('attr-matches', { pinned: false })
    expect(mockUpdateBubble).not.toHaveBeenCalledWith('attr-differs', expect.anything())
  })

  it('forget action unpins matching bubbles with high decayRate', async () => {
    mockSearchBubbles.mockReturnValue([
      { id: 'card-1', type: 'entity', pinned: true, tags: ['供应商A'],
        metadata: { source: 'teach' } },
    ])

    const result = await store.store(makeRecord({ action: 'forget' }))

    expect(result.expired).toEqual(['card-1'])
    expect(mockUpdateBubble).toHaveBeenCalledWith('card-1', { pinned: false, decayRate: 0.5 })
    expect(result.confirmation).toContain('已遗忘')
  })

  it('forget with no matching bubbles returns not-found message', async () => {
    mockSearchBubbles.mockReturnValue([])

    const result = await store.store(makeRecord({ action: 'forget' }))

    expect(result.expired).toEqual([])
    expect(result.confirmation).toContain('没有找到')
    expect(result.bubbleId).toBe('')
  })

  it('calls embed when embedding provider is set', async () => {
    const mockEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3])
    store.setEmbeddingProvider({ embed: mockEmbed } as any)
    mockCreateBubble.mockReturnValue({ id: 'b-1' })
    mockSearchBubbles.mockReturnValue([])

    await store.store(makeRecord())

    expect(mockEmbed).toHaveBeenCalledWith('供应商A主营螺纹钢')
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: [0.1, 0.2, 0.3] }),
    )
  })

  it('handles embedding failure gracefully', async () => {
    const mockEmbed = vi.fn().mockRejectedValue(new Error('API error'))
    store.setEmbeddingProvider({ embed: mockEmbed } as any)
    mockCreateBubble.mockReturnValue({ id: 'b-1' })
    mockSearchBubbles.mockReturnValue([])

    // Should not throw
    await store.store(makeRecord())

    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({ embedding: undefined }),
    )
  })

  it('auto-links to existing related bubbles', async () => {
    mockCreateBubble.mockReturnValue({ id: 'b-new' })
    mockSearchBubbles.mockReturnValue([
      { id: 'related-1', type: 'entity', pinned: true, tags: ['供应商A'],
        metadata: { source: 'teach' } },
      { id: 'related-2', type: 'observation', pinned: true, tags: ['供应商A', '螺纹钢'],
        metadata: {} },
    ])

    await store.store(makeRecord())

    // addLink is called for related bubbles with matching tags
    expect(mockAddLink).toHaveBeenCalled()
  })

  it('passes spaceId to searchBubbles and createBubble', async () => {
    mockCreateBubble.mockReturnValue({ id: 'b-1' })
    mockSearchBubbles.mockReturnValue([])

    await store.store(makeRecord(), 'space-42')

    expect(mockSearchBubbles).toHaveBeenCalledWith(
      expect.any(String), expect.any(Number), ['space-42'],
    )
    expect(mockCreateBubble).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: 'space-42' }),
    )
  })
})
