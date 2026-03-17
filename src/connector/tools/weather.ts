import type { ToolDefinition } from '../registry.js'

export function createWeatherTool(): ToolDefinition {
  return {
    name: 'get_weather',
    description: '查询指定城市的当前天气',
    parameters: {
      city: { type: 'string', description: '城市名称（如 上海、北京）', required: true },
    },
    async execute(args) {
      const city = args.city as string
      if (!city) return 'Error: city is required'

      // wttr.in free weather API, no key needed
      const res = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`)
      if (!res.ok) return `Weather API error: ${res.status}`

      const data = await res.json() as any
      const current = data.current_condition?.[0]
      if (!current) return `No weather data for ${city}`

      const desc = current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || ''
      return `${city}天气: ${desc}, 温度${current.temp_C}°C, 体感${current.FeelsLikeC}°C, 湿度${current.humidity}%`
    },
  }
}
