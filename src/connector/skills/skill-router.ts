/**
 * SkillRouter — matches incoming messages against loaded skills.
 * Used by MessageRouter in Layer 0 to dispatch to the right handler.
 *
 * Supports handler types:
 *   - 'biz-entry': delegates to BizEntryHandler (business data auto-entry)
 *   - 'teach': delegates to TeachHandler (knowledge card teaching)
 */

import type { SkillLoader, SkillDefinition } from './loader.js'
import type { BizEntryHandler, BizEntryResult } from '../biz/handler.js'
import type { TeachHandler, TeachResult } from '../teach/handler.js'
import { logger } from '../../shared/logger.js'

export interface SkillMatchResult {
  matched: boolean
  skill?: SkillDefinition
  handled?: boolean
  response?: string
}

export class SkillRouter {
  private loader: SkillLoader
  private bizHandler: BizEntryHandler | null
  private teachHandler: TeachHandler | null

  constructor(loader: SkillLoader, bizHandler?: BizEntryHandler, teachHandler?: TeachHandler) {
    this.loader = loader
    this.bizHandler = bizHandler ?? null
    this.teachHandler = teachHandler ?? null
  }

  /**
   * Try to match and handle a message via loaded skills.
   * Skills are tried in priority order (highest first).
   * Returns { matched: false } if no skill claims the message.
   */
  async tryHandle(text: string, spaceId?: string): Promise<SkillMatchResult> {
    const skills = this.loader.getAllSkills()
    if (skills.length === 0) return { matched: false }

    // Sort by priority descending
    const sorted = [...skills].sort((a, b) => b.priority - a.priority)

    for (const skill of sorted) {
      if (!this.matchesTriggers(text, skill)) continue

      logger.info(`SkillRouter: matched skill "${skill.name}" for message`)

      // Dispatch to appropriate handler
      const result = await this.dispatch(skill, text, spaceId)
      if (result.handled) {
        return { matched: true, skill, handled: true, response: result.response }
      }
    }

    return { matched: false }
  }

  private matchesTriggers(text: string, skill: SkillDefinition): boolean {
    // Check compiled regex patterns
    for (const re of skill.compiledPatterns) {
      if (re.test(text)) return true
    }

    // Check keyword list
    if (skill.triggers.keywords) {
      for (const kw of skill.triggers.keywords) {
        if (text.includes(kw)) return true
      }
    }

    return false
  }

  private async dispatch(skill: SkillDefinition, text: string, spaceId?: string): Promise<{ handled: boolean; response?: string }> {
    switch (skill.handler) {
      case 'biz-entry':
        return this.handleBizEntry(text, spaceId)
      case 'teach':
        return this.handleTeach(text, spaceId)
      default:
        logger.warn(`SkillRouter: unknown handler "${skill.handler}" for skill "${skill.name}"`)
        return { handled: false }
    }
  }

  private async handleBizEntry(text: string, spaceId?: string): Promise<{ handled: boolean; response?: string }> {
    if (!this.bizHandler) {
      logger.debug('SkillRouter: biz-entry handler not available')
      return { handled: false }
    }

    const result: BizEntryResult = await this.bizHandler.tryHandle(text, spaceId)
    if (result.handled && result.response) {
      return { handled: true, response: result.response }
    }
    return { handled: false }
  }

  private async handleTeach(text: string, spaceId?: string): Promise<{ handled: boolean; response?: string }> {
    if (!this.teachHandler) {
      logger.debug('SkillRouter: teach handler not available')
      return { handled: false }
    }

    const result: TeachResult = await this.teachHandler.tryHandle(text, spaceId)
    if (result.handled && result.response) {
      return { handled: true, response: result.response }
    }
    return { handled: false }
  }
}
