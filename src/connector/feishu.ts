import * as Lark from '@larksuiteoapi/node-sdk'
import type { Brain } from '../kernel/brain.js'
import type { UserContext } from '../shared/types.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface FeishuConfig {
  appId: string
  appSecret: string
}

export class FeishuConnector {
  private client: Lark.Client
  private wsClient: Lark.WSClient
  private brain: Brain
  private userCtx: UserContext | null = null
  private surpriseDetector: SurpriseDetector | null = null
  private botOpenId: string | null = null

  constructor(config: FeishuConfig, brain: Brain, surpriseDetector?: SurpriseDetector) {
    const baseConfig = {
      appId: config.appId,
      appSecret: config.appSecret,
      domain: Lark.Domain.Feishu,
    }

    this.client = new Lark.Client(baseConfig)
    this.wsClient = new Lark.WSClient(baseConfig)
    this.brain = brain
    this.surpriseDetector = surpriseDetector ?? null
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

    // In group chats, only respond when this bot is @mentioned
    if (chat_type === 'group' && this.botOpenId) {
      const botMentioned = Array.isArray(mentions) && mentions.some(
        (m: any) => m.id?.open_id === this.botOpenId,
      )
      if (!botMentioned) return
    }

    // Only handle text messages
    if (message_type !== 'text') {
      await this.reply(chat_id, chat_type, message_id, '目前只支持文字消息哦~')
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
      const response = await this.brain.think(text, ctx)
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
