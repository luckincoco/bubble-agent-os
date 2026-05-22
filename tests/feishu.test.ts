import { describe, it, expect, vi, beforeEach } from 'vitest'

// ══════════════════════════════════════════════════════════════════
//  vi.hoisted: shared mock objects for vi.mock factories
// ══════════════════════════════════════════════════════════════════

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}))

// Lark SDK mocks
const mockMessageCreate = vi.hoisted(() => vi.fn())
const mockMessageReply = vi.hoisted(() => vi.fn())
const mockMessageResourceGet = vi.hoisted(() => vi.fn())
const mockClient = vi.hoisted(() => ({
  request: vi.fn(),
  im: {
    v1: {
      message: { create: mockMessageCreate, reply: mockMessageReply },
      messageResource: { get: mockMessageResourceGet },
    },
  },
}))
const mockWSClient = vi.hoisted(() => ({ start: vi.fn() }))
const mockEventDispatcher = vi.hoisted(() => ({ register: vi.fn() }))

// Router mock
const mockRouterHandle = vi.hoisted(() => vi.fn())

// Identity mock
const mockResolveIdentity = vi.hoisted(() => vi.fn())

// DB mocks
const mockStmt = vi.hoisted(() => ({ get: vi.fn(), all: vi.fn(), run: vi.fn() }))
const mockDb = vi.hoisted(() => ({ prepare: vi.fn(() => mockStmt) }))

// OCR mock
const mockRecognizeImage = vi.hoisted(() => vi.fn())

// ══════════════════════════════════════════════════════════════════
//  Module-level mocks
// ══════════════════════════════════════════════════════════════════

vi.mock('../src/shared/logger.js', () => ({ logger: mockLogger }))

vi.mock('../src/storage/database.js', () => ({
  getDatabase: vi.fn(() => mockDb),
}))

vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(function() { return mockClient }),
  WSClient: vi.fn(function() { return mockWSClient }),
  EventDispatcher: vi.fn(function() { return mockEventDispatcher }),
  Domain: { Feishu: 'feishu' },
}))

vi.mock('../src/connector/router.js', () => ({
  MessageRouter: vi.fn(function() { return { handle: mockRouterHandle } }),
}))

vi.mock('../src/connector/identity.js', () => ({
  resolveIdentity: mockResolveIdentity,
}))

vi.mock('../src/connector/ocr.js', () => ({
  recognizeImage: mockRecognizeImage,
}))

// ══════════════════════════════════════════════════════════════════
//  Imports
// ══════════════════════════════════════════════════════════════════

import { FeishuConnector } from '../src/connector/feishu.js'

// ══════════════════════════════════════════════════════════════════
//  Test helpers
// ══════════════════════════════════════════════════════════════════

function brainMock() {
  return { think: vi.fn().mockResolvedValue({ response: 'brain response' }) } as any
}

/** Minimal message data for handleMessage */
function textMessage(overrides: Record<string, any> = {}): any {
  return {
    message: {
      chat_id: 'chat-admin-1',
      content: JSON.stringify({ text: 'hello world' }),
      message_type: 'text',
      chat_type: 'p2p',
      message_id: 'msg-1',
      mentions: [],
      ...overrides,
    },
    sender: { sender_id: { open_id: 'open-1' } },
  }
}

function imageMessage(overrides: Record<string, any> = {}): any {
  return {
    message: {
      chat_id: 'chat-admin-1',
      content: JSON.stringify({ image_key: 'img-abc123' }),
      message_type: 'image',
      chat_type: 'p2p',
      message_id: 'msg-img-1',
      ...overrides,
    },
    sender: { sender_id: { open_id: 'open-1' } },
  }
}

// ══════════════════════════════════════════════════════════════════
//  FeishuConnector
// ══════════════════════════════════════════════════════════════════

