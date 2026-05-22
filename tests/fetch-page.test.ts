import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createFetchPageTool } from '../src/connector/tools/fetch-page.js'

const mockIsObscuraAvailable = vi.hoisted(() => vi.fn())
const mockRenderPage = vi.hoisted(() => vi.fn())
vi.mock('../src/connector/tools/obscura-client.js', () => ({
  isObscuraAvailable: mockIsObscuraAvailable,
  renderPage: mockRenderPage,
}))

describe('createFetchPageTool', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    mockIsObscuraAvailable.mockReset()
    mockRenderPage.mockReset()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchResponse(html: string, status = 200) {
    globalThis.fetch = async () =>
      new Response(html, { status, statusText: status === 200 ? 'OK' : 'Not Found' })
  }

  it('returns a ToolDefinition with name fetch_page', () => {
    const tool = createFetchPageTool()
    expect(tool.name).toBe('fetch_page')
    expect(tool.parameters).toHaveProperty('url')
    expect(tool.parameters).toHaveProperty('render')
    expect(typeof tool.execute).toBe('function')
  })

  it('returns error when URL is empty', async () => {
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: '' }, {} as any)
    expect(result).toContain('请提供网页 URL')
  })

  it('fetches and extracts text from HTML', async () => {
    mockFetchResponse('<html><body><h1>Title</h1><p>Content here</p></body></html>')
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com' }, {} as any)
    expect(result).toContain('Title')
    expect(result).toContain('Content here')
  })

  it('strips script and style tags', async () => {
    mockFetchResponse(
      '<html><script>alert("x")</script><style>.c{color:red}</style><p>Hello</p></html>',
    )
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com' }, {} as any)
    expect(result).toContain('Hello')
    expect(result).not.toContain('alert')
    expect(result).not.toContain('color:red')
  })

  it('returns error on HTTP failure', async () => {
    mockFetchResponse('Not Found', 404)
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com/404' }, {} as any)
    expect(result).toContain('抓取失败')
    expect(result).toContain('404')
  })

  it('returns error on network error', async () => {
    globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com' }, {} as any)
    expect(result).toContain('抓取出错')
  })

  it('uses obscura render path when render=true and available', async () => {
    mockIsObscuraAvailable.mockReturnValue(true)
    mockRenderPage.mockResolvedValue({ text: 'Rendered page content', url: 'https://example.com' })

    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com', render: 'true' }, {} as any)
    expect(result).toBe('Rendered page content')
    expect(mockRenderPage).toHaveBeenCalledWith('https://example.com', { stealth: true })
  })

  it('falls back to HTTP fetch when render=true but obscura unavailable', async () => {
    mockIsObscuraAvailable.mockReturnValue(false)
    mockFetchResponse('<p>Fallback content</p>')

    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com', render: 'true' }, {} as any)
    expect(result).toContain('Fallback content')
  })

  it('truncates content exceeding MAX_CHARS', async () => {
    const longContent = 'x'.repeat(5000)
    mockFetchResponse(`<p>${longContent}</p>`)
    const tool = createFetchPageTool()
    const result = await tool.execute({ url: 'https://example.com' }, {} as any)
    expect(result).toContain('已截取')
    expect(result!.length).toBeLessThan(4500)
  })
})
