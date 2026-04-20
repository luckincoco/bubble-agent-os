import type { LLMProvider, LLMMessage, UserContext } from '../shared/types.js'
import type { ToolRegistry } from '../connector/registry.js'
import { logger } from '../shared/logger.js'

const TOOL_CALL_REGEX = /\[TOOL_CALL:\s*(\w+)\]\s*(\{[^}]*\})?/g
const MAX_ITERATIONS = 5
const TOOL_TIMEOUT_MS = 30_000

interface ToolLoopOptions {
  llm: LLMProvider
  tools: ToolRegistry
  ctx?: UserContext
  onChunk?: (text: string) => void
}

export interface ToolLoopResult {
  response: string
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: string }>
  trace: ToolTrace
}

export interface ToolTraceStep {
  tool: string
  durationMs: number
  resultLength: number
  error?: string
}

export interface ToolTrace {
  totalDurationMs: number
  iterations: number
  steps: ToolTraceStep[]
}

/**
 * Multi-step tool calling loop, inspired by OpenAI Agents SDK Runner Loop.
 *
 * The initial LLM call is performed internally. On each iteration:
 * 1. Parse tool calls from LLM output
 * 2. Execute tools in parallel (with timeout)
 * 3. Append results to message history
 * 4. Call LLM again
 *
 * Stops when LLM returns no tool calls or MAX_ITERATIONS is reached.
 */
export async function runToolLoop(
  messages: LLMMessage[],
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const { llm, tools, ctx, onChunk } = opts
  const allToolCalls: ToolLoopResult['toolCalls'] = []
  const traceSteps: ToolTraceStep[] = []
  const loopStart = Date.now()
  let lastToolName = ''
  let sameToolCount = 0
  let iterationCount = 0

  // Initial LLM call
  let result = onChunk
    ? await llm.chatStream(messages, onChunk)
    : await llm.chat(messages)
  let response = result.content

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const calls = parseToolCalls(response)
    if (calls.length === 0) break
    iterationCount++

    // Safety valve: break if the same single tool is called repeatedly
    if (calls.length === 1 && calls[0].name === lastToolName) {
      sameToolCount++
      if (sameToolCount >= 2) {
        logger.info(`ToolLoop: breaking - same tool "${lastToolName}" called ${sameToolCount + 1} times consecutively`)
        break
      }
    } else {
      sameToolCount = 0
    }
    lastToolName = calls.length === 1 ? calls[0].name : ''

    logger.debug(`ToolLoop: iteration ${i + 1}, executing ${calls.length} tool(s): ${calls.map(c => c.name).join(', ')}`)

    // Execute all tool calls in parallel with timeout and tracing
    const results = await Promise.all(
      calls.map(async (call) => {
        const stepStart = Date.now()
        try {
          const toolResult = await executeWithTimeout(
            tools.execute(call.name, call.args, ctx),
            TOOL_TIMEOUT_MS,
          )
          traceSteps.push({ tool: call.name, durationMs: Date.now() - stepStart, resultLength: toolResult.length })
          return { ...call, result: toolResult }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error(`ToolLoop: ${call.name} failed: ${msg}`)
          traceSteps.push({ tool: call.name, durationMs: Date.now() - stepStart, resultLength: 0, error: msg })
          return { ...call, result: `Error: ${msg}` }
        }
      }),
    )

    allToolCalls.push(...results)

    // Append LLM response + tool results to message history
    messages.push({ role: 'assistant', content: response })
    for (const r of results) {
      messages.push({
        role: 'user',
        content: `[TOOL_RESULT: ${r.name}] ${r.result}`,
      })
    }

    // Call LLM again with updated history
    result = onChunk
      ? await llm.chatStream(messages, onChunk)
      : await llm.chat(messages)
    response = result.content
  }

  const trace: ToolTrace = {
    totalDurationMs: Date.now() - loopStart,
    iterations: iterationCount,
    steps: traceSteps,
  }

  if (traceSteps.length > 0) {
    logger.info(`ToolLoop trace: ${iterationCount} iterations, ${traceSteps.length} tool calls, ${trace.totalDurationMs}ms total | ${traceSteps.map(s => `${s.tool}(${s.durationMs}ms)`).join(', ')}`)
  }

  return { response, toolCalls: allToolCalls, trace }
}

function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  TOOL_CALL_REGEX.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = TOOL_CALL_REGEX.exec(text)) !== null) {
    try {
      const args = match[2] ? JSON.parse(match[2]) : {}
      calls.push({ name: match[1], args })
    } catch {
      logger.debug(`ToolLoop: failed to parse args for ${match[1]}`)
    }
  }
  return calls
}

function executeWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool timeout (${ms}ms)`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}
