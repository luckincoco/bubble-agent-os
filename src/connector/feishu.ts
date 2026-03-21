import * as Lark from '@larksuiteoapi/node-sdk'
import type { Brain } from '../kernel/brain.js'
import type { ToolRegistry } from '../connector/registry.js'
import type { UserContext } from '../shared/types.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export interface TencentOCRConfig {
  secretId: string
  secretKey: string
  region?: string
}

/** Keywords that indicate the user wants a web search */
const SEARCH_INTENT_RE = /搜索|查一下|查询下|查询|搜一下|搜下|检索|今[天日].*价格|最新.*价格|实时|行情|现货|报价|新闻|帮我[查搜找]|价格.*多少/

/** Keywords for steel price queries — prefer steelx2.com over Tavily */
const STEEL_PRICE_RE = /钢[材筋]|螺纹|盘螺|高线|圆钢|工字钢|角钢|槽钢|H型钢|焊管/
const STEEL_PRICE_URL = 'https://shanghai.steelx2.com/city/Quotation/quotation/1/index.html'

export class FeishuConnector {
  private client: Lark.Client
  private wsClient: Lark.WSClient
  private brain: Brain
  private tools: ToolRegistry | null = null
  private userCtx: UserContext | null = null
  private surpriseDetector: SurpriseDetector | null = null
  private tencentConfig: TencentOCRConfig | null = null
  private botOpenId: string | null = null
  /** Track processed message IDs to prevent duplicate handling on WS reconnect */
  private processedMsgIds = new Set<string>()
  private static readonly MAX_DEDUP_SIZE = 500

  constructor(config: FeishuConfig, brain: Brain, surpriseDetector?: SurpriseDetector, tencentConfig?: TencentOCRConfig, tools?: ToolRegistry) {
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Lark.Domain.Feishu,
    }

