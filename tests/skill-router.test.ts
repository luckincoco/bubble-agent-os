import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockCodeHandle = vi.fn()
vi.mock('../src/connector/skills/code-handler.js', () => ({
  CodeHandler: vi.fn(function() { return { handle: mockCodeHandle } }),
}))

import { SkillRouter } from '../src/connector/skills/skill-router.js'
import type { SkillDefinition } from '../src/connector/skills/loader.js'

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    priority: 10,
    handler: 'teach',
    compiledPatterns: [/test/],
    triggers: { keywords: [] },
    body: '',
    ...overrides,
  }
}

describe('SkillRouter', () => {
  const mockLoader = { getAllSkills: vi.fn() }
  const mockBizHandler = { tryHandle: vi.fn() }
  const mockTeachHandler = { tryHandle: vi.fn() }
  let router: SkillRouter

  beforeEach(() => {
    vi.clearAllMocks()
    mockCodeHandle.mockReturnValue({ contextInjection: '' })
    router = new SkillRouter(mockLoader as any, mockBizHandler as any, mockTeachHandler as any)
  })

  it('returns matched=false when no skills loaded', async () => {
    mockLoader.getAllSkills.mockReturnValue([])
    const result = await router.tryHandle('hello')
    expect(result.matched).toBe(false)
  })

  it('returns matched=false when no skills match the message', async () => {
    mockLoader.getAllSkills.mockReturnValue([makeSkill({ compiledPatterns: [/nomatch/] })])
    const result = await router.tryHandle('hello')
    expect(result.matched).toBe(false)
  })

  it('matches skill by compiled regex pattern and dispatches to teach handler', async () => {
    mockLoader.getAllSkills.mockReturnValue([makeSkill()])
    mockTeachHandler.tryHandle.mockResolvedValue({ handled: true, response: '已记住' })

    const result = await router.tryHandle('this is a test message')
    expect(result.matched).toBe(true)
    expect(result.handled).toBe(true)
    expect(result.response).toBe('已记住')
    expect(result.skill?.name).toBe('test-skill')
  })

  it('dispatches to biz-entry handler', async () => {
    mockLoader.getAllSkills.mockReturnValue([makeSkill({ handler: 'biz-entry' })])
    mockBizHandler.tryHandle.mockResolvedValue({ handled: true, response: '已记录' })

    const result = await router.tryHandle('test')
    expect(result.matched).toBe(true)
    expect(result.response).toBe('已记录')
  })

  it('returns contextInjection from code handler', async () => {
    mockLoader.getAllSkills.mockReturnValue([makeSkill({ handler: 'code', body: 'code body' })])
    mockCodeHandle.mockReturnValue({ contextInjection: '# 编码纪律' })

    const result = await router.tryHandle('test')
    expect(result.matched).toBe(true)
    expect(result.handled).toBe(false)
    expect(result.contextInjection).toBe('# 编码纪律')
  })

  it('tries next skill when handler returns not handled', async () => {
    mockLoader.getAllSkills.mockReturnValue([
      makeSkill({ name: 'skill-1', handler: 'teach', priority: 20 }),
      makeSkill({ name: 'skill-2', handler: 'teach', priority: 10 }),
    ])
    mockTeachHandler.tryHandle
      .mockResolvedValueOnce({ handled: false })
      .mockResolvedValueOnce({ handled: true, response: 'second' })

    const result = await router.tryHandle('test')
    expect(result.skill?.name).toBe('skill-2')
    expect(result.response).toBe('second')
  })

  it('sorts skills by priority descending', async () => {
    mockLoader.getAllSkills.mockReturnValue([
      makeSkill({ name: 'low', handler: 'teach', priority: 5 }),
      makeSkill({ name: 'high', handler: 'teach', priority: 15 }),
      makeSkill({ name: 'mid', handler: 'teach', priority: 10 }),
    ])
    mockTeachHandler.tryHandle.mockResolvedValue({ handled: true, response: 'ok' })

    const result = await router.tryHandle('test')
    expect(result.skill?.name).toBe('high')
  })

  it('returns matched=false when no biz handler configured', async () => {
    const routerNoBiz = new SkillRouter(mockLoader as any, undefined, mockTeachHandler as any)
    mockLoader.getAllSkills.mockReturnValue([makeSkill({ handler: 'biz-entry' })])

    const result = await routerNoBiz.tryHandle('test')
    expect(result.matched).toBe(false)
  })

  it('returns matched=false when no teach handler configured', async () => {
    const routerNoTeach = new SkillRouter(mockLoader as any, mockBizHandler as any)
    mockLoader.getAllSkills.mockReturnValue([makeSkill({ handler: 'teach' })])

    const result = await routerNoTeach.tryHandle('test')
    expect(result.matched).toBe(false)
  })

  it('matches by keyword when compiledPatterns does not match', async () => {
    mockLoader.getAllSkills.mockReturnValue([makeSkill({
      compiledPatterns: [], triggers: { keywords: ['keyword_match'] },
    })])

    const result = await router.tryHandle('this contains keyword_match')
    expect(result.matched).toBe(true)
  })
})
