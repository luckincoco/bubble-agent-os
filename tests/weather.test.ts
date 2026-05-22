import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createWeatherTool } from '../src/connector/tools/weather.js'

describe('createWeatherTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockWeatherResponse(data: any) {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(data), { status: 200 })
  }

  it('returns a ToolDefinition with name get_weather', () => {
    const tool = createWeatherTool()
    expect(tool.name).toBe('get_weather')
    expect(tool.parameters).toHaveProperty('city')
    expect(typeof tool.execute).toBe('function')
  })

  it('execute returns error when city is empty', async () => {
    const tool = createWeatherTool()
    const result = await tool.execute({ city: '' })
    expect(result).toContain('Error')
    expect(result).toContain('city is required')
  })

  it('execute parses weather response correctly', async () => {
    mockWeatherResponse({
      current_condition: [{
        temp_C: '25',
        FeelsLikeC: '27',
        humidity: '60',
        lang_zh: [{ value: '晴' }],
      }],
    })

    const tool = createWeatherTool()
    const result = await tool.execute({ city: '上海' })
    expect(result).toContain('上海')
    expect(result).toContain('25°C')
    expect(result).toContain('晴')
    expect(result).toContain('60%')
  })

  it('execute handles API error response', async () => {
    globalThis.fetch = async () => new Response('Not Found', { status: 404 })

    const tool = createWeatherTool()
    const result = await tool.execute({ city: 'Nowhere' })
    expect(result).toContain('Weather API error')
    expect(result).toContain('404')
  })

  it('execute handles missing weather data', async () => {
    mockWeatherResponse({ current_condition: [] })

    const tool = createWeatherTool()
    const result = await tool.execute({ city: '测试' })
    expect(result).toContain('No weather data')
  })
})
