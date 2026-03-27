/**
 * TeachHandler — aggregation entry point for teach detector + parser + store.
 * Used by SkillRouter to handle "teach bubble" intents.
 *
 * Follows the same 3-step pattern as BizEntryHandler:
 *   Step 1: detectTeachIntent() — pure regex, zero LLM
 *   Step 2: parser.parse()      — one LLM call
 *   Step 3: store.store()       — createBubble + conflict resolution
 */

import type { LLMProvider, EmbeddingProvider } from '../../shared/types.js'
import { detectTeachIntent } from './detector.js'
import { TeachParser } from './parser.js'
import { TeachStore } from './store.js'
import { logger } from '../../shared/logger.js'

export interface TeachResult {
  handled: boolean
  response?: string
  bubbleId?: string
}

export class TeachHandler {
  private parser: TeachParser
  private store: TeachStore

  constructor(llm: LLMProvider, embeddings?: EmbeddingProvider) {
    this.parser = new TeachParser(llm)
    this.store = new TeachStore()
    if (embeddings) {
      this.store.setEmbeddingProvider(embeddings)
    }
  }

  /**
   * Try to handle a message as a "teach bubble" intent.
   * Returns { handled: false } if the message is not a teach intent.
   * Returns { handled: true, response, bubbleId } if successfully stored.
   */
  async tryHandle(text: string, spaceId?: string): Promise<TeachResult> {
    // Step 1: Regex detection (zero LLM cost)
    const detect = detectTeachIntent(text)
    if (!detect.detected || !detect.action || !detect.bodyText) {
      return { handled: false }
    }

    logger.info(`TeachHandler: detected ${detect.action} intent`)

    // Step 2: LLM parse (1 LLM call)
    const record = await this.parser.parse(detect.bodyText, detect.action, text)
    if (!record) {
      logger.info('TeachHandler: LLM parse failed, falling back to Brain')
      return { handled: false }
    }

    // Step 3: Store as bubble
    const result = await this.store.store(record, spaceId)

    return {
      handled: true,
      response: result.confirmation,
      bubbleId: result.bubbleId || undefined,
    }
  }
}
