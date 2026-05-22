import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock dependencies ────────────────────────────────────────────

vi.mock('../src/observability/tracer.js', () => ({
  TraceContext: vi.fn(),
}))

import { runToolLoop } from '../src/kernel/tool-loop.js'
import type { LLMProvider } from '../src/shared/types.js'
import type { ToolRegistry } from '../src/connector/registry.js'

// ── Helpers ──────────────────────────────────────────────────────

function makeLLM(): LLMProvider {
  return {
    chat: vi.fn() as any,
    chatStream: vi.fn() as any,
  } as LLMProvider
}

function makeToolRegistry(): ToolRegistry {
  return {
    get: vi.fn(),
    execute: vi.fn(),
  } as unknown as ToolRegistry
}

// ── runToolLoop ──────────────────────────────────────────────────

describe('runToolLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns response with no tool calls when LLM has none', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValue({
      content: '你好，有什么可以帮你的？',
      usage: { promptTokens: 50, completionTokens: 20 },
    })
    const tools = makeToolRegistry()

    const result = await runToolLoop(
      [{ role: 'user', content: 'hi' }],
      { llm, tools },
    )

    expect(result.response).toBe('你好，有什么可以帮你的？')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.trace.iterations).toBe(0)
    expect(result.trace.steps).toHaveLength(0)
  })

  it('executes a single tool call and returns result', async () => {
    const llm = makeLLM()
    // First LLM call returns a tool call
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '[TOOL_CALL: get_time] {}',
      usage: { promptTokens: 50, completionTokens: 10 },
    })
    // Second LLM call (after tool result) returns final text
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '当前时间是 14:30。',
      usage: { promptTokens: 70, completionTokens: 15 },
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'get_time', execute: vi.fn() } as any)
    vi.mocked(tools.execute).mockResolvedValue('{"time": "14:30"}')

    const result = await runToolLoop(
      [{ role: 'user', content: '现在几点？' }],
      { llm, tools },
    )

    expect(result.response).toBe('当前时间是 14:30。')
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('get_time')
    expect(result.toolCalls[0].result).toBe('{"time": "14:30"}')
    expect(result.trace.iterations).toBe(1)
    expect(result.trace.steps).toHaveLength(1)
    expect(tools.execute).toHaveBeenCalledWith('get_time', {}, undefined)
  })

  it('safety valve breaks on same tool called 3 times consecutively', async () => {
    const llm = makeLLM()
    // Both calls return the same tool call (simulating repeat)
    vi.mocked(llm.chat).mockResolvedValue({
      content: '[TOOL_CALL: search] {"q":"test"}',
      usage: { promptTokens: 50, completionTokens: 10 },
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'search', execute: vi.fn() } as any)
    vi.mocked(tools.execute).mockResolvedValue('搜索结果')

    const result = await runToolLoop(
      [{ role: 'user', content: '搜索' }],
      { llm, tools },
    )

    // Safety valve fires when sameToolCount >= 2 (3rd same call in a row)
    // i=0: first call, lastToolName='', sameToolCount stays 0 → execute
    // i=1: second call, matches lastToolName, sameToolCount=1 → execute
    // i=2: third call, matches, sameToolCount=2 → break
    // Result: iterationCount=3
    expect(result.trace.iterations).toBe(3)
  })

  it('stops when MAX_ITERATIONS is reached', async () => {
    const llm = makeLLM()
    // Alternate tool names to avoid safety valve
    // Need 1 initial + 5 loop iterations = 6 resolves
    const toolNames = ['tool_a', 'tool_b', 'tool_c', 'tool_d', 'tool_e', 'tool_f']
    toolNames.forEach((name) => {
      vi.mocked(llm.chat).mockResolvedValueOnce({
        content: `[TOOL_CALL: ${name}] {}`,
        usage: { promptTokens: 50, completionTokens: 10 },
      })
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'tool', execute: vi.fn() } as any)
    vi.mocked(tools.execute).mockResolvedValue('result')

    const result = await runToolLoop(
      [{ role: 'user', content: 'loop' }],
      { llm, tools },
    )

    // MAX_ITERATIONS = 5, so after 5 iterations it exits the for loop
    expect(result.trace.iterations).toBe(5)
  })

  it('captures tool execution errors gracefully', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '[TOOL_CALL: fail_tool] {}',
      usage: { promptTokens: 50, completionTokens: 10 },
    })
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '工具执行出错。',
      usage: { promptTokens: 70, completionTokens: 10 },
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'fail_tool', execute: vi.fn() } as any)
    vi.mocked(tools.execute).mockRejectedValue(new Error('连接超时'))

    const result = await runToolLoop(
      [{ role: 'user', content: 'do it' }],
      { llm, tools },
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].name).toBe('fail_tool')
    expect(result.toolCalls[0].result).toContain('Error')
    expect(result.toolCalls[0].result).toContain('连接超时')
    expect(result.trace.steps[0].error).toBe('连接超时')
  })

  it('supports stream mode with onChunk callback', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chatStream).mockResolvedValue({
      content: '流式回复',
      usage: { promptTokens: 50, completionTokens: 20 },
    })

    const tools = makeToolRegistry()
    const onChunk = vi.fn()

    const result = await runToolLoop(
      [{ role: 'user', content: 'stream' }],
      { llm, tools, onChunk },
    )

    // When onChunk is provided, should call chatStream instead of chat
    expect(llm.chatStream).toHaveBeenCalled()
    expect(llm.chat).not.toHaveBeenCalled()
    expect(result.response).toBe('流式回复')
  })

  it('passes traceContext to trace spans', async () => {
    const mockSpan = { end: vi.fn() }
    const traceContext = {
      startSpan: vi.fn(() => mockSpan),
    } as any

    const llm = makeLLM()
    // Return no tool call on first call so it doesn't loop further
    // (we only need to verify the initial LLM call span)
    vi.mocked(llm.chat).mockResolvedValue({
      content: '直接回复',
      usage: { promptTokens: 50, completionTokens: 20 },
    })

    const tools = makeToolRegistry()

    const result = await runToolLoop(
      [{ role: 'user', content: 'hi' }],
      { llm, tools, traceContext },
    )

    // Should have created and ended the initial LLM call span
    expect(traceContext.startSpan).toHaveBeenCalledWith('llm_call', 'initial')
    expect(mockSpan.end).toHaveBeenCalledWith('ok', expect.objectContaining({
      inputTokens: 50,
      outputTokens: 20,
    }))
  })

  it('executes multiple tool calls in a single iteration', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '先查一下\n[TOOL_CALL: search] {"q":"hello"}\n再算一下\n[TOOL_CALL: calc] {"expr":"1+1"}',
      usage: { promptTokens: 50, completionTokens: 20 },
    })
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '结果如上',
      usage: { promptTokens: 100, completionTokens: 10 },
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'tool', execute: vi.fn() } as any)
    vi.mocked(tools.execute).mockResolvedValue('ok')

    const result = await runToolLoop(
      [{ role: 'user', content: '帮我查和算' }],
      { llm, tools },
    )

    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0].name).toBe('search')
    expect(result.toolCalls[1].name).toBe('calc')
    expect(tools.execute).toHaveBeenCalledTimes(2)
  })

  it('handles tool timeouts gracefully', async () => {
    const llm = makeLLM()
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '[TOOL_CALL: slow_tool] {}',
      usage: { promptTokens: 50, completionTokens: 10 },
    })
    vi.mocked(llm.chat).mockResolvedValueOnce({
      content: '工具超时',
      usage: { promptTokens: 70, completionTokens: 10 },
    })

    const tools = makeToolRegistry()
    vi.mocked(tools.get).mockReturnValue({ name: 'slow_tool', timeout: 50 } as any)
    // Never resolves — will timeout
    vi.mocked(tools.execute).mockReturnValue(new Promise(() => {}) as any)

    const result = await runToolLoop(
      [{ role: 'user', content: 'slow' }],
      { llm, tools },
    )

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].result).toContain('Error')
    expect(result.toolCalls[0].result).toContain('timeout')
  })
})
