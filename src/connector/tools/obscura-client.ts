/**
 * Obscura Headless Browser Client
 *
 * Wraps the Obscura CLI binary to provide JS-rendered page fetching.
 * Falls back gracefully when the binary is not installed.
 *
 * CLI usage: obscura fetch <url> --dump text --stealth --quiet --wait-until networkidle0
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { logger } from '../../shared/logger.js'

// ── Configuration ───────────────────────────────────────────

const OBSCURA_BIN = process.env.OBSCURA_BIN || 'obscura'
const OBSCURA_PROXY = process.env.OBSCURA_PROXY || ''
const OBSCURA_TIMEOUT = parseInt(process.env.OBSCURA_TIMEOUT || '30000', 10)

// ── Types ───────────────────────────────────────────────────

export interface ObscuraResult {
  text: string
  url: string
}

export interface ObscuraOptions {
  timeout?: number
  stealth?: boolean
  waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0'
  proxy?: string
}

// ── Availability check ──────────────────────────────────────

let _available: boolean | null = null

/**
 * Check if the Obscura binary is available.
 * Result is cached after first call.
 */
export function isObscuraAvailable(): boolean {
  if (_available !== null) return _available

  // If an explicit path is set, check it exists
  if (process.env.OBSCURA_BIN) {
    _available = existsSync(process.env.OBSCURA_BIN)
    if (_available) {
      logger.info(`Obscura: found at ${process.env.OBSCURA_BIN}`)
    } else {
      logger.debug(`Obscura: binary not found at ${process.env.OBSCURA_BIN}`)
    }
    return _available
  }

  // Otherwise try to execute it
  try {
    const { execFileSync } = require('node:child_process')
    execFileSync(OBSCURA_BIN, ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
    })
    _available = true
    logger.info('Obscura: available in PATH')
  } catch {
    _available = false
    logger.debug('Obscura: not found in PATH (deep-read features disabled)')
  }
  return _available
}

/** Reset availability cache (for testing) */
export function resetAvailabilityCache(): void {
  _available = null
}

// ── Core render function ────────────────────────────────────

/**
 * Render a page using Obscura and return the text content.
 *
 * @param url - The URL to render
 * @param options - Rendering options
 * @returns Rendered page text content
 * @throws Error if rendering fails or times out
 */
export async function renderPage(
  url: string,
  options?: ObscuraOptions,
): Promise<ObscuraResult> {
  const timeout = options?.timeout ?? OBSCURA_TIMEOUT
  const stealth = options?.stealth ?? true
  const waitUntil = options?.waitUntil ?? 'networkidle0'
  const proxy = options?.proxy || OBSCURA_PROXY

  const args: string[] = ['fetch', url, '--dump', 'text', '--wait-until', waitUntil, '--quiet']

  if (stealth) {
    args.push('--stealth')
  }

  // Build environment: inherit current env + optional proxy
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (proxy) {
    env.HTTP_PROXY = proxy
    env.HTTPS_PROXY = proxy
  }

  return new Promise<ObscuraResult>((resolve, reject) => {
    const child = execFile(
      OBSCURA_BIN,
      args,
      {
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr?.trim() || error.message
          logger.debug(`Obscura: render failed for ${url}: ${msg}`)
          reject(new Error(`Obscura render failed: ${msg}`))
          return
        }

        const text = stdout.trim()
        if (!text) {
          reject(new Error('Obscura: empty output'))
          return
        }

        logger.debug(`Obscura: rendered ${url} (${text.length} chars)`)
        resolve({ text, url })
      },
    )

    // Safety: kill child if it somehow exceeds timeout
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeout + 5000)

    child.on('close', () => clearTimeout(killTimer))
  })
}