describe('FeishuConnector', () => {
  let connector: FeishuConnector
  let brain: ReturnType<typeof brainMock>

  function createConnector(tencentConfig?: any) {
    return new FeishuConnector(
      { appId: 'test-id', appSecret: 'test-secret' },
      brain,
      undefined, // surpriseDetector
      tencentConfig,
      undefined, // tools
    )
  }

  beforeEach(() => {
    vi.clearAllMocks()

    // Re-establish chain returns
    mockEventDispatcher.register.mockReturnValue(mockEventDispatcher)
    mockRouterHandle.mockResolvedValue({ response: 'bot response' })

    // DB mocks — use mockReset to clear stale mockReturnValueOnce queues
    mockStmt.get.mockReset()
    mockStmt.get.mockReturnValue(undefined)
    mockStmt.all.mockReset()
    mockStmt.all.mockReturnValue([])
    mockStmt.run.mockReset()
    mockStmt.run.mockReturnValue({ changes: 1 })

    // Client API
    mockMessageCreate.mockResolvedValue(undefined)
    mockMessageReply.mockResolvedValue(undefined)
    mockMessageResourceGet.mockResolvedValue(Buffer.from('fake-image-data'))
    mockClient.request.mockResolvedValue({ bot: { open_id: 'bot-open-id' } })

    // OCR
    mockRecognizeImage.mockResolvedValue({
      text: 'OCR recognizes text in this image with high accuracy',
      regions: [{ text: 'OCR', confidence: 0.92 }],
      averageConfidence: 0.92,
    })

    // Identity
    mockResolveIdentity.mockReturnValue({ userId: 'feishu-user', spaceIds: [], activeSpaceId: '' })

    brain = brainMock()
    connector = createConnector()
  })

  // ── Constructor ──────────────────────────────────────────────

  it('constructor initializes Lark SDK clients and router', () => {
    // Internal state should be wired to the mocks returned by factory fns
    expect((connector as any).client).toBe(mockClient)
    expect((connector as any).wsClient).toBe(mockWSClient)
    expect((connector as any).router).toBeDefined()
    expect((connector as any).tencentConfig).toBeNull()
  })

  it('constructor stores tencentConfig when provided', () => {
    const cfg = { secretId: 's-id', secretKey: 's-key', region: 'ap-guangzhou' }
    const c = createConnector(cfg)
    expect((c as any).tencentConfig).toEqual(cfg)
  })

  // ── start ────────────────────────────────────────────────────

  it('start() fetches bot info, creates EventDispatcher, starts WS', async () => {
    await connector.start()

    // Bot info fetch
    expect(mockClient.request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://open.feishu.cn/open-apis/bot/v3/info',
    })
    expect((connector as any).botOpenId).toBe('bot-open-id')

    // EventDispatcher created and handler registered
    expect(mockEventDispatcher.register).toHaveBeenCalledWith(
      expect.objectContaining({ 'im.message.receive_v1': expect.any(Function) }),
    )

    // WebSocket started
    expect(mockWSClient.start).toHaveBeenCalledWith(
      expect.objectContaining({ eventDispatcher: mockEventDispatcher }),
    )
  })

  // ── resolveUserContext ────────────────────────────────────────

  it('resolveUserContext returns admin context when admin user found', () => {
    mockStmt.get.mockReturnValue({ id: 'admin-1' })
    mockStmt.all.mockReturnValue([{ space_id: 'space-alpha' }, { space_id: 'space-beta' }])

    const ctx = (connector as any).resolveUserContext()

    expect(ctx).toEqual({
      userId: 'admin-1',
      spaceIds: ['space-alpha', 'space-beta'],
      activeSpaceId: 'space-alpha',
    })
  })

  it('resolveUserContext falls back to feishu user when no admin found', () => {
    mockStmt.get.mockReturnValue(undefined) // no admin user

    const ctx = (connector as any).resolveUserContext()

    expect(ctx).toEqual({ userId: 'feishu', spaceIds: [], activeSpaceId: '' })
  })

  it('resolveUserContext falls back when DB query throws', () => {
    mockStmt.get.mockImplementation(() => { throw new Error('DB gone') })

    const ctx = (connector as any).resolveUserContext()

    expect(ctx).toEqual({ userId: 'feishu', spaceIds: [], activeSpaceId: '' })
    expect(mockLogger.error).not.toHaveBeenCalled() // catch block is silent
  })

  it('resolveUserContext caches result on repeated calls', () => {
    mockStmt.get.mockReturnValue({ id: 'admin-1' })
    mockStmt.all.mockReturnValue([{ space_id: 'space-1' }])

    const ctx1 = (connector as any).resolveUserContext()
    const ctx2 = (connector as any).resolveUserContext()

    expect(ctx1).toEqual(ctx2)
    // DB should have been queried only once
    expect(mockDb.prepare).toHaveBeenCalledTimes(2) // one for user, one for spaces
  })

  // ── handleMessage: dedup ──────────────────────────────────────

  it('handleMessage deduplicates by message_id', async () => {
    const data = textMessage({ message_id: 'dedup-1' })

    await (connector as any).handleMessage(data)
    await (connector as any).handleMessage(data)

    // Router should only have been called once
    expect(mockRouterHandle).toHaveBeenCalledTimes(1)
  })

  // ── handleMessage: group @mention ─────────────────────────────

  it('handleMessage skips group message when bot not mentioned', async () => {
    (connector as any).botOpenId = 'bot-1'
    const data = textMessage({ chat_type: 'group', mentions: [{ id: { open_id: 'other-user' } }] })

    await (connector as any).handleMessage(data)

    expect(mockRouterHandle).not.toHaveBeenCalled()
  })

  it('handleMessage processes group message when bot is mentioned', async () => {
    (connector as any).botOpenId = 'bot-1'
    const data = textMessage({
      chat_type: 'group',
      message_id: 'group-msg-1',
      content: JSON.stringify({ text: '@bot hello team' }),
      mentions: [{ id: { open_id: 'bot-1' } }],
    })

    await (connector as any).handleMessage(data)

    // @mention prefix should be stripped
    expect(mockRouterHandle).toHaveBeenCalledWith('hello team', expect.any(Object))
    // Group reply path uses reply API
    expect(mockMessageReply).toHaveBeenCalled()
  })

  // ── handleMessage: text flow ──────────────────────────────────

  it('handleMessage routes p2p text to router and creates message', async () => {
    const data = textMessage({ message_id: 'p2p-text-1' })
    // Make DB query for admin preferences succeed (p2p capture path)
    mockStmt.get.mockReturnValue({ id: 'admin-1', preferences: '{}' })

    await (connector as any).handleMessage(data)

    expect(mockRouterHandle).toHaveBeenCalledWith('hello world', expect.any(Object))
    // p2p reply uses message.create
    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'chat_id' },
        data: expect.objectContaining({ msg_type: 'text' }),
      }),
    )
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('hello world'))
  })

  // ── handleMessage: unsupported type ───────────────────────────

  it('handleMessage replies unsupported for non-text non-image message', async () => {
    const data = textMessage({ message_type: 'file', message_id: 'file-1' })

    await (connector as any).handleMessage(data)

    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining('文字和图片'),
        }),
      }),
    )
    expect(mockRouterHandle).not.toHaveBeenCalled()
  })

  // ── handleMessage: image without OCR ──────────────────────────

  it('handleMessage image without OCR config replies no-OCR message', async () => {
    // connector was created without tencentConfig
    const data = imageMessage({ message_id: 'img-no-ocr' })

    await (connector as any).handleMessage(data)

    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining('未配置'),
        }),
      }),
    )
    expect(mockRecognizeImage).not.toHaveBeenCalled()
  })

  // ── handleMessage: image with OCR ─────────────────────────────

  it('handleMessage image with OCR config downloads, OCRs, and replies', async () => {
    const cfg = { secretId: 's-id', secretKey: 's-key' }
    const c = createConnector(cfg)
    const data = imageMessage({ message_id: 'img-ocr-1' })
    mockStmt.get.mockReturnValue({ id: 'admin-1', preferences: '{}' })

    await (c as any).handleMessage(data)

    // Download image via Feishu API
    expect(mockMessageResourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.objectContaining({ message_id: 'img-ocr-1', file_key: 'img-abc123' }),
      }),
    )
    // OCR called with downloaded buffer
    expect(mockRecognizeImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      cfg,
    )
    // Brain thought about OCR result
    expect(brain.think).toHaveBeenCalledWith(
      expect.stringContaining('OCR'),
      expect.any(Object),
    )
    // Reply sent
    expect(mockMessageCreate).toHaveBeenCalled()
  })

  // ── handleImageMessage: unparseable content ───────────────────

  it('handleImageMessage replies error on unparseable image content', async () => {
    const cfg = { secretId: 's-id', secretKey: 's-key' }
    const c = createConnector(cfg)
    const msg = { chat_id: 'chat-1', chat_type: 'p2p', message_id: 'bad-img', content: '{broken}' }

    await (c as any).handleImageMessage(msg, 'open-1')

    expect(mockMessageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining('无法解析图片信息'),
        }),
      }),
    )
    expect(mockRecognizeImage).not.toHaveBeenCalled()
  })

  // ── pushMessage ──────────────────────────────────────────────

  it('pushMessage sends text message via create API', async () => {
    await connector.pushMessage('chat-push-1', 'Hello from scheduler')

    expect(mockMessageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'chat-push-1',
        content: JSON.stringify({ text: 'Hello from scheduler' }),
        msg_type: 'text',
      },
    })
  })

  it('pushMessage logs error on API failure', async () => {
    mockMessageCreate.mockRejectedValueOnce(new Error('rate limit'))

    await connector.pushMessage('chat-err', 'test')

    expect(mockLogger.error).toHaveBeenCalledWith(
      'Feishu pushMessage error:',
      'rate limit',
    )
  })

  // ── getAdminChatId ────────────────────────────────────────────

  it('getAdminChatId returns null initially, captured from p2p message', async () => {
    expect(connector.getAdminChatId()).toBeNull()

    // First p2p message captures its chat_id as adminChatId
    const data = textMessage({ chat_id: 'chat-captured-1', message_id: 'capture-1' })
    await (connector as any).handleMessage(data)

    expect(connector.getAdminChatId()).toBe('chat-captured-1')
  })
})
