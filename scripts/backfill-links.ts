#!/usr/bin/env npx tsx
/**
 * Backfill memory links based on keyword co-occurrence.
 *
 * Problem: Bubble graph only shows 1 center node + 0 edges because
 * only `same_turn` links exist (created during the same conversation turn).
 * Deep semantic links (related_to) are missing.
 *
 * Solution: Extract keywords from title + summary/content of memory bubbles,
 * compute Jaccard similarity, and create `related_to` links.
 *
 * Usage:
 *   npx tsx scripts/backfill-links.ts [--db <path>]
 *
 * Default DB: ~/.bubble-agent/data/bubble.db
 * Idempotent: won't create duplicate (source_id, target_id, relation) links.
 */

import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import { homedir } from 'node:os'

// ── CLI args ──────────────────────────────────────────────────────
const args = process.argv.slice(2)
let dbPath = resolve(homedir(), '.bubble-agent/data/bubble.db')
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--db' && args[i + 1]) {
    dbPath = resolve(args[i + 1])
    i++
  }
}

// ── Stopwords ─────────────────────────────────────────────────────
const STOPWORDS = new Set([
  // Chinese
  '的', '了', '是', '在', '有', '和', '就', '都', '而', '及', '与', '着', '或',
  '一个', '没有', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '如何',
  '因为', '所以', '但是', '可以', '需要', '应该', '也', '还', '把', '被', '让',
  '给', '对', '从', '到', '上', '下', '中', '里', '外', '时', '会', '能',
  '要', '将', '之', '其', '这', '那', '我', '你', '他', '她', '它',
  // English
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'and', 'but', 'or', 'nor',
  'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
  'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'where', 'how', 'what', 'which', 'who', 'whom',
  'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our',
  'you', 'your', 'he', 'him', 'his', 'she', 'her', 'it', 'its',
  'they', 'them', 'their',
])

// ── Tokenizer ─────────────────────────────────────────────────────
function tokenize(text: string): Set<string> {
  if (!text) return new Set()
  // Split by whitespace, punctuation, and CJK character boundaries
  // This handles both Chinese and English text
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]/g, ' ')  // keep CJK + alphanumeric
    .split(/\s+/)
    .filter(t => t.length > 0 && !STOPWORDS.has(t))

  // For Chinese: also extract bigrams from continuous CJK runs
  // to capture multi-character terms like "螺纹钢", "供应商"
  const cjkRuns = text.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    // Add bigrams
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.substring(i, i + 2)
      if (!STOPWORDS.has(bigram)) {
        tokens.push(bigram)
      }
    }
    // Add trigrams for longer runs
    for (let i = 0; i < run.length - 2; i++) {
      const trigram = run.substring(i, i + 3)
      if (!STOPWORDS.has(trigram)) {
        tokens.push(trigram)
      }
    }
  }

  return new Set(tokens)
}

// ── Jaccard similarity ────────────────────────────────────────────
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// ── Main ──────────────────────────────────────────────────────────
interface MemoryBubble {
  id: string
  title: string
  summary: string | null
  content: string
}

function main() {
  console.log(`[backfill] Opening database: ${dbPath}`)
  const db = new Database(dbPath, { readonly: false })

  // 1. Read all memory bubbles
  const memories = db.prepare(
    "SELECT id, title, summary, content FROM bubbles WHERE type = 'memory' AND deleted_at IS NULL"
  ).all() as MemoryBubble[]

  console.log(`[backfill] Found ${memories.length} memory bubbles`)

  if (memories.length < 2) {
    console.log('[backfill] Not enough memory bubbles to create links')
    db.close()
    return
  }

  // 2. Get existing links for dedup
  const existingLinks = new Set<string>()
  const existingRows = db.prepare(
    'SELECT source_id, target_id, relation FROM bubble_links'
  ).all() as Array<{ source_id: string; target_id: string; relation: string }>
  for (const row of existingRows) {
    existingLinks.add(`${row.source_id}|${row.target_id}|${row.relation}`)
  }
  console.log(`[backfill] Found ${existingLinks.size} existing links`)

  // 3. Precompute tokens for each memory
  const tokensMap = new Map<string, Set<string>>()
  for (const m of memories) {
    // Combine title + summary + content for keyword extraction
    const text = [m.title, m.summary || '', m.content].join(' ')
    tokensMap.set(m.id, tokenize(text))
  }

  // 4. Compute pairwise similarity and create links
  const insertStmt = db.prepare(`
    INSERT INTO bubble_links (source_id, target_id, relation, weight, link_source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  let created = 0
  const now = Date.now()

  // Use a transaction for atomicity
  const insertMany = db.transaction(() => {
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i]
        const b = memories[j]
        const tokensA = tokensMap.get(a.id)!
        const tokensB = tokensMap.get(b.id)!

        const sim = jaccard(tokensA, tokensB)
        if (sim === 0) continue

        const weight = Math.round(sim * 0.8 * 100) / 100  // scale by 0.8 as specified

        // Check dedup — both directions
        const keyAB = `${a.id}|${b.id}|related_to`
        const keyBA = `${b.id}|${a.id}|related_to`
        if (existingLinks.has(keyAB) || existingLinks.has(keyBA)) continue

        insertStmt.run(a.id, b.id, 'related_to', weight, 'inferred', now)
        existingLinks.add(keyAB)  // prevent duplicates within this run
        created++

        console.log(`  + ${a.title} ↔ ${b.title} (weight=${weight}, jaccard=${sim.toFixed(3)})`)
      }
    }
  })

  insertMany()

  console.log(`\n[backfill] Created ${created} new related_to links`)
  console.log(`[backfill] Total links now: ${existingRows.length + created}`)

  db.close()
}

main()
