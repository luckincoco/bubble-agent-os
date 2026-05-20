/**
 * DynamicLoader — 从 generated/ 目录动态加载已审批的工具
 *
 * 启动时扫描 generated/ 目录，加载所有 .ts 文件并注册到 ToolRegistry。
 * 运行时可通过 loadTool() 热加载新通过审批的工具。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import type { ToolRegistry, ToolDefinition } from '../registry.js'
import { logger } from '../../shared/logger.js'

// ── Types ────────────────────────────────────────────────────────────

export interface GeneratedToolMeta {
  name: string
  description: string
  createdAt: number
  approvedBy: string
  status: 'active' | 'disabled' | 'experimental' | 'pending'
  invocationCount: number
  lastInvokedAt: number | null
  errorCount: number
  /** 待审批时保存的源码（审批后从文件读取） */
  pendingCode?: string
  /** v2: SpecForge SDD session ID (for traceability) */
  specSessionId?: string
  /** v2: Which phases were executed (e.g. ['plan','implement'] for simple) */
  pipelinePhases?: string[]
}

interface ToolManifest {
  tools: GeneratedToolMeta[]
}

// ── DynamicLoader ────────────────────────────────────────────────────

export class DynamicLoader {
  private generatedDir: string
  private manifestPath: string
  private manifest: ToolManifest

  constructor(private projectRoot: string) {
    this.generatedDir = resolve(projectRoot, 'src', 'connector', 'tools', 'generated')
    this.manifestPath = resolve(this.generatedDir, 'manifest.json')
    this.ensureDir()
    this.manifest = this.loadManifest()
  }

  /** 启动时加载所有 active 工具到 registry */
  loadAll(registry: ToolRegistry): number {
    let loaded = 0
    for (const meta of this.manifest.tools) {
      if (meta.status !== 'active') continue
      try {
        const tool = this.loadToolFromFile(meta.name)
        if (tool) {
          registry.register(tool)
          loaded++
        }
      } catch (err) {
        logger.error(`[DynamicLoader] Failed to load tool "${meta.name}":`, err instanceof Error ? err.message : String(err))
      }
    }
    if (loaded > 0) {
      logger.info(`[DynamicLoader] Loaded ${loaded} generated tool(s)`)
    }
    return loaded
  }

  /** 保存待审批的工具（不注册，等待管理员审批） */
  savePendingTool(name: string, code: string, description: string, specMeta?: { sessionId: string; phases: string[] }): void {
    const existing = this.manifest.tools.find(t => t.name === name)
    if (existing) {
      existing.status = 'pending'
      existing.pendingCode = code
      existing.description = description
      if (specMeta) {
        existing.specSessionId = specMeta.sessionId
        existing.pipelinePhases = specMeta.phases
      }
    } else {
      this.manifest.tools.push({
        name,
        description,
        createdAt: Date.now(),
        approvedBy: '',
        status: 'pending',
        invocationCount: 0,
        lastInvokedAt: null,
        errorCount: 0,
        pendingCode: code,
        specSessionId: specMeta?.sessionId,
        pipelinePhases: specMeta?.phases,
      })
    }
    this.saveManifest()
    logger.info(`[DynamicLoader] Saved pending tool "${name}"${specMeta ? ` (session ${specMeta.sessionId.slice(0, 8)})` : ''}`)
  }

  /** 审批待审批的工具：保存源文件，更新状态 */
  approveTool(name: string, approvedBy: string): boolean {
    const meta = this.manifest.tools.find(t => t.name === name)
    if (!meta || !meta.pendingCode) return false
    // Save source file
    const filePath = resolve(this.generatedDir, `${name}.ts`)
    writeFileSync(filePath, meta.pendingCode, 'utf-8')
    // Update meta
    meta.status = 'active'
    meta.approvedBy = approvedBy
    delete meta.pendingCode
    this.saveManifest()
    logger.info(`[DynamicLoader] Approved tool "${name}" by ${approvedBy}`)
    return true
  }

  /** 获取待审批工具的源码 */
  getPendingCode(name: string): string | null {
    const meta = this.manifest.tools.find(t => t.name === name)
    return meta?.pendingCode || null
  }

