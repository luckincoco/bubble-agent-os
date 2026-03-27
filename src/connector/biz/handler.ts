/**
 * BizEntryHandler — aggregation entry point for detector + parser + store.
 * Used by MessageRouter in Layer 0 to handle business entry intents.
 */

import type { LLMProvider, EmbeddingProvider } from '../../shared/types.js'
import { detectBizIntent } from './detector.js'
import { BizParser } from './parser.js'
import { BizStore, type StoreResult } from './store.js'
import { logger } from '../../shared/logger.js'

export interface BizEntryResult {
  handled: boolean
  response?: string
  bubbleId?: string
}

export class BizEntryHandler {
  private parser: BizParser
  private store: BizStore

  constructor(llm: LLMProvider, embeddings?: EmbeddingProvider) {
    this.parser = new BizParser(llm)
    this.store = new BizStore()
    if (embeddings) {
      this.store.setEmbeddingProvider(embeddings)
    }
  }

  /**
   * Try to handle a message as a business entry.
   * Returns { handled: false } if the message is not a biz entry.
   * Returns { handled: true, response, bubbleId } if successfully stored.
   */
  async tryHandle(text: string, spaceId?: string): Promise<BizEntryResult> {
    // Step 1: Regex detection (zero LLM cost)
    const detect = detectBizIntent(text)
    if (!detect.detected || !detect.bizType) {
      return { handled: false }
    }

    logger.info(`BizEntry: detected ${detect.bizType} intent`)

    // Step 2: LLM parse (1 LLM call)
    const record = await this.parser.parse(text, detect.bizType)
    if (!record) {
      logger.info('BizEntry: LLM parse failed, falling back to Brain')
      return { handled: false }
    }

    // Step 3: Store as bubble
    const result: StoreResult = await this.store.store(record, spaceId)

    if (result.duplicate) {
      logger.info(`BizEntry: duplicate detected, bubble ${result.bubbleId}`)
    }

    return {
      handled: true,
      response: result.confirmation,
      bubbleId: result.bubbleId,
    }
  }
}
