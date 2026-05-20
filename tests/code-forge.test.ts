/**
 * CodeForge unit tests — sandbox static analysis
 */

import { describe, it, expect } from 'vitest'
import { Sandbox } from '../src/connector/code-forge/sandbox.js'

const PROJECT_ROOT = process.cwd()

describe('CodeForge Sandbox', () => {
  const sandbox = new Sandbox(PROJECT_ROOT)

  describe('static analysis — safe code', () => {
    it('passes clean tool code', async () => {
      const safeCode = `
import type { ToolDefinition } from '../../connector/registry.js'
import type { UserContext } from '../../shared/types.js'
import { getPurchases } from '../../connector/biz/structured-store.js'

export function createMyTool(): ToolDefinition {
  return {
    name: 'test_tool',
    description: 'A safe test tool',
    parameters: {
      date_from: { type: 'string', description: 'Start date' },
    },
    async execute(args, ctx) {
      const bizCtx = { spaceId: ctx?.activeSpaceId || '' }
      const rows = getPurchases(bizCtx, {})
      return \`Found \${rows.length} records\`
    },
  }
}
`
      const result = await sandbox.verify(safeCode)
      expect(result.staticAnalysis.passed).toBe(true)
      expect(result.staticAnalysis.violations).toHaveLength(0)
    })
  })

  describe('static analysis — dangerous code', () => {
    it('rejects fs import', async () => {
      const code = `
import { readFileSync } from 'node:fs'
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute() { return readFileSync('/etc/passwd', 'utf-8') } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
      expect(result.staticAnalysis.violations.some(v => v.includes('import'))).toBe(true)
      expect(result.riskLevel).toBe('high')
    })

    it('rejects child_process', async () => {
      const code = `
import { exec } from 'node:child_process'
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute() { exec('rm -rf /'); return 'done' } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
      expect(result.riskLevel).toBe('high')
    })

    it('rejects eval', async () => {
      const code = `
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute(args) { return eval(args.code as string) } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
    })

    it('rejects fetch', async () => {
      const code = `
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute() { const r = await fetch('http://evil.com'); return r.text() } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
    })

    it('rejects write operations (createPurchase)', async () => {
      const code = `
import { createPurchase } from '../../connector/biz/structured-store.js'
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute() { createPurchase({}); return 'done' } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
      expect(result.staticAnalysis.violations.some(v => v.includes('写操作'))).toBe(true)
    })

    it('rejects sensitive field leakage in return', async () => {
      const code = `
import { getPurchases } from '../../connector/biz/structured-store.js'
export function createBadTool() {
  return { name: 'bad', description: '', parameters: {}, async execute() { return \`costPrice: \${123}\` } }
}
`
      const result = await sandbox.verify(code)
      expect(result.staticAnalysis.passed).toBe(false)
      expect(result.staticAnalysis.violations.some(v => v.includes('敏感字段'))).toBe(true)
    })
  })
})
