import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('../src/kernel/external-prompts.js', () => ({
  buildExternalSystemPrompt: vi.fn(() => '外部系统提示'),
}))

vi.mock('../src/connector/biz/space-profile.js', () => ({
  getSpaceProfile: vi.fn(),
}))

vi.mock('../src/shared/tokens.js', () => ({
  estimateTokens: vi.fn(() => 100),
  TOKEN_LIMITS: {},
}))

vi.mock('../src/memory/manager.js', () => ({
  MemoryManager: vi.fn(),
}))

vi.mock('../src/memory/working-memory.js', () => ({
  WorkingMemory: vi.fn(),
}))

vi.mock('../src/memory/context-budget.js', () => ({
  ContextBudget: vi.fn(),
}))

import {
  BASE_SYSTEM_PROMPT,
  CRITIQUE_PROMPT,
  CRITIQUE_MIN_LENGTH,
  COMPACTION_PROMPT,
  COMPACTION_THRESHOLD,
  COMPACTION_KEEP_RECENT,
  buildSystemPrompt,
  type BuildSystemPromptOptions,
} from '../src/kernel/prompts.js'
import { buildExternalSystemPrompt } from '../src/kernel/external-prompts.js'
import { getSpaceProfile } from '../src/connector/biz/space-profile.js'

// ── Constants ────────────────────────────────────────────────────

describe('prompt constants', () => {
  it('BASE_SYSTEM_PROMPT contains core identity', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('Bubble Agent')
    expect(BASE_SYSTEM_PROMPT).toContain('认知底色')
    expect(BASE_SYSTEM_PROMPT).toContain('自我质疑')
  })

  it('CRITIQUE_PROMPT contains review criteria', () => {
    expect(CRITIQUE_PROMPT).toContain('批判性审查')
    expect(CRITIQUE_PROMPT).toContain('PASS')
    expect(CRITIQUE_PROMPT).toContain('自我审视')
  })

  it('COMPACTION_PROMPT contains summary instructions', () => {
    expect(COMPACTION_PROMPT).toContain('对话摘要')
    expect(COMPACTION_PROMPT).toContain('500 字以内')
  })

  it('numeric constants have expected values', () => {
    expect(CRITIQUE_MIN_LENGTH).toBe(300)
    expect(COMPACTION_THRESHOLD).toBe(24)
    expect(COMPACTION_KEEP_RECENT).toBe(6)
  })
})

// ── buildSystemPrompt ────────────────────────────────────────────

function makeOpts(overrides: Partial<BuildSystemPromptOptions> = {}): BuildSystemPromptOptions {
  return {
    isExt: false,
    ctx: undefined,
    activeAgent: null,
    toolDesc: '',
    memory: null,
    userInput: 'hello',
    userId: 'user-1',
    memoryBudget: 500,
    workingMemory: null,
    contextBudget: null,
    now: '2026-05-22T10:00:00Z',
    ...overrides,
  }
}

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses external system prompt when isExt and ctx are provided', async () => {
    const opts = makeOpts({
      isExt: true,
      ctx: { externalUserId: 'ext-1', role: 'supplier', isExternal: true } as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(buildExternalSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ externalUserId: 'ext-1' }),
    )
    expect(result.systemContent).toContain('外部系统提示')
  })

  it('uses agent system prompt when activeAgent is set', async () => {
    const opts = makeOpts({
      activeAgent: { systemPrompt: '你是自定义Agent' } as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(result.systemContent).toContain('你是自定义Agent')
    expect(result.systemContent).toContain('当前时间：2026-05-22T10:00:00Z')
  })

  it('uses BASE_SYSTEM_PROMPT when no activeAgent and not external', async () => {
    const opts = makeOpts()

    const result = await buildSystemPrompt(opts)

    expect(result.systemContent).toContain('Bubble Agent')
    expect(result.systemContent).toContain('当前时间：2026-05-22T10:00:00Z')
  })

  it('includes space profile when ctx has activeSpaceId', async () => {
    vi.mocked(getSpaceProfile).mockReturnValue('\n\nSpace profile content')

    const opts = makeOpts({
      ctx: { activeSpaceId: 'space-1' } as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(getSpaceProfile).toHaveBeenCalledWith('space-1')
    expect(result.systemContent).toContain('Space profile content')
  })

  it('does not include space profile when getSpaceProfile returns null', async () => {
    vi.mocked(getSpaceProfile).mockReturnValue(null)

    const opts = makeOpts({
      ctx: { activeSpaceId: 'space-1' } as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(getSpaceProfile).toHaveBeenCalledWith('space-1')
    // Should not crash — just skip
  })

  it('includes memory context when memory and memoryBudget > 1000', async () => {
    const mockMemory = {
      getContextForQuery: vi.fn().mockResolvedValue({
        context: '\n\n记忆上下文',
        sources: [{ bubbleId: 'b1', title: '记忆' }],
      }),
    }

    const opts = makeOpts({
      userInput: '帮我查资料',
      userId: 'user-1',
      memoryBudget: 2000,
      memory: mockMemory as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(mockMemory.getContextForQuery).toHaveBeenCalledWith(
      '帮我查资料', undefined, 'user-1', 2000,
    )
    expect(result.systemContent).toContain('记忆上下文')
    expect(result.sources).toEqual([{ bubbleId: 'b1', title: '记忆' }])
  })

  it('skips memory context when memoryBudget is small', async () => {
    const mockMemory = {
      getContextForQuery: vi.fn(),
    }

    const opts = makeOpts({
      memory: mockMemory as any,
      memoryBudget: 500,
    })

    await buildSystemPrompt(opts)

    expect(mockMemory.getContextForQuery).not.toHaveBeenCalled()
  })

  it('includes working memory when both workingMemory and contextBudget exist', async () => {
    const mockWorkingMemory = {
      demoteStaleItems: vi.fn(),
      getHotItems: vi.fn().mockReturnValue([
        { bubbleId: 'wm-1', priorityScore: 0.9, pinned: true },
      ]),
    }
    const mockContextBudget = {
      formatForSystemPrompt: vi.fn().mockReturnValue('\n\nWorking memory status'),
    }

    const opts = makeOpts({
      userInput: 'hi',
      userId: 'user-1',
      workingMemory: mockWorkingMemory as any,
      contextBudget: mockContextBudget as any,
    })

    const result = await buildSystemPrompt(opts)

    expect(mockWorkingMemory.demoteStaleItems).toHaveBeenCalledWith('user-1')
    expect(mockWorkingMemory.getHotItems).toHaveBeenCalledWith('user-1')
    expect(mockContextBudget.formatForSystemPrompt).toHaveBeenCalledWith(
      'user-1',
      [{ title: 'wm-1', relevance: 0.9, pinned: true }],
    )
    expect(result.systemContent).toContain('Working memory status')
  })

  it('returns correct result shape with fixedTokens', async () => {
    const opts = makeOpts({ toolDesc: '\n\n工具描述' })

    const result = await buildSystemPrompt(opts)

    expect(result).toHaveProperty('systemContent')
    expect(result).toHaveProperty('sources')
    expect(result).toHaveProperty('fixedTokens')
    expect(typeof result.fixedTokens).toBe('number')
  })
})
