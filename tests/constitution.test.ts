import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Import after mocks (none needed — pure functions)
import {
  loadConstitution,
  formatForPhase,
  resetConstitutionCache,
  type BubbleConstitution,
} from '../src/connector/code-forge/constitution.js'

// ── Helpers ────────────────────────────────────────────────────────

function makeOverrideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'constitution-test-'))
  const generated = join(dir, 'src', 'connector', 'tools', 'generated')
  mkdirSync(generated, { recursive: true })
  return dir
}

function writeOverride(dir: string, content: object): void {
  writeFileSync(
    join(dir, 'src', 'connector', 'tools', 'generated', 'constitution.json'),
    JSON.stringify(content),
    'utf8',
  )
}

// ── Tests ──────────────────────────────────────────────────────────

describe('Constitution', () => {
  afterEach(() => {
    resetConstitutionCache()
  })

  describe('loadConstitution', () => {
    it('returns default constitution when no project root', () => {
      const con = loadConstitution()
      expect(con.version).toBe(1)
      expect(con.principles).toHaveLength(7)
      expect(con.securityRules).toHaveLength(6)
      expect(con.antiPatterns).toHaveLength(6)
      expect(con.availableMethods).toHaveLength(10)
      expect(con.domainContext).toContain('Bubble Agent OS')
    })

    it('returns default constitution when no override file exists', () => {
      const dir = mkdtempSync(join(tmpdir(), 'constitution-test-'))
      const con = loadConstitution(dir)
      expect(con.principles).toHaveLength(7)
      rmSync(dir, { recursive: true, force: true })
    })

    it('caches constitution after first load', () => {
      const con1 = loadConstitution()
      const con2 = loadConstitution()
      expect(con1).toBe(con2)
    })

    it('resetConstitutionCache clears the cache', () => {
      const con1 = loadConstitution()
      resetConstitutionCache()
      const con2 = loadConstitution()
      expect(con1).not.toBe(con2)
    })
  })

  describe('override merging', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = makeOverrideDir()
      resetConstitutionCache()
    })

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it('merges new principles from override file', () => {
      writeOverride(tmpDir, {
        principles: [{ name: 'Custom-Principle', description: 'A custom rule' }],
      })
      const con = loadConstitution(tmpDir)
      const custom = con.principles.find(p => p.name === 'Custom-Principle')
      expect(custom).toBeDefined()
      expect(custom!.description).toBe('A custom rule')
      expect(custom!.nonNegotiable).toBe(false)
    })

    it('does not override non-negotiable principles', () => {
      writeOverride(tmpDir, {
        principles: [{ name: 'Query-Only', description: 'evil override' }],
      })
      const con = loadConstitution(tmpDir)
      const qo = con.principles.find(p => p.name === 'Query-Only')
      expect(qo!.description).not.toBe('evil override')
      expect(qo!.description).toContain('禁止任何写操作')
    })

    it('appends domain context from override', () => {
      writeOverride(tmpDir, { domainContext: '额外领域上下文' })
      const con = loadConstitution(tmpDir)
      expect(con.domainContext).toContain('Bubble Agent OS')
      expect(con.domainContext).toContain('额外领域上下文')
    })

    it('appends anti-patterns from override', () => {
      writeOverride(tmpDir, { antiPatterns: ['不要使用 console.log'] })
      const con = loadConstitution(tmpDir)
      expect(con.antiPatterns).toContain('不要使用 console.log')
    })

    it('appends available methods from override', () => {
      writeOverride(tmpDir, { availableMethods: ['customMethod()'] })
      const con = loadConstitution(tmpDir)
      expect(con.availableMethods).toContain('customMethod()')
    })
  })

  describe('formatForPhase', () => {
    let constitution: BubbleConstitution

    beforeEach(() => {
      resetConstitutionCache()
      constitution = loadConstitution()
    })

    it('specify phase includes domain context and principles', () => {
      const output = formatForPhase(constitution, 'specify')
      expect(output).toContain('项目宪章')
      expect(output).toContain('Bubble Agent OS')
      expect(output).toContain('Query-Only')
      expect(output).toContain('[不可违反]')
    })

    it('plan phase includes available methods and anti-patterns', () => {
      const output = formatForPhase(constitution, 'plan')
      expect(output).toContain('可用数据方法')
      expect(output).toContain('getPurchases')
      expect(output).toContain('反模式')
      expect(output).toContain('不要生成通用的 CRUD')
    })

    it('tasks phase includes non-negotiable principles only', () => {
      const output = formatForPhase(constitution, 'tasks')
      expect(output).toContain('原则提醒')
      expect(output).toContain('Query-Only')
      // Non-negotiable principles should appear
      expect(output).toContain('Security-First')
      // Skip-able principles should NOT appear
      expect(output).not.toContain('Library-First')
      expect(output).not.toContain('Simplicity')
    })

    it('implement phase includes security rules and anti-patterns', () => {
      const output = formatForPhase(constitution, 'implement')
      expect(output).toContain('安全约束')
      expect(output).toContain('反模式')
      expect(output).toContain('child_process')
    })
  })
})
