/**
 * Rule-based teach intent detector.
 * Zero LLM calls — pure regex matching.
 *
 * Detects patterns like:
 *   "泡泡记住：桂鑫没有盘螺产品"
 *   "泡泡注意：汉浦路项目回款一直拖延"
 *   "泡泡更新：马台联系人换成张总"
 *   "泡泡忘记：桂鑫没有盘螺"
 */

export type TeachAction = 'remember' | 'note' | 'update' | 'forget'

export interface TeachDetectResult {
  detected: boolean
  action?: TeachAction
  bodyText?: string
}

// Action verb → TeachAction mapping
const ACTION_MAP: Record<string, TeachAction> = {
  '记住': 'remember', '记下': 'remember', '学习': 'remember', '知道': 'remember',
  '注意': 'note', '留意': 'note', '小心': 'note',
  '更新': 'update', '修改': 'update', '改一下': 'update', '纠正': 'update',
  '忘记': 'forget', '忘掉': 'forget', '删除': 'forget', '取消': 'forget', '别记': 'forget',
}

const VERB_GROUP = Object.keys(ACTION_MAP).join('|')

// Core regex: "泡泡" + verb + colon + body
const TEACH_RE = new RegExp(`泡泡\\s*(${VERB_GROUP})\\s*[：:]\\s*(.+)`, 's')

/**
 * Detect whether user input is a "teach bubble" intent.
 * Returns the detected action and body text after the colon.
 */
export function detectTeachIntent(text: string): TeachDetectResult {
  const trimmed = text.trim()

  // Too short or too long
  if (trimmed.length < 6 || trimmed.length > 500) return { detected: false }

  // Must contain "泡泡"
  if (!trimmed.includes('泡泡')) return { detected: false }

  const match = trimmed.match(TEACH_RE)
  if (!match) return { detected: false }

  const verb = match[1]
  const bodyText = match[2].trim()

  // Body must be at least 4 characters (avoid empty/trivial instructions)
  if (bodyText.length < 4) return { detected: false }

  const action = ACTION_MAP[verb]
  if (!action) return { detected: false }

  return { detected: true, action, bodyText }
}
