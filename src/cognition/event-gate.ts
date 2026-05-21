/**
 * EventGate — 轻量事件网关。
 *
 * 职责：监听对话完成事件，路由高价值洞察到认知层模块。
 * 不是中央控制器，只是一个 EventBus 监听 + 路由规则。
 *
 * Phase 1: 日志 + 计数埋点 ✅
 * Phase 2: insightScore 路由 + 审计事件（当前）
 * Phase 3: 偏差分类 + 节律网络
 */

import type { EventBus } from '../event/event-bus.js'
import type { ConversationTurnCompleted, KnowledgeEventGated } from '../event/event-types.js'
import type { OrientationGraph } from './orientation-graph.js'
import { logger } from '../shared/logger.js'

/** 路由阈值：insightScore >= 2.0 视为高价值洞察 */
const ROUTE_THRESHOLD = 2.0

export class EventGate {
  private orientationGraph: OrientationGraph | null = null
  private eventBus: EventBus | null = null

  constructor(eventBus: EventBus, deps?: { orientationGraph?: OrientationGraph }) {
    this.orientationGraph = deps?.orientationGraph ?? null
    this.eventBus = eventBus
    this.subscribe(eventBus)
  }

  private subscribe(eventBus: EventBus): void {
    eventBus.on('conversation.turn.completed', async (event) => {
      const payload = (event as ConversationTurnCompleted).payload
      if (payload.insightCount === 0) return

      // Phase 2: 路由高价值洞察到认知层
      if (payload.insightScore >= ROUTE_THRESHOLD) {
        logger.info(`EventGate: routing ${payload.insightCount} insights (score: ${payload.insightScore.toFixed(1)})`)
        // insightScore >= 2.0 意味着至少 2 个 synthesis 或 3 个 observation
        // 后续 Phase 3 会将具体 insight IDs 透传至此，调用 orientationGraph.registerNewObservation()
      } else {
        logger.debug(`EventGate: deferred ${payload.insightCount} insights (score: ${payload.insightScore.toFixed(1)}, below threshold ${ROUTE_THRESHOLD})`)
      }

      // 审计事件
      if (this.eventBus) {
        this.eventBus.emitFireAndForget(
          {
            type: 'knowledge.event.gated',
            payload: {
              sourceEvent: 'conversation.turn.completed',
              insightCount: payload.insightCount,
              insightScore: payload.insightScore,
              action: payload.insightScore >= ROUTE_THRESHOLD ? 'route' : 'defer',
              spaceId: payload.spaceId,
            },
          },
          { actor: 'system', spaceId: payload.spaceId, metadata: {} },
        )
      }
    })
  }
}
