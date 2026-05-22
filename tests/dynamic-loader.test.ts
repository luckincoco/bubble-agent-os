import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { DynamicLoader } from '../src/connector/code-forge/loader.js'
import type { GeneratedToolMeta } from '../src/connector/code-forge/loader.js'

// ── Helpers ─────────────────────────────────────────────────────────────

function generatedDir(projectRoot: string): string {
  return join(projectRoot, 'src', 'connector', 'tools', 'generated')
}

function manifestPath(projectRoot: string): string {
  return join(generatedDir(projectRoot), 'manifest.json')
}

function distDir(projectRoot: string): string {
  return join(projectRoot, 'dist', 'connector', 'tools', 'generated')
}

describe('DynamicLoader', () => {
  let projectRoot: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dynloader-'))
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
  })

  // ── Constructor ────────────────────────────────────────────────

  describe('constructor', () => {
    it('creates generated directory and loads empty manifest', () => {
      const loader = new DynamicLoader(projectRoot)
      expect(existsSync(generatedDir(projectRoot))).toBe(true)
      expect(loader.listTools()).toEqual([])
    })

    it('loads existing manifest from disk', () => {
      mkdirSync(generatedDir(projectRoot), { recursive: true })
      const manifest = {
        tools: [
          { name: 'my-tool', description: 'Test tool', status: 'active', createdAt: 100, approvedBy: 'admin', invocationCount: 0, lastInvokedAt: null, errorCount: 0 },
        ],
      }
      writeFileSync(manifestPath(projectRoot), JSON.stringify(manifest), 'utf-8')

      const loader = new DynamicLoader(projectRoot)
      const tools = loader.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('my-tool')
    })

    it('handles invalid JSON manifest gracefully', () => {
      mkdirSync(generatedDir(projectRoot), { recursive: true })
      writeFileSync(manifestPath(projectRoot), 'invalid json', 'utf-8')

      const loader = new DynamicLoader(projectRoot)
      expect(loader.listTools()).toEqual([])
    })
  })

  // ── savePendingTool ────────────────────────────────────────────

  describe('savePendingTool', () => {
    it('adds a new pending tool to manifest', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'code content', 'My description')

      const tools = loader.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('my-tool')
      expect(tools[0].status).toBe('pending')
      expect(tools[0].pendingCode).toBe('code content')
      expect(tools[0].description).toBe('My description')
    })

    it('updates existing tool back to pending', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'v1', 'desc')

      // Save again — should update, not duplicate
      loader.savePendingTool('my-tool', 'v2', 'new desc')

      const tools = loader.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].pendingCode).toBe('v2')
      expect(tools[0].description).toBe('new desc')
    })

    it('stores specMeta when provided', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'code', 'desc', {
        sessionId: 'session-123',
        phases: ['plan', 'implement'],
      })

      const tool = loader.listTools()[0]
      expect(tool.specSessionId).toBe('session-123')
      expect(tool.pipelinePhases).toEqual(['plan', 'implement'])
    })
  })

  // ── approveTool ────────────────────────────────────────────────

  describe('approveTool', () => {
    it('saves source file and updates status to active', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'export default {}', 'desc')

      const result = loader.approveTool('my-tool', 'admin-1')

      expect(result).toBe(true)
      // Source file should exist
      const filePath = join(generatedDir(projectRoot), 'my-tool.ts')
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf-8')).toBe('export default {}')
      // Manifest updated
      const tool = loader.listTools()[0]
      expect(tool.status).toBe('active')
      expect(tool.approvedBy).toBe('admin-1')
      expect(tool.pendingCode).toBeUndefined()
    })

    it('returns false for non-existent tool', () => {
      const loader = new DynamicLoader(projectRoot)
      expect(loader.approveTool('nonexistent', 'admin')).toBe(false)
    })

    it('returns false for tool without pendingCode', () => {
      // Directly save an active tool (no pendingCode)
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      expect(loader.approveTool('my-tool', 'admin-2')).toBe(false)
    })
  })

  // ── getPendingCode ─────────────────────────────────────────────

  describe('getPendingCode', () => {
    it('returns pending code for existing tool', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'code content', 'desc')

      expect(loader.getPendingCode('my-tool')).toBe('code content')
    })

    it('returns null for non-existent tool', () => {
      const loader = new DynamicLoader(projectRoot)
      expect(loader.getPendingCode('nonexistent')).toBeNull()
    })

    it('returns null after approval (pendingCode removed)', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'code', 'desc')
      loader.approveTool('my-tool', 'admin')

      expect(loader.getPendingCode('my-tool')).toBeNull()
    })
  })

  // ── saveTool ───────────────────────────────────────────────────

  describe('saveTool', () => {
    it('writes source file and updates manifest', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'export const x = 1', 'admin-1')

      const filePath = join(generatedDir(projectRoot), 'my-tool.ts')
      expect(existsSync(filePath)).toBe(true)
      expect(readFileSync(filePath, 'utf-8')).toBe('export const x = 1')

      const tool = loader.listTools()[0]
      expect(tool.name).toBe('my-tool')
      expect(tool.status).toBe('experimental')
      expect(tool.approvedBy).toBe('admin-1')
    })

    it('upgrades existing tool status to active', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.savePendingTool('my-tool', 'code', 'desc')
      loader.saveTool('my-tool', 'code v2', 'admin')

      const tool = loader.listTools()[0]
      expect(tool.status).toBe('active')
      expect(tool.approvedBy).toBe('admin')
    })
  })

  // ── disableTool ────────────────────────────────────────────────

  describe('disableTool', () => {
    it('sets tool status to disabled', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      const result = loader.disableTool('my-tool')

      expect(result).toBe(true)
      expect(loader.listTools()[0].status).toBe('disabled')
    })

    it('returns false for non-existent tool', () => {
      const loader = new DynamicLoader(projectRoot)
      expect(loader.disableTool('nonexistent')).toBe(false)
    })
  })

  // ── listTools ──────────────────────────────────────────────────

  describe('listTools', () => {
    it('returns a copy of the manifest tools array', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('t1', 'code', 'admin')
      loader.saveTool('t2', 'code', 'admin')

      const list = loader.listTools()
      expect(list).toHaveLength(2)

      // Verify it's a copy (mutating doesn't affect internal state)
      list.pop()
      expect(loader.listTools()).toHaveLength(2)
    })
  })

  // ── recordInvocation ───────────────────────────────────────────

  describe('recordInvocation', () => {
    it('increments invocation count and updates lastInvokedAt', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      loader.recordInvocation('my-tool', true)

      const tool = loader.listTools()[0]
      expect(tool.invocationCount).toBe(1)
      expect(tool.lastInvokedAt).toBeGreaterThan(0)
      expect(tool.errorCount).toBe(0)
    })

    it('increments errorCount on failure', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      loader.recordInvocation('my-tool', false)

      const tool = loader.listTools()[0]
      expect(tool.invocationCount).toBe(1)
      expect(tool.errorCount).toBe(1)
    })

    it('auto-disables tool when error rate exceeds 50% after 5 calls', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      // 3 errors out of 5 calls = 60% > 50%
      loader.recordInvocation('my-tool', false) // 1/1
      loader.recordInvocation('my-tool', true)  // 1/2
      loader.recordInvocation('my-tool', false) // 2/3
      loader.recordInvocation('my-tool', true)  // 2/4
      // 5th call: error → 3/5 = 60% > 50% → auto-disabled
      loader.recordInvocation('my-tool', false)

      const tool = loader.listTools()[0]
      expect(tool.status).toBe('disabled')
      expect(tool.errorCount).toBe(3)
    })

    it('does not auto-disable when error rate is below 50%', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      // 2 errors out of 5 calls = 40% ≤ 50%
      loader.recordInvocation('my-tool', false) // 1/1
      loader.recordInvocation('my-tool', true)  // 1/2
      loader.recordInvocation('my-tool', true)  // 1/3
      loader.recordInvocation('my-tool', false) // 2/4
      loader.recordInvocation('my-tool', true)  // 2/5

      const tool = loader.listTools()[0]
      expect(tool.status).not.toBe('disabled')
    })

    it('silently ignores non-existent tool', () => {
      const loader = new DynamicLoader(projectRoot)
      // Should not throw
      loader.recordInvocation('nonexistent', true)
    })
  })

  // ── loadAll (sync placeholder) ─────────────────────────────────

  describe('loadAll', () => {
    it('returns 0 and does not register (sync loading is placeholder)', () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('my-tool', 'code', 'admin')

      const registry = { register: vi.fn() }
      const loaded = loader.loadAll(registry)

      // loadToolFromFile returns null (placeholder), so register is never called
      expect(loaded).toBe(0)
      expect(registry.register).not.toHaveBeenCalled()
    })
  })

  // ── loadAllAsync / importTool ──────────────────────────────────

  describe('importTool', () => {
    it('returns null when dist file does not exist', async () => {
      const loader = new DynamicLoader(projectRoot)
      const result = await loader.importTool('nonexistent')
      expect(result).toBeNull()
    })

    it('imports compiled JS module with create function', async () => {
      const loader = new DynamicLoader(projectRoot)
      // We need the dist path to exist and be a valid JS module
      const d = distDir(projectRoot)
      mkdirSync(d, { recursive: true })

      const toolDef = { name: 'my-tool', description: 'test' }
      writeFileSync(
        join(d, 'my-test-tool.js'),
        `Object.defineProperty(exports, "__esModule", { value: true });
exports.createMyTestTool = function createMyTestTool() { return ${JSON.stringify(toolDef)}; };`,
        'utf-8',
      )

      const result = await loader.importTool('my-test-tool')
      expect(result).toEqual(toolDef)
    })

    it('returns null when module has no create function or default export', async () => {
      const loader = new DynamicLoader(projectRoot)
      const d = distDir(projectRoot)
      mkdirSync(d, { recursive: true })

      writeFileSync(
        join(d, 'empty-tool.js'),
        `Object.defineProperty(exports, "__esModule", { value: true });`,
        'utf-8',
      )

      const result = await loader.importTool('empty-tool')
      expect(result).toBeNull()
    })

    it('returns null on import error', async () => {
      const loader = new DynamicLoader(projectRoot)
      const d = distDir(projectRoot)
      mkdirSync(d, { recursive: true })

      // Write invalid JS
      writeFileSync(join(d, 'broken.js'), 'this is not valid js {{{', 'utf-8')

      const result = await loader.importTool('broken')
      expect(result).toBeNull()
    })
  })

  describe('loadAllAsync', () => {
    it('loads active tools and registers them', async () => {
      const d = distDir(projectRoot)
      mkdirSync(d, { recursive: true })

      const toolDef = { name: 'my-tool', description: 'test' }
      writeFileSync(
        join(d, 'my-async-tool.js'),
        `Object.defineProperty(exports, "__esModule", { value: true });
exports.createMyAsyncTool = function createMyAsyncTool() { return ${JSON.stringify(toolDef)}; };`,
        'utf-8',
      )

      const loader = new DynamicLoader(projectRoot)
      // First add to manifest manually
      loader.saveTool('my-async-tool', 'code', 'admin')

      const registry = { register: vi.fn() }
      const loaded = await loader.loadAllAsync(registry)

      expect(loaded).toBe(1)
      expect(registry.register).toHaveBeenCalledWith(toolDef)
    })

    it('skips disabled tools', async () => {
      const loader = new DynamicLoader(projectRoot)
      loader.saveTool('disabled-tool', 'code', 'admin')
      loader.disableTool('disabled-tool')

      const registry = { register: vi.fn() }
      const loaded = await loader.loadAllAsync(registry)

      expect(loaded).toBe(0)
      expect(registry.register).not.toHaveBeenCalled()
    })
  })

  // ── Persistence across instances ───────────────────────────────

  describe('persistence', () => {
    it('manifest persists across DynamicLoader instances', () => {
      const loader1 = new DynamicLoader(projectRoot)
      loader1.saveTool('persist-tool', 'code', 'admin')

      // Create a new loader pointing to the same project root
      const loader2 = new DynamicLoader(projectRoot)
      const tools = loader2.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('persist-tool')
      expect(tools[0].status).toBe('experimental')
    })
  })
})
