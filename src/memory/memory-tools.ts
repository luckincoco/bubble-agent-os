/**
 * MemoryTools — agent-callable tools for self-managing working memory.
 * Enables the agent to be self-aware of its context and make decisions
 * about what to load, evict, or pin.
 */

import type { WorkingMemory } from './working-memory.js'
import type { ContextBudget } from './context-budget.js'
import { searchBubbles, rowToBubble } from '../bubble/model.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'
import type { Bubble } from '../shared/types.js'

export interface MemoryToolDefs {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
}

/**
 * Get tool definitions for registration with the tool system.
 */
export function getMemoryToolDefinitions(): MemoryToolDefs[] {
  return [
    {
      name: 'memory_status',
      description: 'Check what is currently loaded in working memory. Shows hot (in-context), warm (quick recall), and budget usage.',
      parameters: {},
    },
    {
      name: 'memory_load',
      description: 'Load a specific piece of knowledge into active context by search query. Returns what was loaded.',
      parameters: {
        query: { type: 'string', description: 'Search query to find and load relevant memories', required: true },
        limit: { type: 'number', description: 'Maximum items to load (default: 3)' },
      },
    },
    {
      name: 'memory_evict',
      description: 'Remove a piece of knowledge from active context to free up token budget.',
      parameters: {
        bubble_id: { type: 'string', description: 'ID of the bubble to evict from context', required: true },
      },
    },
    {
      name: 'memory_pin',
      description: 'Pin important knowledge so it stays in context and cannot be auto-evicted.',
      parameters: {
        bubble_id: { type: 'string', description: 'ID of the bubble to pin', required: true },
      },
    },
  ]
}

/**
 * Create memory tool handlers bound to a specific session.
 */
export function createMemoryToolHandlers(
  workingMemory: WorkingMemory,
  contextBudget: ContextBudget,
  sessionId: string,
  spaceId: string,
) {
  return {
    memory_status: async () => {
      const status = workingMemory.getStatus(sessionId)
      const report = contextBudget.getReport(sessionId)
      const hotItems = workingMemory.getHotItems(sessionId)

      // Fetch bubble titles for display
      const db = getDatabase()
      const itemDetails = hotItems.map(item => {
        const bubble = db.prepare('SELECT title, confidence FROM bubbles WHERE id = ?').get(item.bubbleId) as { title: string; confidence: number } | undefined
        return {
          bubbleId: item.bubbleId,
          title: bubble?.title || '(unknown)',
          priority: item.priorityScore.toFixed(2),
          pinned: item.pinned,
          tokens: item.tokenCost,
        }
      })

      return JSON.stringify({
        budget: {
          total: report.availableForMemory,
          used: report.currentUsage,
          remaining: report.remainingCapacity,
          utilization: `${report.utilizationPercent}%`,
        },
        tiers: {
          hot: status.hotCount,
          warm: status.warmCount,
          cold: status.coldCount,
        },
        hotItems: itemDetails,
      }, null, 2)
    },

    memory_load: async (params: { query: string; limit?: number }) => {
      const limit = params.limit || 3
      const db = getDatabase()

      // Search for relevant bubbles
      const results = searchBubbles(params.query, {
        spaceId,
        limit: limit * 2,  // Get extra to filter
      })

      if (results.length === 0) {
        return JSON.stringify({ loaded: 0, message: 'No matching memories found.' })
      }

      const loaded: Array<{ id: string; title: string; tokens: number }> = []
      for (const row of results.slice(0, limit)) {
        const bubble = rowToBubble(row)
        try {
          const entry = workingMemory.load(sessionId, bubble, {
            recency: 0.8,
            relevance: 0.9,  // High because we explicitly searched for it
            confidence: bubble.confidence,
            focusBoost: 0,
          })
          loaded.push({ id: bubble.id, title: bubble.title, tokens: entry.tokenCost })
        } catch (err) {
          logger.warn(`memory_load: failed to load ${bubble.id}: ${err}`)
        }
      }

      return JSON.stringify({ loaded: loaded.length, items: loaded })
    },

    memory_evict: async (params: { bubble_id: string }) => {
      workingMemory.evict(sessionId, params.bubble_id)
      const status = workingMemory.getStatus(sessionId)
      return JSON.stringify({ evicted: params.bubble_id, remainingTokens: status.budgetTotal - status.hotTokens })
    },

    memory_pin: async (params: { bubble_id: string }) => {
      workingMemory.pin(sessionId, params.bubble_id)
      return JSON.stringify({ pinned: params.bubble_id, message: 'This memory will stay in context until unpinned.' })
    },
  }
}
