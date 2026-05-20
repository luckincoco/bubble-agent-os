import type { Bubble } from '../shared/types.js'
import { updateBubble } from '../bubble/model.js'
import { addLink } from '../bubble/links.js'
import { tokenize } from './focus-tracker.js'
import { logger } from '../shared/logger.js'

/**
 * Contradiction Resolver
 *
 * Enhanced contradiction detection beyond simple numeric comparison.
 * Detects semantic contradictions (negations, state changes, updated values)
 * and automatically resolves them by superseding old memories.
 *
 * Detection patterns:
 * 1. Numeric: same context, different numbers (existing)
 * 2. Negation: "A是B" vs "A不是B", "已X" vs "未X"
 * 3. State change: field-value patterns with different values
 * 4. Temporal: same event, different dates
 */

export interface ContradictionResult {
  contradicts: boolean
  type: 'numeric' | 'negation' | 'state_change' | 'temporal' | 'none'
  confidence: number
  oldBubble: Bubble | null
  details?: string
}

// Negation patterns in Chinese
const NEGATION_PAIRS = [
  [/已经?/, /还没|尚未|未/],
  [/是/, /不是|并非/],
  [/可以|能/, /不可以|不能|无法/],
  [/有/, /没有|无/],
  [/会/, /不会/],
  [/完成/, /未完成|没完成/],
  [/通过/, /未通过|没通过/],
  [/付[了过]?款?/, /未付|欠款|待付/],
  [/到[了过]?/, /未到|没到/],
] as const

// Field-value pattern (e.g., "电话: 123", "地址：xxx", "价格 300")
const FIELD_VALUE_RE = /([电话手机地址邮箱价格单价数量金额状态进度]{2,})[：:=\s]+(.+?)(?=[，。；\n]|$)/g

// Date patterns
const DATE_RE = /(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?|\d{1,2}月\d{1,2}[日号])/g

export class ContradictionResolver {
  /**
   * Enhanced contradiction detection.
   * Returns detailed contradiction info including type and confidence.
   */
  detect(newContent: string, existingBubbles: Bubble[]): ContradictionResult {
    if (existingBubbles.length === 0) {
      return { contradicts: false, type: 'none', confidence: 0, oldBubble: null }
    }

    const newTokens = tokenize(newContent)

    // Find the most overlapping existing bubble
    let maxOverlap = 0
    let bestMatch: Bubble | null = null

    for (const b of existingBubbles) {
      const existTokens = tokenize(b.content)
      let intersection = 0
      for (const t of newTokens) { if (existTokens.has(t)) intersection++ }
      const union = new Set([...newTokens, ...existTokens]).size
      const overlap = union > 0 ? intersection / union : 0
      if (overlap > maxOverlap) {
        maxOverlap = overlap
        bestMatch = b
      }
    }

    // Need at least moderate overlap to consider contradiction
    if (!bestMatch || maxOverlap < 0.3) {
      return { contradicts: false, type: 'none', confidence: 0, oldBubble: null }
    }

    // Check each contradiction type in order of reliability
    const numResult = this.detectNumericContradiction(newContent, bestMatch.content, maxOverlap)
    if (numResult.contradicts) return { ...numResult, oldBubble: bestMatch }

    const negResult = this.detectNegation(newContent, bestMatch.content, maxOverlap)
    if (negResult.contradicts) return { ...negResult, oldBubble: bestMatch }

    const stateResult = this.detectStateChange(newContent, bestMatch.content, maxOverlap)
    if (stateResult.contradicts) return { ...stateResult, oldBubble: bestMatch }

    const temporalResult = this.detectTemporalContradiction(newContent, bestMatch.content, maxOverlap)
    if (temporalResult.contradicts) return { ...temporalResult, oldBubble: bestMatch }

    return { contradicts: false, type: 'none', confidence: 0, oldBubble: bestMatch }
  }

  /**
   * Resolve a confirmed contradiction: mark old bubble as superseded.
   */
  resolve(newBubbleId: string, oldBubble: Bubble, contradictionType: string): void {
    // Lower old bubble's confidence
    const oldTags = oldBubble.tags || []
    const updatedTags = [...oldTags.filter(t => t !== 'contradiction'), 'superseded']

    updateBubble(oldBubble.id, {
      confidence: Math.max(0.1, (oldBubble.confidence || 0.8) * 0.3),
      decayRate: 0.3, // Fast decay for superseded info
      tags: updatedTags,
    })

    // Create superseded_by link
    addLink(oldBubble.id, newBubbleId, 'superseded_by', 1.0, 'system')

    logger.info(`Contradiction resolved: [${contradictionType}] "${oldBubble.title}" superseded by ${newBubbleId}`)
  }

