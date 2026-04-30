import type { TaskDeps, TaskResult } from '../scheduler.js'
import { createBubble, searchBubbles } from '../../bubble/model.js'
import { addLink } from '../../bubble/links.js'
import { calcSurprise } from '../../memory/manager.js'
import { getDatabase } from '../../storage/database.js'
import { logger } from '../../shared/logger.js'
import { isObscuraAvailable, renderPage } from '../../connector/tools/obscura-client.js'

// ── Stop words: filtered out before query construction ──────────────
const STOP_WORDS = new Set([
  // 中文语法词
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一',
  '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着',
  '没有', '看', '好', '自己', '这', '他', '她', '它',
  // 对话高频无意义词
  '你好', '谢谢', '帮我', '知道', '觉得', '看看', '可能', '应该',
  '感觉', '那个', '这个', '什么', '怎么', '可以', '还是', '就是',
  '然后', '但是', '如果', '因为', '所以', '其实', '已经', '比较',
  '东西', '问题', '情况', '时候', '需要', '现在', '一下', '或者',
  // 英文常见词
  'the', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has',
  'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'and', 'or', 'but', 'for', 'with', 'this', 'that', 'from', 'not',
  // Bubble 系统词
  'bubble', 'agent', '泡泡', '记忆', '搜索',
])

const QUERY_GEN_PROMPT = `你是搜索查询构造器。以下是用户最近对话中的高频词汇（按词频降序）。
请生成 1-3 个有信息价值的搜索查询。

要求：
1. 查询应该是完整的、有搜索目的的短语
2. 优先：人名+最新动态、技术概念+最新成果、专有名词+进展
3. 跳过太泛的查询（如"AI进展"），要具体
4. 如果词汇中没有值得搜索的话题，返回空数组
5. 输出严格 JSON：["query1", "query2"]（最多3个）`

const COUNTER_QUERY_PROMPT = `你是反确认偏差引擎。给定一条已有知识，生成一个搜索查询来寻找可能的反面证据或替代观点。

要求：
1. 查询应该能找到与已有结论相反或至少不同的证据
2. 使用"争议""质疑""反对""替代""风险""局限"等关键词
3. 输出严格 JSON：{"counterQuery": "查询内容"} 或 {"counterQuery": null}（如果不适合反向搜索）`

const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

interface SearchStats {
  queriesGenerated: number
  queriesDeduped: number
  searched: number
  created: number
  skipped: number
  contradictions: number
  deepReads: number
}

