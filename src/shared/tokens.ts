/**
 * Lightweight token estimation for Chinese + English mixed text.
 *
 * Heuristic (no external dependency):
 *   - CJK characters  ~1.5 tokens each (DeepSeek / GLM tokenisers)
 *   - ASCII words      ~1.3 tokens each
 *   - Numbers/symbols  ~1 token per 3 chars
 *
 * Accuracy: within ~15 % of real token count, good enough for budgeting.
 */

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g
const ASCII_WORD_RE = /[a-zA-Z_]+/g
const NUM_RE = /\d+\.?\d*/g

export function estimateTokens(text: string): number {
  if (!text) return 0

  let tokens = 0

  // CJK characters
  const cjk = text.match(CJK_RE)
  tokens += (cjk?.length ?? 0) * 1.5

  // ASCII words
  const words = text.match(ASCII_WORD_RE)
  tokens += (words?.length ?? 0) * 1.3

  // Numbers
  const nums = text.match(NUM_RE)
  tokens += (nums?.length ?? 0)

  // Remaining symbols / whitespace / punctuation (~1 token per 3 chars)
  const accountedChars =
    (cjk?.join('').length ?? 0) +
    (words?.join('').length ?? 0) +
    (nums?.join('').length ?? 0)
  const remaining = Math.max(0, text.length - accountedChars)
  tokens += remaining / 3

  return Math.ceil(tokens)
}

/** Truncate text to roughly fit within a token budget, preserving head. */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const est = estimateTokens(text)
  if (est <= maxTokens) return text

  // Approximate char-to-token ratio for this particular text
  const ratio = text.length / est
  const targetChars = Math.floor(maxTokens * ratio * 0.95) // 5 % safety margin
  return text.slice(0, targetChars) + '\n...(内容过长已截断)'
}

// Default context limits (tokens)
export const TOKEN_LIMITS = {
  /** Max tokens to send to LLM (leave room for completion) */
  MAX_PROMPT_TOKENS: 110_000,
  /** Reserved for the LLM's response */
  COMPLETION_RESERVE: 16_000,
  /** Budget for memory context in system prompt */
  MEMORY_BUDGET: 60_000,
  /** Budget for conversation history */
  HISTORY_BUDGET: 40_000,
  /** Max tokens for a single bubble in context */
  SINGLE_BUBBLE_MAX: 8_000,
} as const
