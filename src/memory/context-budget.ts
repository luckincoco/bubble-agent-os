/**
 * ContextBudget — token accounting for working memory.
 * Tracks usage, provides budget reports, and manages auto-eviction thresholds.
 */

import type { WorkingMemory } from './working-memory.js'
import { estimateTokens } from '../shared/tokens.js'
import type { Bubble } from '../shared/types.js'

const SYSTEM_PROMPT_RESERVE = 1500   // Reserve for system prompt
const HISTORY_RESERVE = 2000         // Reserve for conversation history
const TOOL_RESULT_RESERVE = 1000     // Reserve for tool call results

export interface BudgetReport {
  totalBudget: number
  systemReserve: number
  historyReserve: number
  toolReserve: number
  availableForMemory: number
  currentUsage: number
  remainingCapacity: number
  utilizationPercent: number
  hotItemCount: number
  canLoadMore: boolean
}

export class ContextBudget {
  private totalBudget: number
  private workingMemory: WorkingMemory

  constructor(workingMemory: WorkingMemory, totalBudget = 8000) {
    this.workingMemory = workingMemory
    this.totalBudget = totalBudget
  }

  /**
   * Get a full budget report for a session.
   */
  getReport(sessionId: string): BudgetReport {
    const status = this.workingMemory.getStatus(sessionId)
    const availableForMemory = this.totalBudget - SYSTEM_PROMPT_RESERVE - HISTORY_RESERVE - TOOL_RESULT_RESERVE
    const remaining = Math.max(0, availableForMemory - status.hotTokens)

    return {
      totalBudget: this.totalBudget,
      systemReserve: SYSTEM_PROMPT_RESERVE,
      historyReserve: HISTORY_RESERVE,
      toolReserve: TOOL_RESULT_RESERVE,
      availableForMemory,
      currentUsage: status.hotTokens,
      remainingCapacity: remaining,
      utilizationPercent: availableForMemory > 0 ? Math.round((status.hotTokens / availableForMemory) * 100) : 100,
      hotItemCount: status.hotCount,
      canLoadMore: remaining > 200,  // At least 200 tokens available
    }
  }

  /**
   * Check if a bubble can be loaded without exceeding budget.
   */
  canLoad(sessionId: string, bubble: Bubble): boolean {
    const report = this.getReport(sessionId)
    const cost = estimateTokens(bubble.content + (bubble.summary || ''))
    return cost <= report.remainingCapacity
  }

  /**
   * Estimate how many more items of average size can be loaded.
   */
  estimateRemainingSlots(sessionId: string, avgTokensPerItem = 300): number {
    const report = this.getReport(sessionId)
    return Math.floor(report.remainingCapacity / avgTokensPerItem)
  }

  /**
   * Generate a human-readable status string for the agent's system prompt.
   */
  formatForSystemPrompt(sessionId: string, hotItems: Array<{ title: string; relevance: number; pinned: boolean }>): string {
    const report = this.getReport(sessionId)
    const status = this.workingMemory.getStatus(sessionId)

    const lines = [
      `[Working Memory Status]`,
      `Hot (in context): ${report.hotItemCount} items, ${report.currentUsage}/${report.availableForMemory} tokens (${report.utilizationPercent}%)`,
    ]

    // Show top items
    const topItems = hotItems.slice(0, 5)
    for (const item of topItems) {
      const flags = item.pinned ? ', pinned' : ''
      lines.push(`  - "${item.title}" (relevance: ${item.relevance.toFixed(2)}${flags})`)
    }
    if (hotItems.length > 5) {
      lines.push(`  ... and ${hotItems.length - 5} more`)
    }

    lines.push(`Warm (quick recall): ${status.warmCount} items available`)
    lines.push(`You can use memory_load/memory_evict/memory_pin/memory_status to manage your context.`)

    return lines.join('\n')
  }
}
