import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps } from '../route-types.js'
import { logger } from '../../shared/logger.js'
import { spawnSync } from 'node:child_process'

const DEPLOY_DIR = process.env.DEPLOY_DIR || '/opt/bubble-agent-os'

function run(cmd: string, args: string[], timeout: number): { ok: boolean; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd: DEPLOY_DIR,
    timeout,
    stdio: 'pipe',
    encoding: 'utf-8',
  })
  return { ok: result.status === 0, stderr: result.stderr?.trim() || '' }
}

export function registerDeployRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { requireAdmin } = deps

  app.post('/api/deploy', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as { userId: string; username: string; role: string }
    if (requireAdmin(payload as any, reply)) return

    const steps: string[] = []
    const start = Date.now()

    try {
      // 1) git fetch + reset --hard origin/main
      steps.push('git fetch origin...')
      const fetch = run('git', ['fetch', 'origin'], 30000)
      if (!fetch.ok) throw new Error(`git fetch 失败: ${fetch.stderr}`)
      steps.push('✓ git fetch origin')

      steps.push('git reset --hard origin/main...')
      const reset = run('git', ['reset', '--hard', 'origin/main'], 10000)
      if (!reset.ok) throw new Error(`git reset 失败: ${reset.stderr}`)
      steps.push('✓ git reset --hard origin/main')

      // 2) pnpm install
      steps.push('pnpm install...')
      const install = run('pnpm', ['install'], 60000)
      if (!install.ok) throw new Error(`pnpm install 失败: ${install.stderr}`)
      steps.push('✓ pnpm install')

      // 3) pnpm build
      steps.push('pnpm build...')
      const build = run('pnpm', ['build'], 120000)
      if (!build.ok) throw new Error(`pnpm build 失败: ${build.stderr}`)
      steps.push('✓ pnpm build')

      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      steps.push(`⏱ ${elapsed}s`)

      // Send response before restarting
      await reply.send({
        success: true,
        steps,
        message: `部署完成 (${elapsed}s)，正在重启...`,
      })

      // Graceful restart after response is sent
      setTimeout(() => {
        try {
          const restart = run('pm2', ['restart', 'bubble'], 10000)
          if (restart.ok) {
            logger.info('Deploy: pm2 restart triggered')
          } else {
            logger.error('Deploy: pm2 restart stderr:', restart.stderr)
          }
        } catch (e) {
          logger.error('Deploy: pm2 restart failed:', e instanceof Error ? e.message : String(e))
        }
      }, 200)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('Deploy failed:', msg)
      steps.push(`✗ ${msg}`)
      return reply.code(500).send({ success: false, steps, message: `部署失败: ${msg}` })
    }
  })
}
