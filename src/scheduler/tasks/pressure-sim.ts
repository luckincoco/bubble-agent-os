import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble, getBubble, findBubblesByType, searchBubbles } from '../../bubble/model.js'
import { BubbleCompactor } from '../../memory/compactor.js'
import { Reflector } from '../../memory/reflector.js'
import { SurpriseDetector } from '../../memory/surprise-detector.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import type { BubbleType } from '../../shared/types.js'

/**
 * Pressure Simulator — integration test for self-learning mechanisms.
 *
 * Injects synthetic data into a temporary space, runs compaction and
 * contradiction detection, then verifies that negation signals and
 * contradiction escalation work correctly.
 *
 * Registered as disabled (manual-trigger only via executeNow).
 */

interface CheckResult {
  name: string
  passed: boolean
  detail: string
}

export async function executePressureSim(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const testSpaceId = `__pressure_sim_${Date.now()}`
  const checks: CheckResult[] = []

  try {
    // ── Scenario A: Negation signal verification ───────────────────────
    logger.info(`PressureSim: starting scenario A (negation signal) in space ${testSpaceId}`)

    const scenarioAChecks = await runScenarioA(testSpaceId, deps)
    checks.push(...scenarioAChecks)

    // ── Scenario B: Contradiction escalation verification ──────────────
    logger.info(`PressureSim: starting scenario B (contradiction escalation) in space ${testSpaceId}`)

    const scenarioBChecks = await runScenarioB(testSpaceId)
    checks.push(...scenarioBChecks)

  } catch (err) {
    checks.push({
      name: '整体执行',
      passed: false,
      detail: `未捕获异常: ${err instanceof Error ? err.message : String(err)}`,
    })
  } finally {
    // ── Cleanup: remove all test data ──────────────────────────────────
    try {
      const db = getDatabase()
      db.prepare(
        'DELETE FROM bubble_links WHERE source_id IN (SELECT id FROM bubbles WHERE space_id = ?)',
      ).run(testSpaceId)
      db.prepare(
        'DELETE FROM bubble_links WHERE target_id IN (SELECT id FROM bubbles WHERE space_id = ?)',
      ).run(testSpaceId)
      const deleted = db.prepare('DELETE FROM bubbles WHERE space_id = ?').run(testSpaceId)
      logger.info(`PressureSim: cleanup — deleted ${deleted.changes} test bubbles`)
    } catch (err) {
      logger.error(`PressureSim: cleanup failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  // ── Build report ───────────────────────────────────────────────────
  const passed = checks.filter(c => c.passed).length
  const failed = checks.filter(c => !c.passed).length
  const report = checks
    .map(c => `${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`)
    .join('\n')

  const message = `压力模拟: ${passed} 通过, ${failed} 失败\n${report}`
  logger.info(`PressureSim: ${message}`)

  return {
    success: failed === 0,
    message,
  }
}

// ── Scenario A: Negation signal ────────────────────────────────────────

async function runScenarioA(spaceId: string, deps: TaskDeps): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const ORIGINAL_DECAY = 0.1

  // Inject 5 same-topic memory bubbles
  const sameTopicContents = [
    '3月华东地区螺纹钢采购量环比增长12%，主要集中在基建项目',
    '近期钢贸商补库意愿增强，螺纹钢社会库存连续三周下降',
    '下游工地开工率回升至65%，带动螺纹钢需求明显改善',
    '华东主流贸易商螺纹钢日均成交量较上月提升约800吨',
    '建筑钢材需求进入旺季，预计4月螺纹钢价格仍有上行空间',
  ]

  const sameTopicIds: string[] = []
  for (const content of sameTopicContents) {
    const b = createBubble({
      type: 'memory' as BubbleType,
      title: content.slice(0, 20),
      content,
      tags: ['test', '采购趋势', '螺纹钢'],
      source: 'pressure-sim',
      confidence: 0.8,
      decayRate: ORIGINAL_DECAY,
      spaceId,
    })
    sameTopicIds.push(b.id)
  }

  // Inject 1 divergent topic bubble
  const divergentBubble = createBubble({
    type: 'memory' as BubbleType,
    title: '华东天气预报',
    content: '本周华东地区以多云为主，周三起有中到大雨，气温22-28度，对户外施工有一定影响',
    tags: ['test', '天气观察'],
    source: 'pressure-sim',
    confidence: 0.8,
    decayRate: ORIGINAL_DECAY,
    spaceId,
  })

  // Run compaction
  try {
    const compactor = new BubbleCompactor(deps.llm)
    const reflector = new Reflector(deps.llm)
    const qualitySignals = reflector.getQualitySignals(spaceId)
    const result = await compactor.compact(spaceId, qualitySignals)

    // Check 1: synthesis bubble created
    const syntheses = findBubblesByType('synthesis', 10, [spaceId])
    if (syntheses.length > 0) {
      checks.push({ name: 'A1-合成泡泡创建', passed: true, detail: `创建了 ${syntheses.length} 个合成泡泡` })
    } else {
      checks.push({ name: 'A1-合成泡泡创建', passed: false, detail: `未创建合成泡泡 (clusters=${result.clustersFound}, skipped=${result.skipped})` })
      return checks // No point checking further
    }

    // Check 2: negations metadata present
    const synthesis = syntheses[0]
    const negations = (synthesis.metadata as Record<string, unknown>)?.negations as Array<{ sourceId: string; absorbed: boolean; reason?: string }> | undefined
    if (negations && negations.length > 0) {
      const absorbed = negations.filter(n => n.absorbed).length
      const notAbsorbed = negations.filter(n => !n.absorbed).length
      checks.push({
        name: 'A2-否定信号存在',
        passed: true,
        detail: `${negations.length} 条评估: ${absorbed} 吸收, ${notAbsorbed} 未吸收`,
      })
    } else {
      checks.push({ name: 'A2-否定信号存在', passed: false, detail: 'metadata.negations 为空或不存在' })
    }

    // Check 3: absorbed children have accelerated decay
    let acceleratedCount = 0
    let protectedCount = 0
    for (const id of sameTopicIds) {
      const b = getBubble(id)
      if (!b) continue
      if (b.decayRate > ORIGINAL_DECAY) acceleratedCount++
      else if (b.decayRate < ORIGINAL_DECAY) protectedCount++
    }

    checks.push({
      name: 'A3-吸收子衰减加速',
      passed: acceleratedCount > 0,
      detail: `${acceleratedCount} 个加速, ${protectedCount} 个保护, ${sameTopicIds.length - acceleratedCount - protectedCount} 个不变`,
    })

    // Check 4: divergent bubble either protected or unchanged
    const divAfter = getBubble(divergentBubble.id)
    if (divAfter) {
      const wasProtected = divAfter.decayRate <= ORIGINAL_DECAY
      checks.push({
        name: 'A4-偏离泡泡保护',
        passed: wasProtected,
        detail: `原始衰减=${ORIGINAL_DECAY}, 当前衰减=${divAfter.decayRate}${wasProtected ? ' (保护/不变)' : ' (意外加速)'}`,
      })
    } else {
      checks.push({ name: 'A4-偏离泡泡保护', passed: true, detail: '偏离泡泡未被聚类（未参与压实）' })
    }
  } catch (err) {
    checks.push({
      name: 'A-压实执行',
      passed: false,
      detail: `压实异常: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return checks
}

// ── Scenario B: Contradiction escalation ───────────────────────────────

async function runScenarioB(spaceId: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  try {
    // Inject base memory bubbles
    createBubble({
      type: 'memory' as BubbleType,
      title: '螺纹钢出厂价',
      content: '近期螺纹钢出厂价约 3800 元/吨，市场供应充足，库存处于中高位水平',
      tags: ['test', '螺纹钢', '价格'],
      source: 'pressure-sim',
      confidence: 1.0,
      decayRate: 0.1,
      spaceId,
    })

    createBubble({
      type: 'memory' as BubbleType,
      title: '热卷出厂价',
      content: '热卷板出厂价约 3500 元/吨，下游汽车和家电行业需求平稳',
      tags: ['test', '热卷', '价格'],
      source: 'pressure-sim',
      confidence: 1.0,
      decayRate: 0.1,
      spaceId,
    })

    const detector = new SurpriseDetector()

    // Contradiction #1: steel rebar price contradicts
    await detector.scanMessage(
      '近期螺纹钢出厂价已涨至 4200 元/吨，供货紧张，部分钢厂限产',
      spaceId,
    )

    // Contradiction #2: hot-rolled coil price contradicts
    await detector.scanMessage(
      '热卷板出厂价已涨至 4000 元/吨，汽车行业大幅增加采购量',
      spaceId,
    )

    // Check 1: contradiction events created
    const contradictionEvents = searchBubbles('矛盾', 20, [spaceId])
      .filter(b => b.type === 'event' && b.tags.includes('contradiction'))
    checks.push({
      name: 'B1-矛盾事件创建',
      passed: contradictionEvents.length >= 2,
      detail: `检测到 ${contradictionEvents.length} 个矛盾事件 (期望 >= 2)`,
    })

    // Check 2: question bubble created via pressure escalation
    const questions = findBubblesByType('question', 10, [spaceId])
      .filter(b => b.tags.includes('contradiction-pressure'))
    checks.push({
      name: 'B2-矛盾升级问题',
      passed: questions.length >= 1,
      detail: questions.length >= 1
        ? `创建了问题: "${questions[0].title}"`
        : `未触发矛盾升级 (矛盾事件数=${contradictionEvents.length})`,
    })
  } catch (err) {
    checks.push({
      name: 'B-矛盾检测执行',
      passed: false,
      detail: `异常: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  return checks
}
