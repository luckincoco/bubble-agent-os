import type { ToolDefinition } from '../registry.js'

export function createTimeTool(): ToolDefinition {
  return {
    name: 'get_time',
    description: '获取当前日期和时间',
    parameters: {},
    async execute() {
      return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    },
  }
}