    this.client = new Lark.Client(baseConfig)
    this.wsClient = new Lark.WSClient(baseConfig)
    this.brain = brain
    this.surpriseDetector = surpriseDetector ?? null
    this.tencentConfig = tencentConfig ?? null
    this.tools = tools ?? null
  }

  /** Resolve the admin user context from database (run after DB is initialized) */
  private resolveUserContext(): UserContext {
    if (this.userCtx) return this.userCtx

    try {
      const db = getDatabase()
      const user = db.prepare('SELECT id FROM users WHERE role = ? LIMIT 1').get('admin') as { id: string } | undefined
      if (!user) throw new Error('No admin user found')

      const spaces = db.prepare('SELECT space_id FROM user_spaces WHERE user_id = ?').all(user.id) as Array<{ space_id: string }>
      this.userCtx = {
        userId: user.id,
        spaceIds: spaces.map(s => s.space_id),
        activeSpaceId: spaces[0]?.space_id || '',
      }
    } catch {
      this.userCtx = { userId: 'feishu', spaceIds: [], activeSpaceId: '' }
    }

    return this.userCtx
  }

  async start() {
    // Resolve bot's own open_id for group @mention filtering
    try {
      const res = await this.client.request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
      }) as any
      this.botOpenId = res?.bot?.open_id ?? null
      if (this.botOpenId) {
        logger.info(`Feishu bot open_id: ${this.botOpenId}`)
      }
    } catch {
      logger.warn('Feishu: could not resolve bot open_id, group @mention filter disabled')
    }

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        await this.handleMessage(data)
      },
    })

    this.wsClient.start({ eventDispatcher })
    logger.info('Feishu connector: WebSocket started (泡泡飞书机器人)')
  }

  private async handleMessage(data: any) {
    const msg = data?.message
    if (!msg) return

    const { chat_id, content, message_type, chat_type, message_id, mentions } = msg

    // Deduplicate: skip messages already processed (Feishu WS re-delivers on reconnect)
    if (message_id) {
      if (this.processedMsgIds.has(message_id)) return
      this.processedMsgIds.add(message_id)
      // Evict oldest entries when set grows too large
      if (this.processedMsgIds.size > FeishuConnector.MAX_DEDUP_SIZE) {
        const first = this.processedMsgIds.values().next().value
        if (first) this.processedMsgIds.delete(first)
      }
    }

    // In group chats, only respond when this bot is @mentioned
    if (chat_type === 'group' && this.botOpenId) {
      const botMentioned = Array.isArray(mentions) && mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      )
      if (!botMentioned) return
    }

    // Handle image messages with OCR
    if (message_type === 'image') {
      await this.handleImageMessage(msg)
      return
    }

    // Only handle text messages for other types
    if (message_type !== 'text') {
      await this.reply(chat_id, chat_type, message_id, '目前支持文字和图片消息哦~')
      return
    }

    let text: string
    try {
      text = JSON.parse(content).text
    } catch {
      return
    }

    // Strip @mention prefix (e.g. "@泡泡 xxx" -> "xxx")
    text = text.replace(/@\S+\s*/g, '').trim()
    if (!text) return

    logger.info(`Feishu message: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`)

    const ctx = this.resolveUserContext()

    try {
      // Proactive data fetch: detect intent and get real-time data
      let searchContext = ''
      if (SEARCH_INTENT_RE.test(text) && this.tools) {
        try {
          if (STEEL_PRICE_RE.test(text)) {
            // Steel price query → fetch steelx2 directly
            logger.info('Feishu: steel price intent detected, fetching steelx2')
            const pageResult = await this.tools.execute('fetch_page', { url: STEEL_PRICE_URL })
            if (pageResult && !pageResult.startsWith('抓取失败') && !pageResult.startsWith('抓取出错')) {
              searchContext = `\n\n[以下是西本新干线今日上海钢材价格数据，请基于这些数据回答用户]\n${pageResult}\n`
              logger.info('Feishu: steelx2 fetch succeeded')
            }
          } else {
            // General search → use Tavily
            logger.info('Feishu: search intent detected, calling web_search')
            const searchResult = await this.tools.execute('web_search', { query: text })
            if (searchResult && !searchResult.startsWith('Error') && !searchResult.startsWith('未配置')) {
              searchContext = `\n\n[以下是实时网络搜索结果，请基于这些数据回答用户]\n${searchResult}\n`
              logger.info('Feishu: web search succeeded')
            }
          }
        } catch (err) {
          logger.error('Feishu search/fetch error:', err instanceof Error ? err.message : String(err))
        }
      }

      const finalInput = searchContext ? `${text}${searchContext}` : text
      const { response } = await this.brain.think(finalInput, ctx)
      await this.reply(chat_id, chat_type, message_id, response)

      // Fire-and-forget: scan message for contradictions
      if (this.surpriseDetector) {
        this.surpriseDetector.scanMessage(text, ctx.activeSpaceId)
          .catch(err => logger.error('SurpriseDetector feishu error:', err instanceof Error ? err.message : String(err)))
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Feishu think error:', errMsg)
      await this.reply(chat_id, chat_type, message_id, '处理消息时出错，请稍后重试')
    }
  }

  /** Handle image message: download from Feishu, run OCR, reply with recognized text */
  private async handleImageMessage(msg: any) {
    const { chat_id, chat_type, message_id, content } = msg

    if (!this.tencentConfig) {
      await this.reply(chat_id, chat_type, message_id, 'OCR 服务未配置，暂时无法识别图片')
      return
    }

    let imageKey: string
    try {
      imageKey = JSON.parse(content).image_key
    } catch {
      await this.reply(chat_id, chat_type, message_id, '无法解析图片信息')
      return
    }

    if (!imageKey) {
      await this.reply(chat_id, chat_type, message_id, '图片信息缺失')
      return
    }

    logger.info(`Feishu image: ${imageKey}`)

    try {
      // Download image from Feishu
      const imageBuffer = await this.downloadImage(message_id, imageKey)

      // Run OCR
      const { recognizeImage } = await import('./ocr.js')
      const result = await recognizeImage(imageBuffer, this.tencentConfig)

      if (!result.text.trim()) {
        await this.reply(chat_id, chat_type, message_id, '图片中未识别到文字')
        return
      }

      // Truncate OCR text to avoid Brain timeout on very long content
      const MAX_OCR_CHARS = 3000
      const ocrText = result.text.length > MAX_OCR_CHARS
        ? result.text.slice(0, MAX_OCR_CHARS) + `\n...(共识别 ${result.regions.length} 个区域，已截取前 ${MAX_OCR_CHARS} 字)`
        : result.text

      // Send OCR result to brain for understanding
      const ctx = this.resolveUserContext()
      const ocrPrompt = `[用户发送了一张图片，OCR识别结果如下]\n${ocrText}\n\n请帮我理解和整理这张图片中的信息。`
      const { response } = await this.brain.think(ocrPrompt, ctx)

      await this.reply(chat_id, chat_type, message_id, response)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Feishu OCR error:', errMsg)
      await this.reply(chat_id, chat_type, message_id, `图片识别失败: ${errMsg}`)
    }
  }

  /** Download image resource from Feishu message */
  private async downloadImage(messageId: string, imageKey: string): Promise<Buffer> {
    const resp = await this.client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: imageKey },
      params: { type: 'image' },
    }) as any

    // Direct buffer
    if (Buffer.isBuffer(resp)) return resp

    // Direct readable stream
    if (resp && typeof resp.pipe === 'function') {
      return this.streamToBuffer(resp)
    }

    // SDK v6+ wraps response: { getReadableStream, writeFile, headers }
    if (typeof resp?.getReadableStream === 'function') {
      const stream = resp.getReadableStream()
      return this.streamToBuffer(stream)
    }

    // Fallback: writeFile to temp
    if (typeof resp?.writeFile === 'function') {
      const tmpPath = `/tmp/feishu-img-${Date.now()}.png`
      await resp.writeFile(tmpPath)
      const { readFileSync, unlinkSync } = await import('node:fs')
      const buf = readFileSync(tmpPath)
      unlinkSync(tmpPath)
      return buf
    }

    throw new Error(`无法获取图片数据 (keys=${resp ? Object.keys(resp).join(',') : 'null'})`)
  }

  private async streamToBuffer(stream: any): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  /** Public: push a text message to a given chat (used by scheduler tasks) */
  async pushMessage(chatId: string, text: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: 'text' },
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Feishu pushMessage error:', errMsg)
    }
  }

  private async reply(chatId: string, chatType: string, messageId: string, text: string) {
    const content = JSON.stringify({ text })

    try {
      if (chatType === 'p2p') {
        await this.client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, content, msg_type: 'text' },
        })
      } else {
        await this.client.im.v1.message.reply({
          path: { message_id: messageId },
          data: { content, msg_type: 'text' },
        })
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('Feishu reply error:', errMsg)
    }
  }
}
