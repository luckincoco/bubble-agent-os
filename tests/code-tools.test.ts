import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createCodeTools } from '../src/connector/tools/code-tools.js'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Smoke tests for code-tools (Karpathy P4: Goal-Driven Execution).
 * Success criteria: each tool must produce correct output for basic operations.
 */

const tools = createCodeTools()
const getToolByName = (name: string) => tools.find(t => t.name === name)!

const TEST_DIR = join(tmpdir(), 'bubble-code-tools-test-' + Date.now())
const TEST_FILE = join(TEST_DIR, 'sample.txt')

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  writeFileSync(TEST_FILE, 'line1\nline2\nline3\nline4\nline5\n', 'utf-8')
})

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('code-tools smoke tests', () => {
  describe('read_file', () => {
    it('reads entire file', async () => {
      const result = await getToolByName('read_file').execute({ path: TEST_FILE })
      expect(result).toContain('line1')
      expect(result).toContain('line5')
    })

    it('reads line range', async () => {
      const result = await getToolByName('read_file').execute({ path: TEST_FILE, start_line: '2', end_line: '3' })
      expect(result).toContain('line2')
      expect(result).toContain('line3')
      expect(result).not.toContain('line4')
    })

    it('returns error for missing file', async () => {
      const result = await getToolByName('read_file').execute({ path: '/nonexistent/file.txt' })
      expect(result).toContain('Error')
    })

    it('returns error when path is empty', async () => {
      const result = await getToolByName('read_file').execute({ path: '' })
      expect(result).toContain('Error')
    })
  })

  describe('write_file', () => {
    it('creates new file with content', async () => {
      const newFile = join(TEST_DIR, 'new-file.txt')
      const result = await getToolByName('write_file').execute({ path: newFile, content: 'hello world' })
      expect(result).toContain('Successfully wrote')
      expect(result).toContain('11 bytes')

      // Verify by reading back
      const readResult = await getToolByName('read_file').execute({ path: newFile })
      expect(readResult).toBe('hello world')
    })

    it('creates parent directories', async () => {
      const deepFile = join(TEST_DIR, 'a', 'b', 'c', 'deep.txt')
      const result = await getToolByName('write_file').execute({ path: deepFile, content: 'deep' })
      expect(result).toContain('Successfully wrote')
    })
  })

  describe('list_directory', () => {
    it('lists directory contents', async () => {
      const result = await getToolByName('list_directory').execute({ path: TEST_DIR })
      expect(result).toContain('[FILE]')
      expect(result).toContain('sample.txt')
    })

    it('shows directories with [DIR] prefix', async () => {
      const result = await getToolByName('list_directory').execute({ path: TEST_DIR })
      expect(result).toContain('[DIR]')
    })

    it('returns error for nonexistent directory', async () => {
      const result = await getToolByName('list_directory').execute({ path: '/nonexistent-dir-xyz' })
      expect(result).toContain('Error')
    })
  })

  describe('shell_exec', () => {
    it('executes simple command', async () => {
      const result = await getToolByName('shell_exec').execute({ command: 'echo hello' })
      expect(result).toContain('Exit code: 0')
      expect(result).toContain('hello')
    })

    it('respects cwd', async () => {
      const result = await getToolByName('shell_exec').execute({ command: 'ls sample.txt', cwd: TEST_DIR })
      expect(result).toContain('Exit code: 0')
      expect(result).toContain('sample.txt')
    })

    it('reports non-zero exit code', async () => {
      const result = await getToolByName('shell_exec').execute({ command: 'exit 42' })
      expect(result).toContain('Exit code: 42')
    })

    it('returns error for empty command', async () => {
      const result = await getToolByName('shell_exec').execute({ command: '' })
      expect(result).toContain('Error')
    })
  })
})
