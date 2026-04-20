/**
 * EventNotifier — pushes mirror-perspective event notifications
 * to bound external contacts when admin creates a biz event.
 *
 * Phase 3: LLM enhancement — template text is enriched with
 * relationship context before pushing. Falls back to template on error.
 */

import type { WeComConnector } from './wecom.js'
import type { LLMProvider } from '../shared/types.js'
import { findExternalContactsByCounterparty, logExternalAction } from './biz/external-store.js'
import { enhanceMirrorText } from './biz/mirror-enhancer.js'
import { logger } from '../shared/logger.js'

export interface MirrorPushContext {
  counterpartyId: string
  counterpartyName: string
  counterpartyType: 'supplier' | 'customer' | 'logistics'
  spaceId: string
  mirrorText: string
  eventType: string
}

export class EventNotifier {
  private wecom: WeComConnector | null
  private llm: LLMProvider | null

  constructor(wecom: WeComConnector | null, llm: LLMProvider | null = null) {
    this.wecom = wecom
    this.llm = llm
  }

  /**
   * Push mirror text to all bound external contacts of a counterparty.
   * If LLM is available, enhances the template text with relationship context.
   * Fire-and-forget — errors are logged but do not propagate.
   */
  async notifyCounterparty(ctx: MirrorPushContext): Promise<void> {
    try {
      const contacts = findExternalContactsByCounterparty(ctx.counterpartyId)
      if (contacts.length === 0) return

      // Try LLM enhancement (once for all contacts of same counterparty)
      let pushText = ctx.mirrorText
      let enhanced = false
      if (this.llm) {
        try {
          pushText = await enhanceMirrorText(this.llm, {
            templateText: ctx.mirrorText,
            counterpartyId: ctx.counterpartyId,
            counterpartyName: ctx.counterpartyName,
            counterpartyType: ctx.counterpartyType,
            eventType: ctx.eventType,
            spaceId: ctx.spaceId,
          })
          enhanced = true
          logger.info('EventNotifier: mirror text enhanced by LLM')
        } catch (err) {
          logger.warn('EventNotifier: LLM enhancement failed, using template:', err instanceof Error ? err.message : String(err))
        }
      }

      for (const contact of contacts) {
        try {
          if (contact.platform === 'wecom' && this.wecom) {
            await this.wecom.pushMessage(contact.platformUserId, pushText)
            logger.info(`EventNotifier: pushed to WeCom user ${contact.platformUserId}`)
          }
          // Feishu external push would need chat_id, deferred to future
          logExternalAction({
            externalContactId: contact.id,
            counterpartyId: ctx.counterpartyId,
            action: enhanced ? 'event_push_enhanced' : 'event_push',
            outputText: pushText,
          })
        } catch (err) {
          logger.error(`EventNotifier: failed to push to ${contact.platform}:${contact.platformUserId}:`, err instanceof Error ? err.message : String(err))
        }
      }
    } catch (err) {
      logger.error('EventNotifier error:', err instanceof Error ? err.message : String(err))
    }
  }
}
