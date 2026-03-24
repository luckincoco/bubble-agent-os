import { createHash } from 'node:crypto'
import { XMLParser } from 'fast-xml-parser'
import type { FastifyInstance } from 'fastify'
import type { Brain } from '../kernel/brain.js'
import type { ToolRegistry } from '../connector/registry.js'
import type { UserContext } from '../shared/types.js'
import type { SurpriseDetector } from '../memory/surprise-detector.js'
import { MessageRouter } from './router.js'
import { getDatabase } from '../storage/database.js'
import { logger } from '../shared/logger.js'

export interface WeComConfig {
  corpId: string
  agentId: number
  secret: string
  token: string
  encodingAESKey: string
}

interface WeComAccessToken {
  token: string
  expiresAt: number
}

const WECOM_API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin'

export class WeComConnector {
  private config: WeComConfig
  private brain: Brain
  private router: MessageRouter
  private userCtx: UserContext | null = null

  private tokenCache: WeComAccessToken | null = null
  private tokenPromise: Promise<string> | null = null

  private processedMsgIds = new Set<string>()
  private static readonly MAX_DEDUP_SIZE = 500

  private xmlParser = new XMLParser()

  constructor(
    config: WeComConfig,
    brain: Brain,
    surpriseDetector?: SurpriseDetector,
    _tencentConfig?: { secretId: string; secretKey: string; region?: string },
    tools?: ToolRegistry,
  ) {
    this.config = config
    this.brain = brain
    this.router = new MessageRouter({ brain, tools, surpriseDetector })
  }

