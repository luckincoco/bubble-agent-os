/**
 * EventGate — 轻量事件网关。
 *
 * 职责：监听对话完成事件，路由到认知层模块。
 * 不是中央控制器，只是一个 EventBus 监听 + 路由规则。
 *
 * Phase 1: 日志 + 计数埋点（当前）
 * Phase 2: 偏差分类（Periodic/Drift/Anomaly）
 * Phase 3: 节律网络（多变量关联）
 */

import type { EventBus } from '../event/event-bus.js'
import type { ConversationTurnCompleted } from '../event/event-types.js'
import type { OrientationGraph } from './orientation-graph.js'
import { logger } from '../shared/logger.js'

export class EventGate {
  private orientationGraph: OrientationGraph | null = null

  constructor(eventBus: EventBus, deps?: { orientationGraph?: OrientationGraph }) {
    this.orientationGraph = deps?.orientationGraph ?? null
    this.subscribe(eventBus)
  }

  private subscribe(eventBus: EventBus): void {
    eventBus.on('conversation.turn.completed', async (event) => {
      const payload = (event as ConversationTurnCompleted).payload
      if (payload.insightCount === 0) return

      logger.info(`EventGate: ${payload.insightCount} insights from conversation`)

      // Phase 2: 偏差分类 — 判断 insight 是周期性出现/漂移/异常
      // Phase 3: 节律网络 — 多变量关联检测
      // 重建操作仍走 cron，EventGate 不直接触发 LLM 调用
    })
  }
}
