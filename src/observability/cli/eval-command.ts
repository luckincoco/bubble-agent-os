/**
 * CLI eval command — displays eval results and system health.
 *
 * Usage:
 *   bubble eval                     — show latest eval summary
 *   bubble eval --type observation  — show observation eval details
 *   bubble eval --type health       — show system health
 *   bubble eval --type causal       — show causal accuracy
 *   bubble eval --history 7         — show 7-day trend
 */

import { getLatestEvals, getEvalHistory, getRecentTraces, getTraceSpans } from '../queries.js'
import type { ObservationSurvivalScore, CausalAccuracyScore, SystemHealthScore, EvalType } from '../types.js'

export function runEvalCommand(args: string[]): void {
  const typeArg = getArgValue(args, '--type')
  const historyDays = parseInt(getArgValue(args, '--history') || '0')
  const traceId = getArgValue(args, '--trace')

  if (traceId) {
    showTrace(traceId)
    return
  }

  if (historyDays > 0 && typeArg) {
    showHistory(typeArg as EvalType, historyDays)
    return
  }

  if (typeArg) {
    showTypedEval(typeArg)
    return
  }

  showSummary()
}

function showSummary(): void {
  const evals = getLatestEvals()

  if (evals.size === 0) {
    console.log('\n  [Eval] 暂无评估数据。系统需要运行一段时间后才会产生评估结果。\n')
    return
  }

  console.log('')

  const obs = evals.get('observation_survival')
  if (obs) {
    const s = obs.scores as ObservationSurvivalScore
    const date = new Date(obs.runAt).toLocaleDateString('zh-CN')
    console.log(`  === Observation Eval (${date}) ===`)
    console.log(`    发现: ${s.totalDiscovered} | 稳定: ${s.reachedStable} | 腐化: ${s.reachedStale} | 活跃中: ${s.currentActive}`)
    console.log(`    存活率: ${(s.survivalRate * 100).toFixed(1)}%  平均寿命: ${s.avgLifespanDays} 天`)
    console.log('')
  }

  const health = evals.get('system_health')
  if (health) {
    const s = health.scores as SystemHealthScore
    console.log(`  === System Health ===`)
    console.log(`    Token 利用率: ${(s.avgTokenUtilization * 100).toFixed(0)}% | 日消耗: ~${s.dailyTokenConsumption.toLocaleString()} tokens`)
    console.log(`    LLM 延迟: p50=${s.llmLatencyP50}ms  p95=${s.llmLatencyP95}ms`)
    console.log(`    调度任务成功率: ${(s.taskSuccessRate * 100).toFixed(0)}%`)
    console.log(`    压缩比: ${s.compactionReductionRatio}:1`)
    console.log('')
  }

  const causal = evals.get('causal_accuracy')
  if (causal) {
    const s = causal.scores as CausalAccuracyScore
    console.log(`  === Causal Accuracy ===`)
    console.log(`    总判定: ${s.totalVerdicts}`)
    console.log(`    矛盾精度: ${(s.contradictionPrecision * 100).toFixed(0)}%  确认精度: ${(s.confirmationPrecision * 100).toFixed(0)}%`)
    console.log('')
  }
}

function showTypedEval(type: string): void {
  const evalType = resolveEvalType(type)
  if (!evalType) {
    console.log(`  未知类型: ${type}。可选: observation, health, causal`)
    return
  }

  const evals = getLatestEvals()
  const entry = evals.get(evalType)

  if (!entry) {
    console.log(`\n  [${evalType}] 暂无数据\n`)
    return
  }

  console.log(`\n  === ${evalType} (${new Date(entry.runAt).toLocaleString('zh-CN')}) ===`)
  console.log(`  样本数: ${entry.sampleSize}`)
  console.log(`  详情:`)
  for (const [k, v] of Object.entries(entry.scores)) {
    console.log(`    ${k}: ${v}`)
  }
  console.log('')
}

function showHistory(type: string, days: number): void {
  const evalType = resolveEvalType(type)
  if (!evalType) {
    console.log(`  未知类型: ${type}`)
    return
  }

  const history = getEvalHistory(evalType, days)
  if (history.length === 0) {
    console.log(`\n  最近 ${days} 天无 ${evalType} 数据\n`)
    return
  }

  console.log(`\n  === ${evalType} 趋势 (${days} 天) ===`)
  for (const entry of history) {
    const date = new Date(entry.runAt).toLocaleDateString('zh-CN')
    const key = evalType === 'observation_survival' ? 'survivalRate'
      : evalType === 'system_health' ? 'llmLatencyP50'
      : 'contradictionPrecision'
    const val = (entry.scores as Record<string, unknown>)[key]
    console.log(`    ${date}: ${key}=${val}  (n=${entry.sampleSize})`)
  }
  console.log('')
}

function showTrace(traceId: string): void {
  const traces = getRecentTraces(undefined, 100)
  const trace = traces.find(t => t.id === traceId || t.id.startsWith(traceId))

  if (!trace) {
    console.log(`\n  Trace ${traceId} 未找到\n`)
    return
  }

  console.log(`\n  === Trace ${trace.id} ===`)
  console.log(`    类型: ${trace.trace_type}`)
  console.log(`    时间: ${new Date(trace.started_at).toLocaleString('zh-CN')}`)
  console.log(`    耗时: ${trace.duration_ms}ms`)
  console.log(`    状态: ${trace.status}`)

  const spans = getTraceSpans(trace.id)
  if (spans.length > 0) {
    console.log(`    Spans (${spans.length}):`)
    for (const span of spans) {
      const tokens = span.input_tokens || span.output_tokens
        ? ` [${span.input_tokens ?? '?'}→${span.output_tokens ?? '?'} tokens]`
        : ''
      console.log(`      ${span.span_type}/${span.name}: ${span.duration_ms}ms (${span.status})${tokens}`)
    }
  }
  console.log('')
}

function resolveEvalType(type: string): EvalType | null {
  const map: Record<string, EvalType> = {
    observation: 'observation_survival',
    obs: 'observation_survival',
    health: 'system_health',
    system: 'system_health',
    causal: 'causal_accuracy',
  }
  return map[type] ?? null
}

function getArgValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx >= 0 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return undefined
}
