import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'
import type { SemanticBridge } from '../memory/semantic-bridge.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import type { TaskScheduler, ScheduledTaskType } from '../scheduler/scheduler.js'
import type { LLMProvider, UserContext, SpaceRole } from '../shared/types.js'
import type { WeComConnector } from '../connector/wecom.js'
import type { MessageRouter } from '../connector/router.js'
import * as biz from '../connector/biz/structured-store.js'

export interface JwtPayload {
  userId: string
  username: string
  role: 'admin' | 'user'
  spaceIds: string[]
}

export interface ServerModules {
  semanticBridge?: SemanticBridge
  surpriseDetector?: SurpriseDetector
  scheduler?: TaskScheduler
  tencentConfig?: { secretId: string; secretKey: string; region?: string }
  wecom?: WeComConnector
  llm?: LLMProvider
}

export interface RouteDeps {
  brain: Brain
  memory: MemoryManager
  modules?: ServerModules
  router?: MessageRouter
  requireAdmin: (payload: JwtPayload, reply: FastifyReply) => boolean
  getUserCtx: (req: FastifyRequest, spaceIdOverride?: string) => UserContext
  getBizCtx: (req: FastifyRequest) => biz.BizContext
  getSpaceRole: (userId: string, spaceId: string, userRole: string) => SpaceRole | null
}
