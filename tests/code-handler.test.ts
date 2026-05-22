import { describe, it, expect } from 'vitest'
import { CodeHandler } from '../src/connector/skills/code-handler.js'

describe('CodeHandler', () => {
  it('handle returns handled: false and contextInjection', () => {
    const handler = new CodeHandler()
    const result = handler.handle('any skill body')
    expect(result.handled).toBe(false)
    expect(result.contextInjection).toBeTruthy()
  })

  it('contextInjection contains coding checklist', () => {
    const handler = new CodeHandler()
    const result = handler.handle('')
    expect(result.contextInjection).toContain('编码纪律')
    expect(result.contextInjection).toContain('检查点')
  })

  it('contextInjection mentions mandatory checkpoints', () => {
    const handler = new CodeHandler()
    const result = handler.handle('')
    expect(result.contextInjection).toContain('DEFINE')
    expect(result.contextInjection).toContain('PLAN')
    expect(result.contextInjection).toContain('BUILD')
    expect(result.contextInjection).toContain('VERIFY')
  })
})