export async function executeInterestSearch(
  _params: Record<string, unknown>,
  deps: TaskDeps,
): Promise<TaskResult> {
  const searchLlm = deps.llmRouter?.forCategory('search') ?? deps.llm

  // Step 1: Get active users with focus data
  const userIds = deps.memory.getActiveFocusUserIds()
  if (userIds.length === 0) {
    return { success: true, message: '兴趣搜索: 无活跃用户焦点数据' }
  }

  // Step 2: Collect and merge all users' focus terms
  const mergedTerms = new Map<string, number>()
  for (const userId of userIds) {
    const topics = deps.memory.getRecentTopics(userId)
    for (const { term, freq } of topics) {
      mergedTerms.set(term, (mergedTerms.get(term) || 0) + freq)
    }
  }

  // Step 3: Filter stop words and pure numbers
  const filteredTerms = [...mergedTerms.entries()]
    .filter(([term]) => !STOP_WORDS.has(term) && !/^\d+$/.test(term))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  if (filteredTerms.length === 0) {
    return { success: true, message: '兴趣搜索: 无可搜索的兴趣话题' }
  }

  logger.info(`InterestSearch: ${userIds.length} 用户, ${filteredTerms.length} 个焦点词: ${filteredTerms.map(([t, f]) => `${t}(${f})`).join(', ')}`)

  // Pre-flight dedup: if all focus terms are covered by recent searches, skip LLM call entirely
  const recentQueriesPreCheck = getRecentSearchedQueries()
  if (recentQueriesPreCheck.length > 0) {
    const allCovered = filteredTerms.every(([term]) =>
      recentQueriesPreCheck.some(rq => rq.toLowerCase().includes(term.toLowerCase())),
    )
    if (allCovered) {
      logger.debug(`InterestSearch: all ${filteredTerms.length} focus terms already covered by recent searches, skipping LLM`)
      return { success: true, message: `兴趣搜索: ${filteredTerms.length} 个焦点词近期已全部搜索过，跳过 LLM` }
    }
  }

  // Step 4: LLM constructs search queries (single call, ~200 tokens)
  const termsList = filteredTerms.map(([term, freq]) => `${term} (频率${freq})`).join('\n')
  let queries: string[] = []
  try {
    const response = await searchLlm.chat([
      { role: 'system', content: QUERY_GEN_PROMPT },
      { role: 'user', content: termsList },
    ])
    const text = response.content.trim()
    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = text.match(/\[[\s\S]*?\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      if (Array.isArray(parsed)) {
        queries = parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0).slice(0, 3)
      }
    }
  } catch (err) {
    logger.error(`InterestSearch: LLM query construction failed: ${err instanceof Error ? err.message : String(err)}`)
    return { success: false, message: '兴趣搜索: LLM 查询构造失败' }
  }

  if (queries.length === 0) {
    return { success: true, message: '兴趣搜索: 当前焦点无搜索价值' }
  }

  logger.info(`InterestSearch: LLM 生成 ${queries.length} 个查询: ${queries.join(' | ')}`)

  // Step 5: 24h dedup — check recently searched queries
  const recentQueries = getRecentSearchedQueries()
  const dedupedQueries = queries.filter(q => {
    const qLower = q.toLowerCase()
    return !recentQueries.some(rq => {
      const rqLower = rq.toLowerCase()
      return rqLower.includes(qLower) || qLower.includes(rqLower)
    })
  })

  const stats: SearchStats = {
    queriesGenerated: queries.length,
    queriesDeduped: queries.length - dedupedQueries.length,
    searched: 0,
    created: 0,
    skipped: 0,
    contradictions: 0,
    deepReads: 0,
  }

  if (dedupedQueries.length === 0) {
    return { success: true, message: `兴趣搜索: 生成 ${queries.length} 个查询, 全部近期已搜索过` }
  }

  // Step 6: Search and store results
  const allBubbleIds: string[] = []

  for (const query of dedupedQueries) {
    stats.searched++
    try {
      const result = await deps.tools.execute('web_search', { query, limit: '3' })

      // Skip non-results
      if (result.startsWith('未找到') || result.startsWith('搜索出错') || result.startsWith('未配置') || result.startsWith('请提供')) {
        stats.skipped++
        continue
      }

      // Check surprise against existing knowledge
      const existingBubbles = searchBubbles(query, 10)
      const { score, contradicts, nearDuplicate } = calcSurprise(result, existingBubbles)

      // Skip low-surprise non-contradicting results
      if (score < 0.3 && !contradicts) {
        stats.skipped++
        logger.debug(`InterestSearch: "${query}" skipped (surprise=${score.toFixed(2)})`)
        continue
      }

      // Extract keyword tags from the query
      const queryTags = query
        .split(/[\s,，、]+/)
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
        .slice(0, 5)

      const confidence = contradicts ? 1.0 : score > 0.6 ? 0.85 : 0.7

      const bubble = createBubble({
        type: 'event',
        title: `兴趣搜索: ${query.slice(0, 50)}`,
        content: result,
        tags: ['interest-search', ...queryTags],
        source: 'interest-search',
        confidence,
        decayRate: 0.12,
        metadata: {
          query,
          searchedAt: Date.now(),
          surpriseScore: score,
          focusTerms: filteredTerms.map(([t]) => t),
          source: 'interest-search',
        },
      })
      allBubbleIds.push(bubble.id)
      stats.created++

      if (contradicts) {
        stats.contradictions++
        if (nearDuplicate) {
          addLink(bubble.id, nearDuplicate.id, 'contradicts', 1.0, 'system')
        }
        logger.info(`InterestSearch: 矛盾发现 "${query}" (score=${score.toFixed(2)})`)
      }

      logger.debug(`InterestSearch: "${query}" → bubble ${bubble.id} (surprise=${score.toFixed(2)})`)

      // Step 6b: Deep-read top URL for high-surprise results via Obscura
      if (score >= 0.6 && isObscuraAvailable()) {
        const urls = extractUrlsFromSearchResult(result)
        const topUrl = urls[0]
        if (topUrl) {
          try {
            const deep = await renderPage(topUrl, { timeout: 20000, stealth: true })
            if (deep.text.length > 200) {
              const deepBubble = createBubble({
                type: 'event',
                title: `深度阅读: ${deep.text.slice(0, 50).replace(/\n/g, ' ')}`,
                content: deep.text.slice(0, 6000),
                tags: ['deep-read', 'interest-search', ...queryTags],
                source: 'interest-search-deep',
                confidence: 0.8,
                decayRate: 0.10,
                metadata: {
                  sourceUrl: topUrl,
                  originalQuery: query,
                  surpriseScore: score,
                  readAt: Date.now(),
                  source: 'interest-search-deep',
                },
              })
              addLink(bubble.id, deepBubble.id, 'deep_read', 0.9, 'system')
              allBubbleIds.push(deepBubble.id)
              stats.deepReads++
              logger.info(`InterestSearch: 深度阅读 "${topUrl}" → bubble ${deepBubble.id} (${deep.text.length} chars)`)
            }
          } catch (err) {
            logger.debug(`InterestSearch: 深度阅读失败 "${topUrl}": ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    } catch (err) {
      stats.skipped++
      logger.error(`InterestSearch: search "${query}" failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Step 7: Anti-confirmation bias — counter-query for high-confidence knowledge
  let counterSearched = 0
  try {
    const db = getDatabase()
    // Find high-confidence synthesis/portrait bubbles that haven't been counter-searched
    const highConfRows = db.prepare(
      "SELECT * FROM bubbles WHERE abstraction_level >= 1 AND confidence >= 0.8 AND deleted_at IS NULL AND json_extract(metadata, '$.counterSearched') IS NULL ORDER BY updated_at DESC LIMIT 3",
    ).all() as any[]

    for (const row of highConfRows) {
      try {
        const counterResp = await searchLlm.chat([
          { role: 'system', content: COUNTER_QUERY_PROMPT },
          { role: 'user', content: `标题: ${row.title}\n内容: ${String(row.content).slice(0, 500)}` },
        ])
        const counterMatch = counterResp.content.match(/\{[\s\S]*\}/)
        if (!counterMatch) continue
        const { counterQuery } = JSON.parse(counterMatch[0]) as { counterQuery: string | null }
        if (!counterQuery) continue

        // Execute counter-search
        const counterResult = await deps.tools.execute('web_search', { query: counterQuery, limit: '2' })
        if (counterResult.startsWith('未找到') || counterResult.startsWith('搜索出错') || counterResult.startsWith('未配置')) continue

        const counterBubble = createBubble({
          type: 'observation',
          title: `反向验证: ${counterQuery.slice(0, 40)}`,
          content: counterResult,
          tags: ['counter-search', 'anti-bias'],
          source: 'counter-search',
          confidence: 0.65,
          decayRate: 0.10,
          metadata: { originalBubbleId: row.id, counterQuery, searchedAt: Date.now() },
        })
        addLink(counterBubble.id, row.id, 'challenges', 0.6, 'counter-search')
        allBubbleIds.push(counterBubble.id)
        counterSearched++

        // Mark original bubble as counter-searched
        const existingMeta = row.metadata ? JSON.parse(row.metadata) : {}
        db.prepare('UPDATE bubbles SET metadata = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify({ ...existingMeta, counterSearched: Date.now() }),
          Date.now(),
          row.id,
        )

        logger.info(`InterestSearch: counter-search for "${row.title}" → "${counterQuery}"`)
      } catch (err) {
        logger.debug(`InterestSearch: counter-search failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } catch (err) {
    logger.debug(`InterestSearch: counter-search phase error: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Step 8: Optional Feishu notification
  if (deps.feishu && stats.created > 0) {
    const chatId = deps.feishu?.getAdminChatId() || String(_params.chatId || process.env.FEISHU_ADMIN_CHAT_ID || '')
    if (chatId) {
      try {
        const lines = dedupedQueries.slice(0, 3).map(q => `  - ${q}`)
        await deps.feishu.pushMessage(chatId, `🔍 兴趣搜索完成\n\n搜索话题：\n${lines.join('\n')}\n\n新增 ${stats.created} 条发现${stats.contradictions > 0 ? `，其中 ${stats.contradictions} 条矛盾` : ''}`)
      } catch (err) {
        logger.error(`InterestSearch: Feishu push failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const message = `兴趣搜索: 生成 ${stats.queriesGenerated} 个查询, 去重 ${stats.queriesDeduped} 个, 搜索 ${stats.searched} 个, 新增 ${stats.created} 条, 跳过 ${stats.skipped} 条${stats.contradictions > 0 ? `, 矛盾 ${stats.contradictions} 条` : ''}${stats.deepReads > 0 ? `, 深度阅读 ${stats.deepReads} 条` : ''}${counterSearched > 0 ? `, 反向验证 ${counterSearched} 条` : ''}`
  logger.info(`InterestSearch: ${message}`)

  return {
    success: true,
    message,
    bubbleIds: allBubbleIds,
  }
}

/** Get queries already searched in the last 24 hours */
function getRecentSearchedQueries(): string[] {
  try {
    const db = getDatabase()
    const cutoff = Date.now() - DEDUP_WINDOW_MS
    const rows = db.prepare(
      "SELECT metadata FROM bubbles WHERE json_extract(metadata, '$.source') = 'interest-search' AND created_at > ?",
    ).all(cutoff) as Array<{ metadata: string }>

    const queries: string[] = []
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata)
        if (meta.query) queries.push(meta.query)
      } catch { /* skip malformed */ }
    }
    return queries
  } catch {
    return []
  }
}

/** Extract URLs from Tavily search result text */
function extractUrlsFromSearchResult(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s),]+/g
  const matches = text.match(urlRegex) || []
  // Deduplicate and skip Tavily's own domain
  const seen = new Set<string>()
  return matches.filter(url => {
    if (seen.has(url)) return false
    if (url.includes('tavily.com')) return false
    seen.add(url)
    return true
  })
}
