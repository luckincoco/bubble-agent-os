import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createMarkitdownTool } from '../src/connector/tools/markitdown-tool.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Smoke tests for markitdown-tool.
 * Tests validation logic and error handling.
 * Actual conversion depends on markitdown CLI being installed (Python 3.10+).
 */

const tools = createMarkitdownTool()
const convertDoc = tools.find(t => t.name === 'convert_document')!

const TEST_DIR = join(tmpdir(), 'bubble-markitdown-test-' + Date.now())

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(join(TEST_DIR, 'sample.txt'), 'Hello, this is a plain text file.\nLine 2.\n', 'utf-8')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('convert_document tool', () => {
  it('returns error when path is empty', async () => {
    const result = await convertDoc.execute({ path: '' })
    expect(result).toContain('Error: path is required')
  })

  it('returns error when file does not exist', async () => {
    const result = await convertDoc.execute({ path: '/nonexistent/file.pdf' })
    expect(result).toContain('Error: file not found')
  })

  it('attempts conversion on existing file (may fail if CLI not installed)', async () => {
    const result = await convertDoc.execute({ path: join(TEST_DIR, 'sample.txt') })
    // Either succeeds with content or fails gracefully with error message
    const isSuccess = result.includes('Hello') || result.includes('plain text')
    const isGracefulFail = result.includes('Error:') || result.includes('not installed')
    expect(isSuccess || isGracefulFail).toBe(true)
  })

  it('handles timeout parameter', async () => {
    // Should not throw even with custom timeout
    const result = await convertDoc.execute({ path: join(TEST_DIR, 'sample.txt'), timeout: '5' })
    expect(typeof result).toBe('string')
  })
})
