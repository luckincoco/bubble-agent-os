/**
 * Metrics Collector — conversation signal detection for resonance quality feedback.
 *
 * Detects 5 signals from user messages:
 * 1. Reversal (反转): user contradicts a previously agreed position
 * 2. Return (回来继续): user returns to a topic after gap
 * 3. Citation check (引用验证): user verifies something Bubble said before
 * 4. Correction (纠正): user corrects Bubble's error
 * 5. Association break (关联中断): user abruptly changes topic (silence signal)
 *
 * Each detected signal is emitted as an event for the resonance layer to consume.
 */
import type { EventBus } from '../../event/event-bus.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'

export type SignalType = 'reversal' | 'return' | 'citation_check' | 'correction' | 'association_break'

export interface ConversationSignal {
  type: SignalType
  userId: string
  content: string
  confidence: number
  relatedTopic?: string
  timestamp: number
}

// --- Pattern matchers ---

const REVERSAL_PATTERNS = [
  /其实不是这样/,
  /我改主意了/,
  /我之前说(的|错)了/,
  /不对[，,\s]*(应该|其实)/,
  /反过来(想|说)/,
  /我想错了/,
  /我收回/,
  /算了[，,\s]*不是这个意思/,
]

const CORRECTION_PATTERNS = [
  /你(说|记)错了/,
  /不是.*而是/,
  /这个(不对|不准确|有误)/,
  /你搞(混|错)了/,
  /纠正一下/,
  /准确(地|的)说/,
  /你(之前|刚才)说的.*不对/,
  /错了[，,].*应该是/,
]

const CITATION_PATTERNS = [
  /你(之前|上次|昨天|前天)说(过|的)?/,
  /你(不是)?说过/,
  /你记(得|不记得)/,
  /你(提到|提过|说过).*[？?]/,
  /你觉得.*还是/,
  /你当时(说|的观点)/,
]

const RETURN_PATTERNS = [
  /回到(刚才|之前|上次)(的|那个)/,
  /继续(聊|说|讨论)(刚才|之前|上次)/,
  /接着(刚才|之前)(的|说)/,
  /我们(之前|上次)聊(的|到)/,
  /还是说回/,
  /再说(一下|回)?那个/,
]

/** Minimum topic overlap words to detect implicit return */
const TOPIC_RETURN_GAP_MESSAGES = 10

export class MetricsCollector {
  private eventBus?: EventBus
  private recentTopics: Map<string, { topic: string; messageIndex: number }[]> = new Map()
  private messageCounters: Map<string, number> = new Map()

  setEventBus(bus: EventBus): void {
    this.eventBus = bus
  }

  /**
   * Analyze a user message for conversation signals.
   * Called by Brain on each user input.
   */
  analyzeUserMessage(
    userInput: string,
    lastAssistantResponse: string | null,
    userId: string,
    spaceId?: string,
  ): ConversationSignal[] {
    const signals: ConversationSignal[] = []
    const now = Date.now()
    const msgCount = (this.messageCounters.get(userId) || 0) + 1
    this.messageCounters.set(userId, msgCount)

    // 1. Reversal detection
    for (const pattern of REVERSAL_PATTERNS) {
      if (pattern.test(userInput)) {
        signals.push({
          type: 'reversal',
          userId,
          content: userInput.slice(0, 200),
          confidence: 0.8,
          timestamp: now,
        })
        break
      }
    }

    // 2. Correction detection
    for (const pattern of CORRECTION_PATTERNS) {
      if (pattern.test(userInput)) {
        signals.push({
          type: 'correction',
          userId,
          content: userInput.slice(0, 200),
          confidence: 0.85,
          timestamp: now,
        })
        break
      }
    }

    // 3. Citation check detection
    for (const pattern of CITATION_PATTERNS) {
      if (pattern.test(userInput)) {
        signals.push({
          type: 'citation_check',
          userId,
          content: userInput.slice(0, 200),
          confidence: 0.7,
          timestamp: now,
        })
        break
      }
    }

    // 4. Return detection (explicit)
    for (const pattern of RETURN_PATTERNS) {
      if (pattern.test(userInput)) {
        signals.push({
          type: 'return',
          userId,
          content: userInput.slice(0, 200),
          confidence: 0.85,
          timestamp: now,
        })
        break
      }
    }

    // 5. Association break detection (topic shift)
    if (lastAssistantResponse && userInput.length > 10) {
      const breakScore = this.detectAssociationBreak(userInput, lastAssistantResponse)
      if (breakScore > 0.7) {
        signals.push({
          type: 'association_break',
          userId,
          content: userInput.slice(0, 200),
          confidence: breakScore,
          timestamp: now,
        })
      }
    }

    // Persist and emit signals
    if (signals.length > 0) {
      this.persistSignals(signals, spaceId)
      this.emitSignals(signals, spaceId)
    }

    return signals
  }

  /** Detect topic shift by keyword overlap */
  private detectAssociationBreak(userInput: string, lastResponse: string): number {
    const inputKeywords = this.extractKeywords(userInput)
    const responseKeywords = this.extractKeywords(lastResponse)

    if (inputKeywords.size === 0 || responseKeywords.size === 0) return 0

    // Calculate Jaccard similarity
    let overlap = 0
    for (const word of inputKeywords) {
      if (responseKeywords.has(word)) overlap++
    }

    const union = new Set([...inputKeywords, ...responseKeywords]).size
    const similarity = overlap / union

    // Low similarity + user input is not a short command = association break
    if (similarity < 0.05 && userInput.length > 20) return 0.85
    if (similarity < 0.1 && userInput.length > 30) return 0.75
    return 0
  }

  private extractKeywords(text: string): Set<string> {
    const clean = text.replace(/[#*`\[\]()>|_~，。！？、：；""'']/g, ' ')
    const cjk = clean.match(/[\u4e00-\u9fff]{2,6}/g) || []
    const eng = clean.match(/[a-zA-Z]{4,}/g) || []
    return new Set([...cjk, ...eng.map(w => w.toLowerCase())])
  }

  private persistSignals(signals: ConversationSignal[], spaceId?: string): void {
    try {
      const db = getDatabase()
      const stmt = db.prepare(`
        INSERT INTO conversation_signals (type, user_id, content, confidence, related_topic, space_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)

      for (const sig of signals) {
        stmt.run(sig.type, sig.userId, sig.content, sig.confidence, sig.relatedTopic || null, spaceId || null, sig.timestamp)
      }
    } catch (err) {
      logger.debug('MetricsCollector persist error:', err instanceof Error ? err.message : String(err))
    }
  }

  private emitSignals(signals: ConversationSignal[], spaceId?: string): void {
    if (!this.eventBus) return

    for (const sig of signals) {
      this.eventBus.emitFireAndForget({
        type: 'metrics.signal.detected',
        payload: {
          signalType: sig.type,
          userId: sig.userId,
          content: sig.content,
          confidence: sig.confidence,
        },
      } as any, { actor: 'metrics-collector', spaceId })
    }
  }
}

/** Create the conversation_signals table if not exists */
export function ensureMetricsTables(): void {
  const db = getDatabase()
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      related_topic TEXT,
      space_id TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_type_user ON conversation_signals(type, user_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_signals_created ON conversation_signals(created_at)`)
}
