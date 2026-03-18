import { getConfig } from './shared/config.js'
import { createLLM } from './ai/llm.js'
import { createEmbeddingProvider } from './ai/embeddings.js'
import { Brain } from './kernel/brain.js'
import { MemoryManager } from './memory/manager.js'
import { ToolRegistry } from './connector/registry.js'
import { createWeatherTool } from './connector/tools/weather.js'
import { createTimeTool } from './connector/tools/time.js'
import { initDatabase, closeDatabase } from './storage/database.js'
import { startServer } from './server/api.js'
import { startREPL } from './cli/repl.js'
import { logger } from './shared/logger.js'

async function main() {
  const config = getConfig()
  initDatabase(config.storage.dataDir, config.auth.defaultPassword)

  const llm = createLLM(config.llm)
  const memory = new MemoryManager(llm)

  if (config.llm.apiKey && config.llm.baseUrl) {
    try {
      const ep = createEmbeddingProvider({
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        model: process.env.EMBEDDING_MODEL || 'text-embedding-ada-002',
      })
      memory.setEmbeddingProvider(ep)
    } catch {
      logger.debug('Embedding provider not available')
    }
  }

  const tools = new ToolRegistry()
  tools.register(createWeatherTool())
  tools.register(createTimeTool())

  const brain = new Brain(llm)
  brain.setMemory(memory)
  brain.setTools(tools)

  process.on('SIGINT', () => {
    closeDatabase()
    process.exit(0)
  })

  if (process.argv.includes('--serve')) {
    const port = parseInt(process.env.PORT || '3000')
    await startServer(brain, memory, port, config.auth.jwtSecret)
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
