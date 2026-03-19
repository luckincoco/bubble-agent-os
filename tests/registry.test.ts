import { describe, it, expect } from 'vitest'
import { ToolRegistry, type ToolDefinition } from '../src/connector/registry.js'

function makeTool(name: string, desc = 'test tool'): ToolDefinition {
  return {
    name,
    description: desc,
    parameters: {
      query: { type: 'string', description: 'search query', required: true },
    },
    execute: async () => `result from ${name}`,
  }
}

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry()
    const tool = makeTool('search', 'Search the web')
    registry.register(tool)

    expect(registry.get('search')).toBe(tool)
    expect(registry.get('nonexistent')).toBeUndefined()
  })

  it('lists all registered tools', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('tool_a'))
    registry.register(makeTool('tool_b'))
    registry.register(makeTool('tool_c'))

    const list = registry.list()
    expect(list).toHaveLength(3)
    expect(list.map(t => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c'])
  })

  it('executes tools correctly', async () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('echo'))

    const result = await registry.execute('echo', { query: 'test' })
    expect(result).toBe('result from echo')
  })

  it('returns error for unknown tools', async () => {
    const registry = new ToolRegistry()
    const result = await registry.execute('unknown', {})
    expect(result).toContain('Error')
    expect(result).toContain('unknown')
  })

  it('catches execution errors', async () => {
    const registry = new ToolRegistry()
    registry.register({
      name: 'failing',
      description: 'always fails',
      parameters: {},
      execute: async () => { throw new Error('boom') },
    })

    const result = await registry.execute('failing', {})
    expect(result).toContain('Error')
    expect(result).toContain('boom')
  })

  it('getToolDescriptions returns empty for no tools', () => {
    const registry = new ToolRegistry()
    expect(registry.getToolDescriptions()).toBe('')
  })

  it('getToolDescriptions lists all tools', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('weather', '查询天气'))
    registry.register(makeTool('time', '查询时间'))

    const desc = registry.getToolDescriptions()
    expect(desc).toContain('weather')
    expect(desc).toContain('time')
    expect(desc).toContain('TOOL_CALL')
  })

  it('getToolDescriptions with filter narrows results', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('weather'))
    registry.register(makeTool('time'))
    registry.register(makeTool('search'))

    const desc = registry.getToolDescriptions(['weather', 'search'])
    expect(desc).toContain('weather')
    expect(desc).toContain('search')
    expect(desc).not.toContain('- time')
  })

  it('getToolDescriptions with empty filter returns all (no filtering)', () => {
    const registry = new ToolRegistry()
    registry.register(makeTool('weather'))

    // Empty array has length 0 (falsy), so no filter is applied - returns all tools
    const desc = registry.getToolDescriptions([])
    expect(desc).toContain('weather')
  })
})