  /** Resolve the admin user context from database */
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
      this.userCtx = { userId: 'wecom', spaceIds: [], activeSpaceId: '' }
    }

    return this.userCtx
  }

  // ─── Access Token Management ───────────────────────────────────

  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.token
    }

    // Prevent concurrent refresh requests
    if (this.tokenPromise) return this.tokenPromise

    this.tokenPromise = this.fetchAccessToken()
    try {
      return await this.tokenPromise
    } finally {
      this.tokenPromise = null
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const url = `${WECOM_API_BASE}/gettoken?corpid=${this.config.corpId}&corpsecret=${this.config.secret}`
    const resp = await fetch(url)
    const data = await resp.json() as { errcode: number; errmsg: string; access_token?: string; expires_in?: number }

    if (data.errcode !== 0 || !data.access_token) {
      throw new Error(`WeCom gettoken failed: ${data.errmsg} (code=${data.errcode})`)
    }

    // Cache with 5-minute early refresh buffer
    this.tokenCache = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in || 7200) - 300) * 1000,
    }

    logger.info('WeCom access token refreshed')
    return data.access_token
  }

  // ─── Message Sending ───────────────────────────────────────────

  private async sendTextMessage(toUser: string, text: string): Promise<void> {
    const token = await this.getAccessToken()
    const url = `${WECOM_API_BASE}/message/send?access_token=${token}`
    const body = {
      touser: toUser,
      msgtype: 'text',
      agentid: this.config.agentId,
      text: { content: text },
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await resp.json() as { errcode: number; errmsg: string }

    if (data.errcode !== 0) {
      logger.error(`WeCom sendMessage failed: ${data.errmsg} (code=${data.errcode})`)
    }
  }

  /** Public: push a text message to a user (used by scheduler tasks) */
  async pushMessage(userId: string, text: string): Promise<void> {
    try {
      await this.sendTextMessage(userId, text)
    } catch (err) {
      logger.error('WeCom pushMessage error:', err instanceof Error ? err.message : String(err))
    }
  }

  // ─── Crypto Helpers ────────────────────────────────────────────

  private verifySignature(token: string, timestamp: string, nonce: string, encrypt: string, msgSignature: string): boolean {
    const items = [token, timestamp, nonce, encrypt].sort()
    const hash = createHash('sha1').update(items.join('')).digest('hex')
    return hash === msgSignature
  }

  private async decryptMessage(encryptedText: string): Promise<{ message: string; id: string }> {
    const { decrypt } = await import('@wecom/crypto')
    return decrypt(this.config.encodingAESKey, encryptedText)
  }

  // ─── Route Registration ────────────────────────────────────────

  registerRoutes(app: FastifyInstance): void {
    // Register XML content type parser so Fastify can handle WeCom POST bodies
    app.addContentTypeParser(['application/xml', 'text/xml'], { parseAs: 'string' }, (_req, body, done) => {
      done(null, body)
    })

    // GET /wecom/callback — URL verification
    app.get('/wecom/callback', async (req, reply) => {
      const query = req.query as Record<string, string>
      const { msg_signature, timestamp, nonce, echostr } = query

      if (!msg_signature || !timestamp || !nonce || !echostr) {
        return reply.code(400).send('Missing parameters')
      }

      // Verify signature
      if (!this.verifySignature(this.config.token, timestamp, nonce, echostr, msg_signature)) {
        logger.warn('WeCom callback verification: signature mismatch')
        return reply.code(403).send('Invalid signature')
      }

      // Decrypt echostr and return plaintext
      try {
        const { message } = await this.decryptMessage(echostr)
        logger.info('WeCom callback verification: success')
        return reply.type('text/plain').send(message)
      } catch (err) {
        logger.error('WeCom callback verification failed:', err instanceof Error ? err.message : String(err))
        return reply.code(500).send('Decrypt failed')
      }
    })

    // POST /wecom/callback — Receive messages
    app.post('/wecom/callback', async (req, reply) => {
      const query = req.query as Record<string, string>
      const { msg_signature, timestamp, nonce } = query
      const xmlBody = req.body as string

      // Must respond within 5 seconds — return immediately, process async
      reply.type('text/plain').send('')

      // Process in background (fire-and-forget)
      this.handleIncoming(xmlBody, msg_signature, timestamp, nonce)
        .catch(err => logger.error('WeCom handleIncoming error:', err instanceof Error ? err.message : String(err)))
    })

    logger.info('WeCom connector: callback routes registered at /wecom/callback')
  }

  // ─── Message Processing ────────────────────────────────────────

  private async handleIncoming(xmlBody: string, msgSignature: string, timestamp: string, nonce: string): Promise<void> {
    // Parse outer XML to extract <Encrypt> field
    let encryptedText: string
    try {
      const parsed = this.xmlParser.parse(xmlBody)
      encryptedText = parsed?.xml?.Encrypt
      if (!encryptedText) {
        logger.warn('WeCom: no Encrypt field in callback XML')
        return
      }
    } catch (err) {
      logger.error('WeCom XML parse error:', err instanceof Error ? err.message : String(err))
      return
    }

    // Verify signature
    if (!this.verifySignature(this.config.token, timestamp, nonce, encryptedText, msgSignature)) {
      logger.warn('WeCom message: signature verification failed')
      return
    }

    // Decrypt
    let decryptedXml: string
    try {
      const result = await this.decryptMessage(encryptedText)
      decryptedXml = result.message
    } catch (err) {
      logger.error('WeCom decrypt error:', err instanceof Error ? err.message : String(err))
      return
    }

    // Parse inner XML to get message fields
    let msgData: Record<string, any>
    try {
      const parsed = this.xmlParser.parse(decryptedXml)
      msgData = parsed?.xml
      if (!msgData) {
        logger.warn('WeCom: no xml root in decrypted message')
        return
      }
    } catch (err) {
      logger.error('WeCom inner XML parse error:', err instanceof Error ? err.message : String(err))
      return
    }

    const { MsgId, MsgType, Content, FromUserName } = msgData

    // Deduplicate (WeCom retries on 5s timeout)
    const msgId = String(MsgId || '')
    if (msgId) {
      if (this.processedMsgIds.has(msgId)) return
      this.processedMsgIds.add(msgId)
      if (this.processedMsgIds.size > WeComConnector.MAX_DEDUP_SIZE) {
        const first = this.processedMsgIds.values().next().value
        if (first) this.processedMsgIds.delete(first)
      }
    }

    // Only handle text messages in v1
    if (MsgType !== 'text') {
      if (FromUserName) {
        await this.sendTextMessage(String(FromUserName), '目前支持文字消息哦~')
      }
      return
    }

    const text = String(Content || '').trim()
    if (!text) return

    const userId = String(FromUserName || 'unknown')
    logger.info(`WeCom message from ${userId}: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`)

    const ctx = this.resolveUserContext()

    try {
      const { response } = await this.router.handle(text, ctx)
      await this.sendTextMessage(userId, response)
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      logger.error('WeCom think error:', errMsg)
      await this.sendTextMessage(userId, '处理消息时出错，请稍后重试')
    }
  }
}
