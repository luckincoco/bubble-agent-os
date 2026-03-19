import * as readline from 'node:readline'
import type { Brain } from '../kernel/brain.js'
import type { MemoryManager } from '../memory/manager.js'

const COLORS = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
}

function printBanner() {
  console.log()
  console.log(`${COLORS.cyan}${COLORS.bold}  Bubble Agent OS v0.1.0${COLORS.reset}`)
  console.log(`${COLORS.dim}  your personal AI agent${COLORS.reset}`)
  console.log(`${COLORS.dim}  type /help for commands, /quit to exit${COLORS.reset}`)
  console.log()
}

function handleCommand(input: string, memory: MemoryManager | null): boolean {
  switch (input) {
    case '/help':
      console.log(`
${COLORS.cyan}Commands:${COLORS.reset}
  /help     Show this help
  /quit     Exit Bubble Agent
  /clear    Clear conversation history
  /info     Show current config
  /memory   Show stored memories
`)
      return true
    case '/quit':
    case '/exit':
      console.log(`${COLORS.dim}Bye!${COLORS.reset}`)
      process.exit(0)
    case '/memory':
      if (!memory) {
        console.log(`${COLORS.dim}Memory system not active.${COLORS.reset}\n`)
        return true
      }
      const memories = memory.listMemories()
      if (memories.length === 0) {
        console.log(`${COLORS.dim}No memories stored yet. Chat with me and I'll remember!${COLORS.reset}\n`)
      } else {
        console.log(`${COLORS.yellow}${COLORS.bold}Stored Memories (${memories.length}):${COLORS.reset}`)
        for (const m of memories) {
          const pin = m.pinned ? ' [pinned]' : ''
          const time = new Date(m.createdAt).toLocaleString('zh-CN')
          console.log(`  ${COLORS.cyan}${m.title}${COLORS.reset}${pin}`)
          console.log(`  ${COLORS.dim}${m.content}${COLORS.reset}`)
          console.log(`  ${COLORS.dim}tags: [${m.tags.join(', ')}] | ${time}${COLORS.reset}`)
          console.log()
        }
      }
      return true
    default:
      if (input.startsWith('/')) {
        console.log(`${COLORS.dim}Unknown command: ${input}${COLORS.reset}`)
        return true
      }
      return false
  }
}

export async function startREPL(brain: Brain, memory?: MemoryManager) {
  printBanner()

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${COLORS.green}> ${COLORS.reset}`,
  })

  rl.prompt()

  rl.on('line', async (line) => {
    const input = line.trim()
    if (!input) {
      rl.prompt()
      return
    }

    if (handleCommand(input, memory || null)) {
      rl.prompt()
      return
    }

    // Stream LLM response
    process.stdout.write(`${COLORS.cyan}`)
    try {
      await brain.think(input, undefined, (chunk: string) => {
        process.stdout.write(chunk)
      }).then(result => { /* ThinkResult - REPL only uses streaming output */ })
      process.stdout.write(`${COLORS.reset}\n\n`)
    } catch (err) {
      process.stdout.write(`${COLORS.reset}\n`)
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`${COLORS.dim}Error: ${msg}${COLORS.reset}\n`)
    }

    rl.prompt()
  })

  rl.on('close', () => {
    console.log(`\n${COLORS.dim}Bye!${COLORS.reset}`)
    process.exit(0)
  })
}
