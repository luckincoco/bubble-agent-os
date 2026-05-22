import { describe, it, expect, beforeEach, vi } from 'vitest'

const { execFileMock, existsSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  existsSyncMock: vi.fn(),
}))

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
  // Note: isObscuraAvailable uses dynamic require('node:child_process') for execFileSync,
  // which is not intercepted by vi.mock. Tests for that path use the OBSCURA_BIN env var instead.
}))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}))

import {
  isObscuraAvailable,
  resetAvailabilityCache,
  renderPage,
} from '../src/connector/tools/obscura-client.js'

describe('isObscuraAvailable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAvailabilityCache()
    delete process.env.OBSCURA_BIN
  })

  it('checks explicit OBSCURA_BIN path when env var is set and exists', () => {
    process.env.OBSCURA_BIN = '/custom/obscura'
    existsSyncMock.mockReturnValue(true)
    expect(isObscuraAvailable()).toBe(true)
    expect(existsSyncMock).toHaveBeenCalledWith('/custom/obscura')
  })

  it('returns false when OBSCURA_BIN path does not exist', () => {
    process.env.OBSCURA_BIN = '/nonexistent/obscura'
    existsSyncMock.mockReturnValue(false)
    expect(isObscuraAvailable()).toBe(false)
  })

  it('caches result after first call via OBSCURA_BIN path', () => {
    process.env.OBSCURA_BIN = '/bin/obscura'
    existsSyncMock.mockReturnValue(true)
    isObscuraAvailable() // first call
    isObscuraAvailable() // second call
    expect(existsSyncMock).toHaveBeenCalledTimes(1)
    delete process.env.OBSCURA_BIN
  })
})

describe('resetAvailabilityCache', () => {
  it('clears cached availability', () => {
    process.env.OBSCURA_BIN = '/bin/obscura'
    existsSyncMock.mockReturnValue(true)
    expect(isObscuraAvailable()).toBe(true)

    resetAvailabilityCache()
    existsSyncMock.mockReturnValue(false)
    expect(isObscuraAvailable()).toBe(false)
    delete process.env.OBSCURA_BIN
  })
})

describe('renderPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns rendered text and url on success', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: any, cb: any) => {
      cb(null, 'Rendered page content', '')
      return { on: vi.fn() }
    })

    const result = await renderPage('https://example.com')
    expect(result.text).toBe('Rendered page content')
    expect(result.url).toBe('https://example.com')
  })

  it('rejects when execFile returns error', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: any, cb: any) => {
      cb(new Error('Connection failed'), '', 'stderr output')
      return { on: vi.fn() }
    })

    await expect(renderPage('https://example.com')).rejects.toThrow('Obscura render failed')
  })

  it('rejects when stdout is empty', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: any, cb: any) => {
      cb(null, '', '')
      return { on: vi.fn() }
    })

    await expect(renderPage('https://example.com')).rejects.toThrow('empty output')
  })

  it('passes stealth option as --stealth flag', async () => {
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: any, cb: any) => {
      const args = _args as string[]
      expect(args).toContain('--stealth')
      cb(null, 'content', '')
      return { on: vi.fn() }
    })

    await renderPage('https://example.com', { stealth: true })
  })

  it('omits --stealth when stealth is false', async () => {
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: any, cb: any) => {
      expect(args).not.toContain('--stealth')
      cb(null, 'content', '')
      return { on: vi.fn() }
    })

    await renderPage('https://example.com', { stealth: false })
  })

  it('passes proxy option as --proxy before subcommand', async () => {
    execFileMock.mockImplementation((_bin: string, args: string[], _opts: any, cb: any) => {
      const proxyIdx = args.indexOf('--proxy')
      expect(proxyIdx).toBeGreaterThanOrEqual(0)
      expect(args[proxyIdx + 1]).toBe('http://proxy:8080')
      // --proxy should appear before 'fetch' subcommand
      const fetchIdx = args.indexOf('fetch')
      expect(proxyIdx).toBeLessThan(fetchIdx)
      cb(null, 'content', '')
      return { on: vi.fn() }
    })

    await renderPage('https://example.com', { proxy: 'http://proxy:8080' })
  })

  it('attaches close handler to child process', async () => {
    const onMock = vi.fn()
    execFileMock.mockImplementation((_bin: string, _args: string[], _opts: any, cb: any) => {
      cb(null, 'content', '')
      return { on: onMock }
    })

    await renderPage('https://example.com')
    expect(onMock).toHaveBeenCalledWith('close', expect.any(Function))
  })
})
