import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mock child_process.exec ───────────────────────────────────────

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }))

vi.mock('node:child_process', () => ({
  exec: mockExec,
}))

// ── Mock node:fs/promises ─────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}))

// ── Mock logger ───────────────────────────────────────────────────

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import after mocks
import { Sandbox } from '../src/connector/code-forge/sandbox.js'

// ── Helpers ───────────────────────────────────────────────────────

function makeExecCallback(err: any = null, stdout = '', stderr = '') {
  return (_cmd: string, _opts: any, cb: Function) => {
    cb(err, stdout, stderr)
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Sandbox', () => {
  let sandbox: Sandbox

  beforeEach(() => {
    vi.clearAllMocks()
    sandbox = new Sandbox('/tmp/test-project')
  })

  describe('staticAnalysis', () => {
    it('detects forbidden imports (fs, child_process, net, http)', () => {
      const code = `import { readFileSync } from 'node:fs'\nimport { exec } from 'child_process'`
      const result = (sandbox as any).staticAnalysis(code)
      expect(result.passed).toBe(false)
      expect(result.violations.length).toBeGreaterThanOrEqual(2)
      expect(result.violations.some((v: string) => v.includes('fs'))).toBe(true)
      expect(result.violations.some((v: string) => v.includes('child_process'))).toBe(true)
    })

    it('detects forbidden calls (eval, new Function, fetch)', () => {
      const code = `const x = eval('1+1')\nconst f = new Function('return 1')`
      const result = (sandbox as any).staticAnalysis(code)
      expect(result.passed).toBe(false)
      expect(result.violations.some((v: string) => v.includes('eval'))).toBe(true)
      expect(result.violations.some((v: string) => v.includes('Function'))).toBe(true)
    })

    it('detects forbidden store write calls', () => {
      const code = `createProduct({ name: 'test' })`
      const result = (sandbox as any).staticAnalysis(code)
      expect(result.passed).toBe(false)
      expect(result.violations.some((v: string) => v.includes('写操作'))).toBe(true)
    })

    it('detects sensitive fields in return values', () => {
      const code = 'return `成本价: ${costPrice}, 利润: ${profit}`'
      const result = (sandbox as any).staticAnalysis(code)
      expect(result.passed).toBe(false)
      expect(result.violations.some((v: string) => v.includes('敏感字段'))).toBe(true)
    })

    it('passes clean code without violations', () => {
      const code = `import type { ToolDefinition } from '../../registry.js'\nexport function createTool() { return { name: 'test' } }`
      const result = (sandbox as any).staticAnalysis(code)
      expect(result.passed).toBe(true)
      expect(result.violations).toHaveLength(0)
    })
  })

  describe('assessRisk', () => {
    it('returns high when static analysis fails', () => {
      const risk = (sandbox as any).assessRisk(
        { passed: false, violations: ['forbidden import'] },
        { passed: true, errors: [] },
      )
      expect(risk).toBe('high')
    })

    it('returns medium when only compilation fails', () => {
      const risk = (sandbox as any).assessRisk(
        { passed: true, violations: [] },
        { passed: false, errors: ['TS error'] },
      )
      expect(risk).toBe('medium')
    })

    it('returns low when all checks pass', () => {
      const risk = (sandbox as any).assessRisk(
        { passed: true, violations: [] },
        { passed: true, errors: [] },
      )
      expect(risk).toBe('low')
    })
  })

  describe('verify', () => {
    it('returns failed when static analysis detects violations', async () => {
      mockExec.mockImplementation(makeExecCallback(null, '', ''))
      const code = `import { readFileSync } from 'fs'`
      const result = await sandbox.verify(code)
      expect(result.passed).toBe(false)
      expect(result.staticAnalysis.passed).toBe(false)
      expect(result.riskLevel).toBe('high')
    })

    it('returns failed when compilation fails', async () => {
      mockExec.mockImplementation(makeExecCallback(
        { code: 1 },
        '',
        'error TS2322: Type mismatch',
      ))
      const code = `const x: number = "string"`
      const result = await sandbox.verify(code)
      expect(result.passed).toBe(false)
      expect(result.compilation.passed).toBe(false)
      expect(result.riskLevel).toBe('medium')
    })

    it('returns passed when all checks pass', async () => {
      mockExec.mockImplementation(makeExecCallback(null, '', ''))
      const code = `const x = 1`
      const result = await sandbox.verify(code)
      expect(result.passed).toBe(true)
      expect(result.staticAnalysis.passed).toBe(true)
      expect(result.compilation.passed).toBe(true)
      expect(result.riskLevel).toBe('low')
    })

    it('handles exec timeout as compilation failure', async () => {
      mockExec.mockImplementation(makeExecCallback(
        { code: null, message: 'timeout' },
        '',
        'timeout',
      ))
      const code = `const x = 1`
      const result = await sandbox.verify(code)
      // exec returns exitCode=null on timeout, callback gets err with no code
      // In this case (err && 'code' in err) is false, so exitCode = 1
      // Actually checking the code: const exitCode = err && 'code' in err ? (err as any).code : (err ? 1 : 0)
      // { code: null } has 'code' in err = true, so exitCode = null
      // null != 0 so !result.compilation.passed
      if (result.staticAnalysis.passed) {
        expect(result.compilation.passed).toBe(false)
      }
    })
  })
})
