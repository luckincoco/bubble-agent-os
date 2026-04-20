import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { calcSurprise } from '../../memory/manager.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import type { BubbleType } from '../../shared/types.js'

// ── Interfaces ──────────────────────────────────────────────

interface FeedSource {
  id: string
  name: string
  type: 'rss' | 'web_scrape'
  url: string
  tags: string[]
  enabled: boolean
  spaceId?: string | null
}

interface FeedItem {
  id: string
  title: string
  content: string
  url?: string
  publishedAt?: number
  sourceId: string
}

interface FeedWatcherParams {
  feeds: FeedSource[]
  maxItemsPerFeed: number
  maxContentLength: number
  surpriseThreshold: number
}

interface FeedStats {
  checked: number
  fetched: number
  created: number
  skipped: number
  contradictions: number
  errors: number
}

// ── Constants ───────────────────────────────────────────────

const FETCH_TIMEOUT = 15_000
const OVERALL_TIMEOUT = 120_000
const USER_AGENT = 'Mozilla/5.0 (compatible; BubbleAgent/1.0)'

// ── Main executor ───────────────────────────────────────────

export async function executeFeedWatcher(
  params: Record<string, unknown>,
  _deps: TaskDeps,
): Promise<TaskResult> {
  const cfg = parseParams(params)
  const enabledFeeds = cfg.feeds.filter(f => f.enabled)

  if (enabledFeeds.length === 0) {
    return { success: true, message: '订阅巡查: 无启用的信息源' }
  }

  const defaultSpaceId = getDefaultSpaceId()
  const stats: FeedStats = { checked: 0, fetched: 0, created: 0, skipped: 0, contradictions: 0, errors: 0 }
  const allBubbleIds: string[] = []
  const startTime = Date.now()

  for (const feed of enabledFeeds) {
    if (Date.now() - startTime > OVERALL_TIMEOUT) {
      logger.warn(`FeedWatcher: 超时, 已处理 ${stats.checked}/${enabledFeeds.length} 个源`)
      break
    }

    stats.checked++
    try {
      const result = await processSingleFeed(feed, cfg, defaultSpaceId)
      stats.fetched += result.fetched
      stats.created += result.created
      stats.skipped += result.skipped
      stats.contradictions += result.contradictions
      allBubbleIds.push(...result.bubbleIds)
    } catch (err) {
      stats.errors++
      logger.error(`FeedWatcher: 源 "${feed.name}" (${feed.id}) 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const message = `订阅巡查: 检查 ${stats.checked} 源, 抓取 ${stats.fetched} 条, 新增 ${stats.created} 条, 跳过 ${stats.skipped} 条, 矛盾 ${stats.contradictions} 条${stats.errors > 0 ? `, 错误 ${stats.errors} 个` : ''}`
  logger.info(`FeedWatcher: ${message}`)

  return {
    success: stats.errors < stats.checked,
    message,
    bubbleIds: allBubbleIds,
  }
}

// ── Single feed processing ──────────────────────────────────

interface SingleFeedResult {
  fetched: number
  created: number
  skipped: number
  contradictions: number
  bubbleIds: string[]
}

async function processSingleFeed(
  feed: FeedSource,
  cfg: FeedWatcherParams,
  defaultSpaceId: string | undefined,
): Promise<SingleFeedResult> {
  const result: SingleFeedResult = { fetched: 0, created: 0, skipped: 0, contradictions: 0, bubbleIds: [] }

  // Fetch
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  })

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }

  const body = await res.text()
  if (!body.trim()) {
    throw new Error('空响应')
  }

  // Parse
  let items: FeedItem[]
  if (feed.type === 'rss') {
    items = parseRSSItems(body, feed.id, cfg.maxContentLength)
  } else {
    items = parseWebPage(body, feed, cfg.maxContentLength)
  }

  // Limit per feed
  items = items.slice(0, cfg.maxItemsPerFeed)
  result.fetched = items.length

  // Process each item
  const spaceId = feed.spaceId || defaultSpaceId
  const db = getDatabase()

  for (const item of items) {
    try {
      // Dedup
      const hash = computeContentHash(item)
      const existing = db.prepare(
        "SELECT id FROM bubbles WHERE json_extract(metadata, '$.feedItemHash') = ? LIMIT 1",
      ).get(hash) as { id: string } | undefined

      if (existing) {
        result.skipped++
        continue
      }

      // Surprise check
      const related = searchBubbles(item.title, 10, spaceId ? [spaceId] : undefined)
      const { score, contradicts, nearDuplicate } = calcSurprise(
        item.content,
        related,
      )

      if (score < cfg.surpriseThreshold && !contradicts) {
        result.skipped++
        logger.debug(`FeedWatcher: 跳过低惊奇 [${feed.id}] score=${score.toFixed(2)} "${item.title.slice(0, 40)}"`)
        continue
      }

      // Determine confidence based on surprise
      let confidence: number
      if (contradicts) {
        confidence = 1.0
      } else if (score > 0.6) {
        confidence = 0.85
      } else {
        confidence = 0.7
      }

      // Create bubble
      const bubble = createBubble({
        type: 'event' as BubbleType,
        title: item.title.slice(0, 100),
        content: item.content,
        tags: ['feed-watcher', feed.id, ...feed.tags],
        source: 'feed-watcher',
        confidence,
        decayRate: 0.15,
        metadata: {
          feedItemHash: hash,
          feedId: feed.id,
          url: item.url,
          publishedAt: item.publishedAt,
          surpriseScore: score,
          fetchedAt: Date.now(),
        },
        spaceId,
      })

      result.created++
      result.bubbleIds.push(bubble.id)

      // Link contradictions
      if (contradicts && nearDuplicate) {
        addLink(bubble.id, nearDuplicate.id, 'contradicts', 1.0, 'feed-watcher')
        result.contradictions++
        logger.info(`FeedWatcher: 矛盾检测 [${feed.id}] "${item.title.slice(0, 40)}"`)
      }
    } catch (err) {
      logger.debug(`FeedWatcher: 处理条目失败 [${feed.id}] "${item.title.slice(0, 30)}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return result
}

// ── RSS/Atom parser ─────────────────────────────────────────

function parseRSSItems(xml: string, sourceId: string, maxContentLen: number): FeedItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  })

  const doc = parser.parse(xml)
  const items: FeedItem[] = []

  // RSS 2.0: rss.channel.item
  // Atom: feed.entry
  let rawItems: unknown[]
  if (doc.rss?.channel?.item) {
    rawItems = Array.isArray(doc.rss.channel.item) ? doc.rss.channel.item : [doc.rss.channel.item]
  } else if (doc.feed?.entry) {
    rawItems = Array.isArray(doc.feed.entry) ? doc.feed.entry : [doc.feed.entry]
  } else if (doc['rdf:RDF']?.item) {
    // RSS 1.0 (RDF) — used by some arXiv feeds
    rawItems = Array.isArray(doc['rdf:RDF'].item) ? doc['rdf:RDF'].item : [doc['rdf:RDF'].item]
  } else {
    return items
  }

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>

    // Title
    let title = extractText(entry.title) || ''
    title = title.trim()
    if (!title) continue

    // Content: prefer longer content
    const contentEncoded = extractText(entry['content:encoded'])
    const description = extractText(entry.description)
    const summary = extractText(entry.summary)
    const content = extractText(entry.content)
    const rawContent = contentEncoded || description || summary || content || ''
    const cleanContent = stripHTML(rawContent).slice(0, maxContentLen)

    if (!cleanContent) continue

    // URL
    let url: string | undefined
    if (typeof entry.link === 'string') {
      url = entry.link
    } else if (entry.link && typeof entry.link === 'object') {
      const linkObj = entry.link as Record<string, unknown>
      url = (linkObj['@_href'] as string) || undefined
      // Atom may have array of links
      if (!url && Array.isArray(entry.link)) {
        for (const l of entry.link as Record<string, unknown>[]) {
          if (l['@_rel'] === 'alternate' || !l['@_rel']) {
            url = l['@_href'] as string
            break
          }
        }
      }
    }

    // ID (guid)
    const guid = extractText(entry.guid) || extractText(entry.id) || url || ''

    // Published date
    const dateStr = extractText(entry.pubDate) || extractText(entry.updated) || extractText(entry.published) || extractText(entry['dc:date'])
    let publishedAt: number | undefined
    if (dateStr) {
      const parsed = Date.parse(dateStr)
      if (!isNaN(parsed)) publishedAt = parsed
    }

    items.push({
      id: guid,
      title: stripHTML(title),
      content: cleanContent,
      url,
      publishedAt,
      sourceId,
    })
  }

  return items
}

