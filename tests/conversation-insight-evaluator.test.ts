import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationInsightEvaluator } from '../src/memory/conversation-insight-evaluator.js'
import type { LLMProvider } from '../src/shared/types.js'

let tmpDir: string

/** A deterministic fake LLM for testing insights. */
function makeFakeLLM(responseJson: string): LLMProvider {
  return {
    async chat() {
      return { content: `some text ${responseJson} more text` }
    },
    async chatStream(_messages, onChunk) {
      const content = `some text ${responseJson} more text`
      onChunk(content)
      return { content }
    },
  }
}

describe('ConversationInsightEvaluator — insightScore', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'bubble-test-insight-'))
    initDatabase(tmpDir, 'test-password-123')

    const db = getDatabase()
    const now = Date.now()
    db.prepare('INSERT OR IGNORE INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run('test-space', '测试空间', '', now)
  })

  afterAll(() => {
    closeDatabase()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('短回复跳过（长度 < 200）', async () => {
    const llm = makeFakeLLM('{}')
    const evaluator = new ConversationInsightEvaluator(llm)
    const result = await evaluator.evaluate('你好', '你好', 'test-space')
    expect(result).toBe(0)
  })

  it('无 insight 时返回 0', async () => {
    const llm = makeFakeLLM('{"hasInsight":false,"candidates":[]}')
    const evaluator = new ConversationInsightEvaluator(llm)
    const result = await evaluator.evaluate('查一下价格', '这是一段足够长的回复内容用于测试洞察评估功能是否能正确处理无洞察的情况。', 'test-space')
    expect(result).toBe(0)
  })

  it('多个候选洞察正确计算 insightScore', async () => {
    const llm = makeFakeLLM(
      '{"hasInsight":true,"candidates":[' +
        '{"title":"用户偏好","content":"用户对螺纹钢价格敏感，偏好低价时采购，这是一个值得长期跟踪的偏好特征","tags":["偏好","钢价"],"sourceType":"synthesis"},' +
        '{"title":"供应商模式","content":"该供应商通常在月初报价较低，月末提价，形成周期性报价模式","tags":["供应商","模式"],"sourceType":"observation"},' +
        '{"title":"质量疑问","content":"客户反馈的热卷质量是否稳定？这需要进一步确认","tags":["质量","疑问"],"sourceType":"question"}' +
      ']}',
    )
    const evaluator = new ConversationInsightEvaluator(llm)
    // response length > 200
    const response = '基于历史数据分析和对话记录，我对用户的需求做了综合评估。' +
      '用户对螺纹钢价格非常敏感，多次选择在价格低位时下达采购订单。' +
      '该供应商的报价模式也值得注意——通常在月初有较好的价格，月末则会提价。' +
      '此外，客户最近提到的热卷质量问题也需要进一步跟踪确认。' +
      '从长期趋势来看，螺纹钢价格受环保政策和原材料成本影响较大。' +
      '需要持续关注政策动向和库存变化，这将有助于更准确地判断价格走势。' +
      '同时也要注意，不同供应商的报价策略存在差异，不能一概而论。' +
      '建议建立供应商评级体系，综合评估价格、质量、交期等多个维度。'
    const result = await evaluator.evaluate('帮我分析一下供应商情况', response, 'test-space')
    // synthesis(1.0) + observation(0.7) + question(0.5) = 2.2
    expect(result).toBe(3)
  })
})
