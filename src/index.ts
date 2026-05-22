import { getConfig } from './shared/config.js'
import { resolve } from 'node:path'
import { createLLM } from './ai/llm.js'
import { ModelRouter } from './ai/model-router.js'
import { createEmbeddingProvider } from './ai/embeddings.js'
import { Brain } from './kernel/brain.js'
import { MemoryManager } from './memory/manager.js'
import { SemanticBridge } from './memory/semantic-bridge.js'
import { SurpriseDetector } from './memory/surprise-detector.js'
import { ConversationInsightEvaluator } from './memory/conversation-insight-evaluator.js'
import { ObservationRecorder } from './memory/observation-recorder.js'
import { AssertionIdentifier } from './memory/assertion-identifier.js'
import { ToolRegistry } from './connector/registry.js'
import { createWeatherTool } from './connector/tools/weather.js'
import { createTimeTool } from './connector/tools/time.js'
import { createQueryExcelTool, createExportExcelTool, createCleanExcelTool, createCrossAnalyzeTool } from './connector/tools/excel.js'
import { createWebSearchTool } from './connector/tools/web-search.js'
import { createFetchPageTool } from './connector/tools/fetch-page.js'
import { createBizQueryTools } from './connector/tools/biz-query-tools.js'
import { createExtQueryTools } from './connector/tools/ext-query-tools.js'
import { createExtAdminTools } from './connector/tools/ext-admin-tools.js'
import { createCodeTools } from './connector/tools/code-tools.js'
import { createSelfForgeTool } from './connector/tools/self-forge-tool.js'
import { createMarkitdownTool } from './connector/tools/markitdown-tool.js'
import { createDraftTools } from './connector/tools/draft-tools.js'
import { FeishuConnector } from './connector/feishu.js'
import { WeComConnector } from './connector/wecom.js'
import { MessageRouter } from './connector/router.js'
import { BizEntryHandler } from './connector/biz/handler.js'
import { EventNotifier } from './connector/event-notifier.js'
import { TeachHandler } from './connector/teach/handler.js'
import { SkillLoader } from './connector/skills/loader.js'
import { SkillRouter } from './connector/skills/skill-router.js'
import { OnboardingManager } from './connector/onboarding/manager.js'
import { TaskScheduler } from './scheduler/scheduler.js'
import { initDatabase, closeDatabase } from './storage/database.js'
import { startServer, type ServerModules } from './server/api.js'
import { startREPL } from './cli/repl.js'
import { seedAskAgent } from './agent/seed-agents.js'
import { logger } from './shared/logger.js'
// v0.7.0: Event Sourcing + Temporal Graph + Working Memory
import { EventBus } from './event/event-bus.js'
import { EventStore } from './event/event-store.js'
import { Materializer } from './event/materializer.js'
import { WorkingMemory } from './memory/working-memory.js'
import { ContextBudget } from './memory/context-budget.js'
// v0.8.x: ActionFeedback wiring — closes the State-Action loop
import { registerActionFeedbackListeners } from './wiring/action-feedback.js'
// v0.8.0: Cognitive Evolution Layer
import { OrientationGraph } from './cognition/orientation-graph.js'
import { CausalEvaluator } from './cognition/causal-evaluator.js'
import { InternalizationEngine } from './cognition/internalization.js'
import { ConceptForge } from './cognition/concept-forge.js'
import { ObsidianIngest } from './cognition/obsidian-ingest.js'
// v0.9.0: Observability
import { initObservability, type ObservabilityModule } from './observability/index.js'
// v1.1: Resonance Layer — activation path recording + anti-double-emit + signal detection
import { ResonanceIntegration, MetricsCollector, ensureMetricsTables } from './memory/resonance/index.js'
// v1.1.1: Event Gate — conversation → cognition bridge
import { EventGate } from './cognition/event-gate.js'

