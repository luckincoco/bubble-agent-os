import { getConfig } from './shared/config.js'
import { resolve } from 'node:path'
import { createLLM } from './ai/llm.js'
import { createEmbeddingProvider } from './ai/embeddings.js'
import { Brain } from './kernel/brain.js'
import { MemoryManager } from './memory/manager.js'
import { SemanticBridge } from './memory/semantic-bridge.js'
import { SurpriseDetector } from './memory/surprise-detector.js'
import { ToolRegistry } from './connector/registry.js'
import { createWeatherTool } from './connector/tools/weather.js'
import { createTimeTool } from './connector/tools/time.js'
import { createQueryExcelTool, createExportExcelTool, createCleanExcelTool, createCrossAnalyzeTool } from './connector/tools/excel.js'
import { createWebSearchTool } from './connector/tools/web-search.js'
import { createFetchPageTool } from './connector/tools/fetch-page.js'
import { FeishuConnector } from './connector/feishu.js'
import { WeComConnector } from './connector/wecom.js'
import { MessageRouter } from './connector/router.js'
import { BizEntryHandler } from './connector/biz/handler.js'
import { TeachHandler } from './connector/teach/handler.js'
import { SkillLoader } from './connector/skills/loader.js'
import { SkillRouter } from './connector/skills/skill-router.js'
import { TaskScheduler } from './scheduler/scheduler.js'
import { initDatabase, closeDatabase } from './storage/database.js'
import { startServer, type ServerModules } from './server/api.js'
import { startREPL } from './cli/repl.js'
import { seedAskAgent } from './agent/seed-agents.js'
import { logger } from './shared/logger.js'

async function main() {
  const config = getConfig()
  initDatabase(config.storage.dataDir, config.auth.defaultPassword)

  // Seed built-in agents (「问」cognitive framework)
  seedAskAgent()

  const llm = createLLM(config.llm)
  const memory = new MemoryManager(llm, config.features.focusTracking)

  let embeddingProvider: import('./shared/types.js').EmbeddingProvider | undefined
  if (config.llm.apiKey && config.llm.baseUrl) {
    try {
      embeddingProvider = createEmbeddingProvider({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        model: process.env.EMBEDDING_MODEL || 'text-embedding-ada-002',
      })
      memory.setEmbeddingProvider(embeddingProvider)
    } catch {
      logger.debug('Embedding provider not available')
    }
  }

  const tools = new ToolRegistry()
  tools.register(createWeatherTool())
  tools.register(createTimeTool())
  tools.register(createQueryExcelTool())
  tools.register(createExportExcelTool())
  tools.register(createCleanExcelTool())
  tools.register(createCrossAnalyzeTool())
  tools.register(createWebSearchTool())
  tools.register(createFetchPageTool())

  const brain = new Brain(llm)
  brain.setMemory(memory)
  brain.setTools(tools)

  // Initialize event-driven modules based on feature flags
  const semanticBridge = config.features.semanticBridge ? new SemanticBridge() : undefined
  const surpriseDetector = config.features.surpriseDetection ? new SurpriseDetector() : undefined

  if (semanticBridge) logger.info('Module: SemanticBridge enabled')
  if (surpriseDetector) logger.info('Module: SurpriseDetector enabled')
  if (config.features.focusTracking) logger.info('Module: FocusTracker enabled')

  // Initialize biz entry handler, teach handler, skill system, and unified message router
  const bizHandler = new BizEntryHandler(llm, embeddingProvider)
  const teachHandler = new TeachHandler(llm, embeddingProvider)
  const skillsDir = resolve(config.storage.dataDir, '..', 'skills')
  const skillLoader = new SkillLoader(skillsDir)
  const skillRouter = new SkillRouter(skillLoader, bizHandler, teachHandler)
  const router = new MessageRouter({ brain, tools, surpriseDetector, bizHandler, skillRouter })
  logger.info('Module: SkillRouter + MessageRouter enabled')

  // Start Feishu connector if configured (lifted to outer scope for scheduler access)
  let feishu: FeishuConnector | undefined
  if (config.feishu) {
    feishu = new FeishuConnector(config.feishu, brain, surpriseDetector, config.tencent, tools)
    await feishu.start()
  }

  // Initialize WeCom connector if configured (routes registered later by server)
  let wecom: WeComConnector | undefined
  if (config.wecom) {
    wecom = new WeComConnector(config.wecom, brain, surpriseDetector, config.tencent, tools)
    logger.info('WeCom connector: initialized')
  }

  // Initialize scheduler
  let scheduler: TaskScheduler | undefined
  try {
    scheduler = new TaskScheduler({ brain, memory, tools, llm, feishu })
    await scheduler.init()
    logger.info('Module: TaskScheduler enabled')
  } catch (err) {
    logger.error('Scheduler init failed:', err instanceof Error ? err.message : String(err))
    scheduler = undefined
  }

  const serverModules: ServerModules = { semanticBridge, surpriseDetector, scheduler, tencentConfig: config.tencent, wecom }

  process.on('SIGINT', () => {
    scheduler?.stop()
    closeDatabase()
    process.exit(0)
  })

  if (process.argv.includes('--serve')) {
    const port = parseInt(process.env.PORT || '3000')
    await startServer(brain, memory, port, config.auth.jwtSecret, serverModules, config.auth.serviceApiKey, router)
    // Keep process alive in serve-only mode (no REPL needed)
    if (!process.stdin.isTTY) return
  }

  await startREPL(brain, memory)
}

main().catch((err) => {
  console.error('Fatal error:', err.message || err)
  closeDatabase()
  process.exit(1)
})
