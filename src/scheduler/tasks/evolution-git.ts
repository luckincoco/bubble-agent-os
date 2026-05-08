/**
 * evolution-git.ts — Git operations for self-evolution safety.
 *
 * Every auto-applied change gets an atomic commit for rollback capability.
 * Uses git revert (not force-reset) to maintain clean history.
 */

import { exec } from 'node:child_process'
import { logger } from '../../shared/logger.js'

const GIT_TIMEOUT_MS = 15_000

function run(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: GIT_TIMEOUT_MS }, (err, stdout, stderr) => {
      const exitCode = err && 'code' in err ? (err as any).code ?? 1 : (err ? 1 : 0)
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode })
    })
  })
}

/**
 * Check git status — returns empty string if working tree is clean.
 */
export async function gitStatus(projectRoot: string): Promise<string> {
  const { stdout } = await run('git status --porcelain', projectRoot)
  return stdout.trim()
}

/**
 * Stage all changes and commit with a tagged message.
 * Returns the commit hash on success, or null on failure.
 */
export async function gitCommitChanges(
  projectRoot: string,
  summary: string,
  bubbleId: string,
): Promise<{ hash: string; success: boolean }> {
  // Check if there are changes to commit
  const status = await gitStatus(projectRoot)
  if (!status) {
    logger.info('evolution-git: no changes to commit')
    return { hash: '', success: true }
  }

  // Stage all
  const addResult = await run('git add -A', projectRoot)
  if (addResult.exitCode !== 0) {
    logger.error(`evolution-git: git add failed: ${addResult.stderr}`)
    return { hash: '', success: false }
  }

  // Commit with tagged message
  const message = `[self-evolution] ${summary} (${bubbleId})`
  const commitResult = await run(`git commit -m "${message.replace(/"/g, '\\"')}"`, projectRoot)
  if (commitResult.exitCode !== 0) {
    logger.error(`evolution-git: git commit failed: ${commitResult.stderr}`)
    return { hash: '', success: false }
  }

  // Get the commit hash
  const hashResult = await run('git rev-parse HEAD', projectRoot)
  const hash = hashResult.stdout.trim()

  logger.info(`evolution-git: committed ${hash.slice(0, 8)} — ${summary}`)
  return { hash, success: true }
}

/**
 * Revert a commit by hash. Creates a new revert commit (safe, preserves history).
 */
export async function gitRevert(projectRoot: string, hash: string): Promise<boolean> {
  const result = await run(`git revert --no-edit ${hash}`, projectRoot)
  if (result.exitCode !== 0) {
    logger.error(`evolution-git: revert failed for ${hash}: ${result.stderr}`)
    return false
  }
  logger.info(`evolution-git: reverted ${hash.slice(0, 8)}`)
  return true
}

/**
 * Run TypeScript type check (tsc --noEmit) as post-apply validation.
 * Returns true if types are clean, false if errors exist.
 */
export async function validateTypeCheck(projectRoot: string): Promise<{ pass: boolean; output: string }> {
  const result = await run('npx tsc --noEmit', projectRoot)
  const pass = result.exitCode === 0
  const output = (result.stdout + result.stderr).trim()
  if (!pass) {
    logger.warn(`evolution-git: tsc validation failed:\n${output.slice(0, 500)}`)
  }
  return { pass, output }
}