// ── Web page scraper ────────────────────────────────────────

function parseWebPage(html: string, source: FeedSource, maxContentLen: number): FeedItem[] {
  // Extract <title>
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleMatch ? titleMatch[1].trim() : source.name

  const content = stripHTML(html).slice(0, maxContentLen)
  if (!content) return []

  return [{
    id: source.url,
    title,
    content,
    url: source.url,
    publishedAt: Date.now(),
    sourceId: source.id,
  }]
}

// ── Utilities ───────────────────────────────────────────────

function parseParams(raw: Record<string, unknown>): FeedWatcherParams {
  const feeds = Array.isArray(raw.feeds) ? (raw.feeds as FeedSource[]) : []
  return {
    feeds,
    maxItemsPerFeed: Number(raw.maxItemsPerFeed) || 10,
    maxContentLength: Number(raw.maxContentLength) || 2000,
    surpriseThreshold: Number(raw.surpriseThreshold) || 0.3,
  }
}

function computeContentHash(item: FeedItem): string {
  const input = item.url || item.id || (item.title + item.content.slice(0, 200))
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

function getDefaultSpaceId(): string | undefined {
  const db = getDatabase()
  const row = db.prepare('SELECT DISTINCT space_id FROM bubbles WHERE space_id IS NOT NULL LIMIT 1').get() as { space_id: string } | undefined
  return row?.space_id
}

function extractText(val: unknown): string {
  if (val == null) return ''
  if (typeof val === 'string') return val
  if (typeof val === 'number') return String(val)
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>
    // fast-xml-parser may return { '#text': 'value' } for mixed content
    if ('#text' in obj) return String(obj['#text'])
    // Or { _: 'value' } in some configs
    if ('_' in obj) return String(obj._)
  }
  return ''
}

function stripHTML(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim()
}
