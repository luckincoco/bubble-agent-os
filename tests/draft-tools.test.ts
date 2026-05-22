import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createDraftTools } from '../src/connector/tools/draft-tools.js'

const mockListDrafts = vi.hoisted(() => vi.fn())
const mockConfirmDraft = vi.hoisted(() => vi.fn())
const mockRejectDraft = vi.hoisted(() => vi.fn())

vi.mock('../src/memory/draft-observations.js', () => ({
  listDrafts: mockListDrafts,
  confirmDraft: mockConfirmDraft,
  rejectDraft: mockRejectDraft,
  countDrafts: vi.fn(),
}))

interface Draft {
  id: string
  createdAt: string
  source: string
  content: string
  context?: string
}

function makeDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: 'draft-1',
    createdAt: new Date(2026, 4, 22, 10, 0).toISOString(),
    source: 'auto',
    content: '这是一个观察草稿',
    ...overrides,
  }
}

describe('createDraftTools', () => {
  beforeEach(() => {
    mockListDrafts.mockReset()
    mockConfirmDraft.mockReset()
    mockRejectDraft.mockReset()
  })

  it('returns two tool definitions', () => {
    const tools = createDraftTools()
    expect(tools).toHaveLength(2)
    expect(tools[0].name).toBe('list_drafts')
    expect(tools[1].name).toBe('review_draft')
  })

  // ── list_drafts ───────────────────────────────────────

  it('list_drafts returns empty message when no drafts', async () => {
    mockListDrafts.mockReturnValue([])
    const tools = createDraftTools()
    const result = await tools[0].execute({}, { activeSpaceId: 'space-1' } as any)
    expect(result).toContain('没有待审核')
  })

  it('list_drafts formats draft list with index and date', async () => {
    mockListDrafts.mockReturnValue([
      makeDraft({ id: 'd1', content: '内容一' }),
      makeDraft({ id: 'd2', content: '内容二' }),
    ])
    const tools = createDraftTools()
    const result = await tools[0].execute({}, { activeSpaceId: 'space-1' } as any)
    expect(result).toContain('1.')
    expect(result).toContain('2.')
    expect(result).toContain('d1')
    expect(result).toContain('d2')
    expect(result).toContain('内容一')
    expect(result).toContain('内容二')
    expect(result).toContain('2 条')
  })

  it('list_drafts includes context when present', async () => {
    mockListDrafts.mockReturnValue([
      makeDraft({ content: '草稿', context: '相关背景' }),
    ])
    const tools = createDraftTools()
    const result = await tools[0].execute({}, { activeSpaceId: 'space-1' } as any)
    expect(result).toContain('背景')
    expect(result).toContain('相关背景')
  })

  it('list_drafts passes spaceId to listDrafts', async () => {
    mockListDrafts.mockReturnValue([])
    const tools = createDraftTools()
    await tools[0].execute({}, { activeSpaceId: 'my-space' } as any)
    expect(mockListDrafts).toHaveBeenCalledWith('my-space')
  })

  // ── review_draft ───────────────────────────────────────

  it('review_draft confirm calls confirmDraft', async () => {
    mockConfirmDraft.mockReturnValue('obs-1')
    const tools = createDraftTools()
    const result = await tools[1].execute({ draft_id: 'd1', action: 'confirm' }, {} as any)
    expect(mockConfirmDraft).toHaveBeenCalledWith('d1')
    expect(result).toContain('obs-1')
    expect(result).toContain('已确认')
  })

  it('review_draft confirm returns message when draft not found', async () => {
    mockConfirmDraft.mockReturnValue(null)
    const tools = createDraftTools()
    const result = await tools[1].execute({ draft_id: 'd1', action: 'confirm' }, {} as any)
    expect(result).toContain('未找到')
  })

  it('review_draft reject calls rejectDraft', async () => {
    mockRejectDraft.mockReturnValue(true)
    const tools = createDraftTools()
    const result = await tools[1].execute({ draft_id: 'd1', action: 'reject' }, {} as any)
    expect(mockRejectDraft).toHaveBeenCalledWith('d1')
    expect(result).toContain('已删除')
  })

  it('review_draft reject returns message when not found', async () => {
    mockRejectDraft.mockReturnValue(false)
    const tools = createDraftTools()
    const result = await tools[1].execute({ draft_id: 'd1', action: 'reject' }, {} as any)
    expect(result).toContain('未找到')
  })

  it('review_draft returns error for invalid action', async () => {
    const tools = createDraftTools()
    const result = await tools[1].execute({ draft_id: 'd1', action: 'invalid' }, {} as any)
    expect(result).toContain('必须是 confirm 或 reject')
  })
})