async function main() {
  const config = getConfig()
  initDatabase(config.storage.dataDir, config.auth.defaultPassword)

  // Seed built-in agents (「问」cognitive framework)
  seedAskAgent()

  const llmRouter = new ModelRouter(config.llm)
  const llm = llmRouter.default
  const memory = new MemoryManager(llmRouter.forCategory('memory'), config.features.focusTracking)

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
  for (const tool of createBizQueryTools()) {
    tools.register(tool)
  }
  for (const tool of createExtQueryTools()) {
    tools.register(tool)
  }
  for (const tool of createExtAdminTools()) {
    tools.register(tool)
  }
  if (config.features.codeTools) {
    for (const tool of createCodeTools()) {
      tools.register(tool)
    }
    logger.info('Module: CodeTools enabled')
  }
  if (config.features.selfEvolution) {
    tools.register(createSelfForgeTool(llmRouter.forCategory('chat'), process.cwd()))
    logger.info('Module: SelfForge (self-coding) enabled')
  }
  if (config.features.markitdown) {
    for (const tool of createMarkitdownTool()) {
      tools.register(tool)
    }
    logger.info('Module: MarkItDown enabled')
  }
  if (config.features.draftObservations) {
    for (const tool of createDraftTools()) {
      tools.register(tool)
    }
    logger.info('Module: DraftObservations enabled')
  }

  const brain = new Brain(llmRouter.forCategory('chat'))
  brain.setMemory(memory)
  brain.setTools(tools)
  const insightEvaluator = new ConversationInsightEvaluator(llmRouter.forCategory('memory'))
  brain.setInsightEvaluator(insightEvaluator)
  const observationRecorder = new ObservationRecorder()
  brain.setObservationRecorder(observationRecorder)

  if (config.features.assertionIdentification) {
    brain.setAssertionIdentifier(new AssertionIdentifier(llmRouter.forCategory('memory')))
    logger.info('Module: AssertionIdentification enabled')
  }

  // Initialize event-driven modules based on feature flags
  const semanticBridge = config.features.semanticBridge ? new SemanticBridge() : undefined
  const surpriseDetector = config.features.surpriseDetection ? new SurpriseDetector() : undefined

  if (semanticBridge) logger.info('Module: SemanticBridge enabled')
  if (surpriseDetector) logger.info('Module: SurpriseDetector enabled')
  if (config.features.focusTracking) logger.info('Module: FocusTracker enabled')

  // v0.7.0: Initialize Event Sourcing + Working Memory infrastructure (before Router)
  let eventBus: EventBus | undefined
  let eventStore: EventStore | undefined
  let materializer: Materializer | undefined
  let workingMem: WorkingMemory | undefined

  if (config.features.eventSourcing) {
    eventBus = new EventBus()
    eventStore = new EventStore()
    eventStore.init()
    materializer = new Materializer()

    // EventStore subscribes to all events for persistence
    eventStore.subscribeToEventBus(eventBus)
    // Materializer subscribes for state updates
    materializer.subscribeTo(eventBus)

    logger.info(`Module: EventSourcing enabled (${eventStore.count()} events in log)`)

    // Wire up insight evaluator to EventBus for conversation.turn.completed events
    insightEvaluator.setEventBus(eventBus)

    // Wire up ActionFeedback listeners for the State-Action loop
    registerActionFeedbackListeners(eventBus)

    // Bridge action.step.completed → ObservationRecorder for auto-capture
    eventBus.on('action.step.completed', (event) => {
      const p = (event as import('./event/event-types.js').ActionStepCompleted).payload
      observationRecorder.record({
        action: `plan_step:${p.stepId}`,
        args: { goal: p.goal, description: p.description },
        result: p.success ? p.output : `FAILED: ${p.output}`,
        spaceId: p.spaceId,
      })
    })
    logger.info('Module: ActionFeedback wiring enabled')
  }

  if (config.features.workingMemory) {
    workingMem = new WorkingMemory()
    const ctxBudget = new ContextBudget(workingMem)
    brain.setWorkingMemory(workingMem, ctxBudget)
    logger.info('Module: WorkingMemory enabled')
  }

  if (config.features.temporalGraph) {
    logger.info('Module: TemporalGraph enabled')
  }

  if (config.features.memoryViews) {
    logger.info('Module: MemoryViews enabled')
  }

  // v0.9.0: Initialize Observability (after EventBus, before Cognition)
  let obs: ObservabilityModule | undefined
  if (config.features.observability?.enabled) {
    obs = initObservability(eventBus, config.features.observability)
    brain.setTracer(obs.tracer)
  }

  // v0.8.0: Initialize Cognitive Evolution Layer
  let orientationGraph: OrientationGraph | undefined
  let causalEvaluator: CausalEvaluator | undefined
  let internalizationEngine: InternalizationEngine | undefined

  if (config.features.cognitionOrientation) {
    const cogLlm = llmRouter.forCategory('memory')
    orientationGraph = new OrientationGraph(cogLlm)
    if (eventBus) orientationGraph.setEventBus(eventBus)
    logger.info('Module: CognitionOrientationGraph enabled')
  }

  if (config.features.cognitionEvaluator) {
    const cogLlm = llmRouter.forCategory('memory')
    causalEvaluator = new CausalEvaluator(cogLlm)
    logger.info('Module: CognitionCausalEvaluator enabled')
  }

  if (config.features.cognitionInternalization) {
    internalizationEngine = new InternalizationEngine()
    if (eventBus) internalizationEngine.setEventBus(eventBus)
    if (orientationGraph) internalizationEngine.setOrientationGraph(orientationGraph)
    logger.info('Module: CognitionInternalizationEngine enabled')
  }

  // v0.9.0: Concept Forge — cross-domain structural isomorphism detection
  let conceptForge: ConceptForge | undefined
  if (config.features.cognitionOrientation && orientationGraph) {
    const cogLlm = llmRouter.forCategory('memory')
    conceptForge = new ConceptForge(cogLlm, orientationGraph)
    if (eventBus) conceptForge.setEventBus(eventBus)
    if (internalizationEngine) conceptForge.setInternalizationEngine(internalizationEngine)
    logger.info('Module: ConceptForge enabled')
  }

  // v1.1.1: Event Gate — conversation → cognition bridge
  if (eventBus && config.features.cognitionOrientation) {
    const eventGate = new EventGate(eventBus, { orientationGraph })
    logger.info('Module: EventGate enabled')
  }

  // Obsidian Ingest — safe read-only ingestion from whitelisted directory
  const obsidianIngestDir = resolve(config.storage.dataDir, '..', 'obsidian-ingest')
  const obsidianIngest = new ObsidianIngest(obsidianIngestDir)
  if (eventBus) obsidianIngest.setEventBus(eventBus)
  logger.info(`Module: ObsidianIngest enabled (dir: ${obsidianIngestDir})`)

  // v1.1: Resonance Layer — activation path + anti-double-emit + conversation signals
  const resonanceIntegration = new ResonanceIntegration()
  if (eventBus) resonanceIntegration.subscribeTo(eventBus)
  brain.setResonance(resonanceIntegration)
  logger.info('Module: ResonanceTracker enabled')

  ensureMetricsTables()
  const metricsCollector = new MetricsCollector()
  if (eventBus) metricsCollector.setEventBus(eventBus)
  brain.setMetricsCollector(metricsCollector)
  logger.info('Module: MetricsCollector enabled (5 signal detection)')

  // Initialize biz entry handler, teach handler, skill system, and unified message router
  const bizLlm = llmRouter.forCategory('biz')
  const bizHandler = new BizEntryHandler(bizLlm, embeddingProvider)
  const teachHandler = new TeachHandler(bizLlm, embeddingProvider)
  const skillsDir = resolve(config.storage.dataDir, '..', 'skills')
  const skillLoader = new SkillLoader(skillsDir)
  const skillRouter = new SkillRouter(skillLoader, bizHandler, teachHandler)
  const onboardingManager = new OnboardingManager()
  const router = new MessageRouter({ brain, tools, surpriseDetector, bizHandler, skillRouter, eventBus, llmProvider: llm, onboardingManager })
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

  // Wire up event notifier for pushing mirror events to external contacts
  const eventNotifier = new EventNotifier(wecom ?? null, bizLlm)
  bizHandler.setEventNotifier(eventNotifier)
  if (eventBus) bizHandler.setEventBus(eventBus)
  logger.info('Module: EventNotifier enabled')

  // Initialize scheduler
  let scheduler: TaskScheduler | undefined
  try {
    scheduler = new TaskScheduler({ brain, memory, tools, llm, llmRouter, feishu, eventBus, config, orientationGraph, causalEvaluator, internalizationEngine, conceptForge, obsidianIngest })
    await scheduler.init()
    // P1: Wire reactive event-driven scheduling
    if (eventBus) scheduler.registerReactiveListeners(eventBus)
    logger.info('Module: TaskScheduler enabled')
  } catch (err) {
    logger.error('Scheduler init failed:', err instanceof Error ? err.message : String(err))
    scheduler = undefined
  }

  const serverModules: ServerModules = { semanticBridge, surpriseDetector, scheduler, tencentConfig: config.tencent, wecom, llm }

  process.on('SIGINT', () => {
    obs?.stop()
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