  private detectNumericContradiction(newContent: string, oldContent: string, overlap: number): Omit<ContradictionResult, 'oldBubble'> {
    if (overlap < 0.4) return { contradicts: false, type: 'none', confidence: 0 }

    const newNums = newContent.match(/\d+\.?\d*/g) || []
    const oldNums = oldContent.match(/\d+\.?\d*/g) || []

    if (newNums.length === 0 || oldNums.length === 0) {
      return { contradicts: false, type: 'none', confidence: 0 }
    }

    const newSet = new Set(newNums)
    const oldSet = new Set(oldNums)
    const numOverlap = [...newSet].filter(n => oldSet.has(n)).length

    // Same context but different numbers
    if (numOverlap < Math.min(newSet.size, oldSet.size) * 0.5) {
      const confidence = Math.min(1.0, overlap * 1.5)
      return {
        contradicts: true,
        type: 'numeric',
        confidence,
        details: `数值变化: [${[...oldSet].slice(0, 3).join(',')}] → [${[...newSet].slice(0, 3).join(',')}]`,
      }
    }

    return { contradicts: false, type: 'none', confidence: 0 }
  }

  private detectNegation(newContent: string, oldContent: string, overlap: number): Omit<ContradictionResult, 'oldBubble'> {
    if (overlap < 0.35) return { contradicts: false, type: 'none', confidence: 0 }

    for (const [positive, negative] of NEGATION_PAIRS) {
      const newHasPos = positive.test(newContent)
      const newHasNeg = negative.test(newContent)
      const oldHasPos = positive.test(oldContent)
      const oldHasNeg = negative.test(oldContent)

      // One has positive form, the other has negative form
      if ((newHasPos && oldHasNeg) || (newHasNeg && oldHasPos)) {
        return {
          contradicts: true,
          type: 'negation',
          confidence: Math.min(0.9, overlap * 1.3),
          details: `否定模式: ${positive.source} ↔ ${negative.source}`,
        }
      }
    }

    return { contradicts: false, type: 'none', confidence: 0 }
  }

  private detectStateChange(newContent: string, oldContent: string, overlap: number): Omit<ContradictionResult, 'oldBubble'> {
    if (overlap < 0.35) return { contradicts: false, type: 'none', confidence: 0 }

    const newFields = extractFieldValues(newContent)
    const oldFields = extractFieldValues(oldContent)

    for (const [field, newValue] of newFields) {
      const oldValue = oldFields.get(field)
      if (oldValue && oldValue !== newValue) {
        return {
          contradicts: true,
          type: 'state_change',
          confidence: Math.min(0.95, overlap * 1.4),
          details: `字段变更: ${field} "${oldValue}" → "${newValue}"`,
        }
      }
    }

    return { contradicts: false, type: 'none', confidence: 0 }
  }

  private detectTemporalContradiction(newContent: string, oldContent: string, overlap: number): Omit<ContradictionResult, 'oldBubble'> {
    if (overlap < 0.4) return { contradicts: false, type: 'none', confidence: 0 }

    const newDates = newContent.match(DATE_RE) || []
    const oldDates = oldContent.match(DATE_RE) || []

    if (newDates.length === 0 || oldDates.length === 0) {
      return { contradicts: false, type: 'none', confidence: 0 }
    }

    // Check if dates differ while context overlaps strongly
    const newDateSet = new Set(newDates)
    const oldDateSet = new Set(oldDates)
    const dateOverlap = [...newDateSet].filter(d => oldDateSet.has(d)).length

    if (dateOverlap === 0 && overlap > 0.5) {
      return {
        contradicts: true,
        type: 'temporal',
        confidence: Math.min(0.85, overlap * 1.2),
        details: `日期变更: [${[...oldDateSet].slice(0, 2).join(',')}] → [${[...newDateSet].slice(0, 2).join(',')}]`,
      }
    }

    return { contradicts: false, type: 'none', confidence: 0 }
  }
}

function extractFieldValues(content: string): Map<string, string> {
  const fields = new Map<string, string>()
  let match: RegExpExecArray | null
  const re = new RegExp(FIELD_VALUE_RE.source, FIELD_VALUE_RE.flags)
  while ((match = re.exec(content)) !== null) {
    fields.set(match[1], match[2].trim())
  }
  return fields
}
