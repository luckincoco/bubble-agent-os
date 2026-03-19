/**
 * LLM Response Recording & Replay Fixture
 *
 * Provides deterministic LLM responses for tests:
 * - RECORD mode: proxies to real LLM, saves responses to fixtures
 * - REPLAY mode (default): reads from saved fixtures, no network needed
 *
 * Usage:
 *   const llm = createFixtureLLM('my-test-suite')
 *   // Use `llm` as a drop-in LLMProvider replacement
 *
 * Set LLM_FIXTURE_MODE=record to record new fixtures.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { LLMProvider, LLMResponse, LLMMessage } from '../src/shared/types.js'

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures', 'llm')

/** Deterministic hash for a message sequence */
function hashMessages(messages: LLMMessage[]): string {
  const payload = JSON.stringify(messages.map(m => ({ role: m.role, content: m.content })))
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

interface FixtureEntry {
  hash: string
  messages: { role: string; content: string }[]
  response: LLMResponse
  recordedAt: string
}

/**
 * Create a fixture-backed LLM provider.
 *
 * @param suiteName - unique name for the test suite (used as fixture filename)
 * @param realLLM   - optional real LLM provider for recording mode
 */
export function createFixtureLLM(suiteName: string, realLLM?: LLMProvider): LLMProvider {
  const mode = process.env.LLM_FIXTURE_MODE === 'record' ? 'record' : 'replay'
  const fixturePath = join(FIXTURE_DIR, `${suiteName}.json`)

  // Load existing fixtures
  let fixtures: FixtureEntry[] = []
  if (existsSync(fixturePath)) {
    try {
      fixtures = JSON.parse(readFileSync(fixturePath, 'utf-8'))
    } catch {
      fixtures = []
    }
  }

  // Index by hash for fast lookup
  const index = new Map<string, FixtureEntry>()
  for (const f of fixtures) index.set(f.hash, f)

  function saveFixtures() {
    ensureDir(FIXTURE_DIR)
    writeFileSync(fixturePath, JSON.stringify([...index.values()], null, 2), 'utf-8')
  }

  return {
    async chat(messages: LLMMessage[]): Promise<LLMResponse> {
      const hash = hashMessages(messages)

      // Try replay first
      const cached = index.get(hash)
      if (cached) return cached.response

      if (mode === 'replay') {
        // Fallback: echo-style stub (no network, always works)
        const last = messages[messages.length - 1]?.content || ''
        return { content: `[Fixture Stub] Echo: ${last.slice(0, 100)}` }
      }

      // Record mode: call real LLM
      if (!realLLM) {
        throw new Error(
          `LLM_FIXTURE_MODE=record but no real LLM provider given for suite "${suiteName}". ` +
          'Pass a real LLM provider as second argument to createFixtureLLM().'
        )
      }

      const response = await realLLM.chat(messages)

      // Save to fixture
      const entry: FixtureEntry = {
        hash,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        response,
        recordedAt: new Date().toISOString(),
      }
      index.set(hash, entry)
      saveFixtures()

      return response
    },

    async chatStream(messages: LLMMessage[], onChunk: (t: string) => void): Promise<LLMResponse> {
      const hash = hashMessages(messages)

      // Try replay
      const cached = index.get(hash)
      if (cached) {
        // Simulate streaming by emitting content in chunks
        const content = cached.response.content
        const chunkSize = Math.max(1, Math.ceil(content.length / 5))
        for (let i = 0; i < content.length; i += chunkSize) {
          onChunk(content.slice(i, i + chunkSize))
        }
        return cached.response
      }

      if (mode === 'replay') {
        const last = messages[messages.length - 1]?.content || ''
        const content = `[Fixture Stub] Echo: ${last.slice(0, 100)}`
        onChunk(content)
        return { content }
      }

      // Record mode
      if (!realLLM?.chatStream) {
        throw new Error('LLM_FIXTURE_MODE=record but real LLM has no chatStream method.')
      }

      // Collect all chunks and the final response
      const chunks: string[] = []
      const response = await realLLM.chatStream(messages, (chunk) => {
        chunks.push(chunk)
        onChunk(chunk)
      })

      // Save to fixture (store full response, not individual chunks)
      const entry: FixtureEntry = {
        hash,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        response,
        recordedAt: new Date().toISOString(),
      }
      index.set(hash, entry)
      saveFixtures()

      return response
    },
  }
}
