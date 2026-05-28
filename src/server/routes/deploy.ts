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
      // 1) git pull
      steps.push('git pull...')
      const git = run('git', ['pull'], 30000)
      if (!git.ok) throw new Error(`git pull 失败: ${git.stderr}`)
      steps.push('✓ git pull')

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