  /** 保存新工具文件并注册 */
  saveTool(name: string, code: string, approvedBy: string): void {
    const filePath = resolve(this.generatedDir, `${name}.ts`)
    writeFileSync(filePath, code, 'utf-8')

    // Update manifest
    const existing = this.manifest.tools.find(t => t.name === name)
    if (existing) {
      existing.status = 'active'
      existing.approvedBy = approvedBy
    } else {
      this.manifest.tools.push({
        name,
        description: '',
        createdAt: Date.now(),
        approvedBy,
        status: 'experimental',
        invocationCount: 0,
        lastInvokedAt: null,
        errorCount: 0,
      })
    }
    this.saveManifest()
    logger.info(`[DynamicLoader] Saved tool "${name}" by ${approvedBy}`)
  }

  /** 禁用工具 */
  disableTool(name: string): boolean {
    const meta = this.manifest.tools.find(t => t.name === name)
    if (!meta) return false
    meta.status = 'disabled'
    this.saveManifest()
    logger.info(`[DynamicLoader] Disabled tool "${name}"`)
    return true
  }

  /** 获取所有生成工具的元数据 */
  listTools(): GeneratedToolMeta[] {
    return [...this.manifest.tools]
  }

  /** 记录工具调用（用于灰度监控） */
  recordInvocation(name: string, success: boolean): void {
    const meta = this.manifest.tools.find(t => t.name === name)
    if (!meta) return
    meta.invocationCount++
    meta.lastInvokedAt = Date.now()
    if (!success) meta.errorCount++

    // 自动熔断：错误率超 50% 且调用 > 5 次时自动禁用
    if (meta.invocationCount >= 5 && meta.errorCount / meta.invocationCount > 0.5) {
      meta.status = 'disabled'
      logger.warn(`[DynamicLoader] Auto-disabled tool "${name}" due to high error rate (${meta.errorCount}/${meta.invocationCount})`)
    }
    this.saveManifest()
  }

  // ── Private ──────────────────────────────────────────────────────

  private loadToolFromFile(name: string): ToolDefinition | null {
    const filePath = resolve(this.generatedDir, `${name}.ts`)
    if (!existsSync(filePath)) {
      logger.warn(`[DynamicLoader] Tool file not found: ${filePath}`)
      return null
    }

    // Since we can't dynamically import .ts files at runtime without transpilation,
    // we use a simple eval-free approach: parse the file for the tool definition pattern
    // and construct the tool manually.
    // For v1.1.1, generated tools are pre-compiled during build step.
    // At runtime, we load from dist/connector/tools/generated/
    const distPath = resolve(this.projectRoot, 'dist', 'connector', 'tools', 'generated', `${name}.js`)
    if (!existsSync(distPath)) {
      logger.warn(`[DynamicLoader] Compiled tool not found: ${distPath} (run build first)`)
      return null
    }

    // Dynamic import of compiled JS
    // Note: This is async but we handle it in loadAll
    return null // Placeholder - actual loading happens via importTool()
  }

  /** Async tool import (for runtime use) */
  async importTool(name: string): Promise<ToolDefinition | null> {
    const distPath = resolve(this.projectRoot, 'dist', 'connector', 'tools', 'generated', `${name}.js`)
    if (!existsSync(distPath)) return null

    try {
      const mod = await import(distPath)
      // Convention: exported function is createXxxTool()
      const createFn = Object.values(mod).find(v => typeof v === 'function' && (v as Function).name.startsWith('create'))
      if (createFn) {
        return (createFn as () => ToolDefinition)()
      }
      // Fallback: default export
      if (mod.default && typeof mod.default === 'object' && 'name' in mod.default) {
        return mod.default as ToolDefinition
      }
      return null
    } catch (err) {
      logger.error(`[DynamicLoader] Import failed for "${name}":`, err instanceof Error ? err.message : String(err))
      return null
    }
  }

  /** Load all tools async (for post-build runtime) */
  async loadAllAsync(registry: ToolRegistry): Promise<number> {
    let loaded = 0
    for (const meta of this.manifest.tools) {
      if (meta.status === 'disabled') continue
      const tool = await this.importTool(meta.name)
      if (tool) {
        registry.register(tool)
        loaded++
      }
    }
    if (loaded > 0) {
      logger.info(`[DynamicLoader] Async-loaded ${loaded} generated tool(s)`)
    }
    return loaded
  }

  private ensureDir(): void {
    if (!existsSync(this.generatedDir)) {
      mkdirSync(this.generatedDir, { recursive: true })
    }
  }

  private loadManifest(): ToolManifest {
    if (!existsSync(this.manifestPath)) {
      return { tools: [] }
    }
    try {
      const raw = readFileSync(this.manifestPath, 'utf-8')
      return JSON.parse(raw) as ToolManifest
    } catch {
      return { tools: [] }
    }
  }

  private saveManifest(): void {
    writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf-8')
  }
}
