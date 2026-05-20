/**
 * Sandbox — 静态安全分析 + 编译验证
 *
 * 不执行代码，只做静态检查：
 * 1. 禁止列表扫描（危险 import/调用）
 * 2. 敏感字段泄露检测
 * 3. TypeScript 编译验证（tsc --noEmit）
 */

import { writeFile, mkdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { exec } from 'node:child_process'
import { logger } from '../../shared/logger.js'

// ── Types ────────────────────────────────────────────────────────────

export interface SandboxResult {
  /** 是否通过所有检查 */
  passed: boolean
  /** 静态分析结果 */
  staticAnalysis: {
    passed: boolean
    violations: string[]
  }
  /** 编译结果 */
  compilation: {
    passed: boolean
    errors: string[]
  }
  /** 风险等级 */
  riskLevel: 'low' | 'medium' | 'high'
}

// ── Forbidden patterns（硬编码，LLM 不可绕过） ────────────────────────

const FORBIDDEN_IMPORTS = [
  /import\s.*from\s+['"](?:node:)?fs['"]/,
  /import\s.*from\s+['"](?:node:)?child_process['"]/,
  /import\s.*from\s+['"](?:node:)?net['"]/,
  /import\s.*from\s+['"](?:node:)?http['"]/,
  /import\s.*from\s+['"](?:node:)?https['"]/,
  /import\s.*from\s+['"](?:node:)?dgram['"]/,
  /import\s.*from\s+['"](?:node:)?cluster['"]/,
  /import\s.*from\s+['"](?:node:)?worker_threads['"]/,
  /require\s*\(\s*['"](?:node:)?(?:fs|child_process|net|http|https|dgram|cluster|worker_threads)['"]\s*\)/,
]

const FORBIDDEN_CALLS = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bprocess\.exit\s*\(/,
  /\bprocess\.kill\s*\(/,
  /\bglobalThis\b/,
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
  /\bexec\s*\(/,
  /\bspawn\s*\(/,
]

const FORBIDDEN_STORE_CALLS = [
  /\bcreate(?:Product|Counterparty|Purchase|Sale|Logistics|Payment)\s*\(/,
  /\bupdate(?:Purchase|Sale|Logistics|Payment|CounterpartyName)\s*\(/,
  /\bdelete(?:Purchase|Sale|Logistics|Payment|Product|Counterparty)\s*\(/,
  /import\s*\{[^}]*(?:create|update|delete)[^}]*\}\s*from\s*['"][^'"]*structured-store/,
]

const SENSITIVE_FIELDS = [
  /costPrice/,
  /costAmount/,
  /\bprofit\b/,
  /\bexposure\b/,
  /敞口/,
  /成本价/,
  /成本额/,
  /毛利/,
]

// ── Sandbox ──────────────────────────────────────────────────────────

export class Sandbox {
  private projectRoot: string

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot
  }

  async verify(code: string): Promise<SandboxResult> {
    const staticResult = this.staticAnalysis(code)
    const compilationResult = await this.compilationCheck(code)

    const passed = staticResult.passed && compilationResult.passed
    const riskLevel = this.assessRisk(staticResult, compilationResult)

    logger.info(`[Sandbox] Verification ${passed ? 'PASSED' : 'FAILED'} (risk: ${riskLevel})`)

    return {
      passed,
      staticAnalysis: staticResult,
      compilation: compilationResult,
      riskLevel,
    }
  }

  private staticAnalysis(code: string): { passed: boolean; violations: string[] } {
    const violations: string[] = []

    for (const pattern of FORBIDDEN_IMPORTS) {
      if (pattern.test(code)) {
        violations.push(`禁止的 import: ${pattern.source}`)
      }
    }

    for (const pattern of FORBIDDEN_CALLS) {
      if (pattern.test(code)) {
        violations.push(`禁止的调用: ${pattern.source}`)
      }
    }

    for (const pattern of FORBIDDEN_STORE_CALLS) {
      if (pattern.test(code)) {
        violations.push(`禁止的写操作: ${pattern.source}`)
      }
    }

    // Check sensitive field leakage in output strings
    // Only flag if sensitive fields appear in string templates or return values
    const outputPatterns = code.match(/return\s+[`'"]([\s\S]*?)[`'"]/g) || []
    const templatePatterns = code.match(/\$\{[^}]*\}/g) || []
    const allOutputs = [...outputPatterns, ...templatePatterns].join('\n')

    for (const pattern of SENSITIVE_FIELDS) {
      if (pattern.test(allOutputs)) {
        violations.push(`敏感字段泄露风险: ${pattern.source}`)
      }
    }

    return { passed: violations.length === 0, violations }
  }

  private async compilationCheck(code: string): Promise<{ passed: boolean; errors: string[] }> {
    // Place temp file at the correct relative path so imports like
    // '../../connector/registry.js' resolve to actual source files
    const generatedDir = resolve(this.projectRoot, 'src', 'connector', 'tools', 'generated')
    const tmpFile = resolve(generatedDir, '.forge-tmp-check.ts')

    try {
      await mkdir(generatedDir, { recursive: true })
      await writeFile(tmpFile, code, 'utf-8')

      // Use module resolution matching project tsconfig (bundler)
      // so tsc can resolve .js imports to .ts source files
      const result = await this.execCmd(
        `npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler --esModuleInterop --skipLibCheck --strict "${tmpFile}"`,
        this.projectRoot,
      )

      // Cleanup temp file
      await rm(tmpFile, { force: true }).catch(() => {})

      if (result.exitCode === 0) {
        return { passed: true, errors: [] }
      }

      // Parse tsc errors
      const errors = result.output
        .split('\n')
        .filter(l => l.includes('error TS'))
        .map(l => l.replace(tmpFile, '<generated>'))
        .slice(0, 5) // Max 5 errors

      return { passed: false, errors }
    } catch (err) {
      await rm(tmpFile, { force: true }).catch(() => {})
      const msg = err instanceof Error ? err.message : String(err)
      return { passed: false, errors: [`编译检查异常: ${msg}`] }
    }
  }

  private assessRisk(
    staticResult: { passed: boolean; violations: string[] },
    compilationResult: { passed: boolean },
  ): 'low' | 'medium' | 'high' {
    if (!staticResult.passed) return 'high'
    if (!compilationResult.passed) return 'medium'
    return 'low'
  }

  private execCmd(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
    return new Promise((resolve) => {
      exec(command, { cwd, timeout: 30_000, maxBuffer: 512 * 1024 }, (err, stdout, stderr) => {
        const exitCode = err && 'code' in err ? (err as any).code : (err ? 1 : 0)
        resolve({ exitCode, output: (stdout + '\n' + stderr).trim() })
      })
    })
  }
}
