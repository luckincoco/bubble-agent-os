import { describe, it, expect } from 'vitest'
import { createTimeTool } from '../src/connector/tools/time.js'

describe('createTimeTool', () => {
  it('returns a ToolDefinition with name get_time', () => {
    const tool = createTimeTool()
    expect(tool.name).toBe('get_time')
    expect(tool.description).toBeTruthy()
    expect(typeof tool.execute).toBe('function')
  })

  it('execute returns a zh-CN formatted date string', async () => {
    const tool = createTimeTool()
    const result = await tool.execute()
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(5)
  })

  it('execute output contains current year digits', async () => {
    const tool = createTimeTool()
    const result = await tool.execute()
    expect(result).toContain(String(new Date().getFullYear()))
  })
})
