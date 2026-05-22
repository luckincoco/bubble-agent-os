import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SessionCompressor } from '../src/memory/session-compressor.js'
import type { LLMProvider, LLMMessage } from '../src/shared/types.js'

const mockCreateBubble = vi.fn()

vi.mock('../src/bubble/model.js', () => ({
  createBubble: (...args: unknown[]) => mockCreateBubble(...args),
}))

function mockLLM(response: string): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({ content: response }),
  } as unknown as LLMProvider
}

function makeMsgs(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `这是一条足够长的测试消息内容确保超过token估算阈值 ${i} 号消息重复填充数据直到足够长度`,
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateBubble.mockReturnValue({ id: 'mock-bubble' })
})

// ── 跳过条件 ──────────────────────────────────────────────────────

describe('compress — 跳过条件', () => {
  it('消息少于 4 条返回 null', async () => {
    const compressor = new SessionCompressor(mockLLM(''))
    const result = await compressor.compress('u1', makeMsgs(2))
    expect(result).toBeNull()
  })

  it('格式化后 token < 100 返回 null', async () => {
    const compressor = new SessionCompressor(mockLLM(''))
    // 4 very short messages → formatted tokens < 100
    const msgs: LLMMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'bye' },
    ]
    const result = await compressor.compress('u1', msgs)
    expect(result).toBeNull()
  })

  it('LLM 摘要长度 < 20 返回 null', async () => {
    const compressor = new SessionCompressor(mockLLM('short'))
    const result = await compressor.compress('u1', makeMsgs(10))
    expect(result).toBeNull()
  })

  it('LLM 抛异常返回 null', async () => {
    const llm = { chat: vi.fn().mockRejectedValue(new Error('LLM error')) } as unknown as LLMProvider
    const compressor = new SessionCompressor(llm)
    const result = await compressor.compress('u1', makeMsgs(10))
    expect(result).toBeNull()
  })
})

// ── 成功路径 ──────────────────────────────────────────────────────

describe('compress — 成功路径', () => {
  it('成功压缩并创建 synthesis bubble', async () => {
    const summary = '## 主题\n测试主题\n\n## 关键实体\n- 用户: 张三\n\n## 决策与结论\n- 无\n\n## 待办与未决\n- 无\n\n## 用户偏好\n- 无'
    const compressor = new SessionCompressor(mockLLM(summary))

    const result = await compressor.compress('u1', makeMsgs(10))

    expect(result).not.toBeNull()
    expect(result!.userId).toBe('u1')
    expect(result!.summary).toBe(summary)
    expect(result!.bubbleId).toBe('mock-bubble')
    expect(mockCreateBubble).toHaveBeenCalledWith(expect.objectContaining({
      type: 'synthesis',
      title: '测试主题',
      tags: ['session-summary', 'user:u1'],
      source: 'session_compression',
      confidence: 0.85,
      decayRate: 0.06,
    }))
  })

  it('## 主题 标题提取', async () => {
    const summary = '## 主题\n关于采购流程的讨论\n\n## 关键实体\n- ...'
    const compressor = new SessionCompressor(mockLLM(summary))

    await compressor.compress('u1', makeMsgs(10))
    expect(mockCreateBubble).toHaveBeenCalledWith(expect.objectContaining({
      title: '关于采购流程的讨论',
    }))
  })

  it('无 ## 主题 时使用日期回退标题', async () => {
    const summary = '无标题格式的摘要内容，足够长度超过二十个字确保通过条件判断'
    const compressor = new SessionCompressor(mockLLM(summary))

    await compressor.compress('u1', makeMsgs(10))
    expect(mockCreateBubble).toHaveBeenCalledWith(expect.objectContaining({
      title: expect.stringContaining('对话摘要'),
    }))
  })

  it('spaceId 透传给 createBubble', async () => {
    const summary = '## 主题\n测试\n\n## 关键实体\n- ...'
    const compressor = new SessionCompressor(mockLLM(summary))

    await compressor.compress('u1', makeMsgs(10), 'space-1')
    expect(mockCreateBubble).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-1',
    }))
  })
})

// ── 消息处理 ──────────────────────────────────────────────────────

describe('compress — 消息处理', () => {
  it('system 消息被过滤', async () => {
    const summary = '## 主题\n测试\n\n## 关键实体\n- ...'
    const compressor = new SessionCompressor(mockLLM(summary))

    const msgs: LLMMessage[] = [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好吗这是一段足够长的消息内容确保超过token估算阈值的填充数据' },
      { role: 'assistant', content: '我很好谢谢这是一段足够长的回复内容来满足token条件判断的填充' },
      { role: 'user', content: '再见这是一段足够长的消息内容确保超过token阈值不会导致skip' },
      { role: 'assistant', content: '好的这是一段足够长的回复内容来满足token条件判断不会被跳过' },
      { role: 'user', content: '还有一件事需要确认就是关于预算的审批流程目前的状态' },
    ]
    const result = await compressor.compress('u1', msgs)
    expect(result).not.toBeNull()
  })

  it('超长消息 (> 500 字符) 被截断', async () => {
    const summary = '## 主题\n测试\n\n## 关键实体\n- ...'
    const compressor = new SessionCompressor(mockLLM(summary))

    const msgs: LLMMessage[] = [
      { role: 'user', content: '这是一段足够长的中文消息内容用于测试截断功能' + 'x'.repeat(550) },
      { role: 'assistant', content: '这是一段足够长的中文回复内容用于验证截断功能是否正常工作' + 'y'.repeat(550) },
      { role: 'user', content: '正常消息用于确保整体token超过阈值不会被跳过' },
      { role: 'assistant', content: '正常回复消息用于验证压缩流程在混合场景下的行为是否正确' },
    ]
    const result = await compressor.compress('u1', msgs)
    expect(result).not.toBeNull()
  })
})
