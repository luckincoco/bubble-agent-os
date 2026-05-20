import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps, JwtPayload } from '../route-types.js'
import { CodeForge, Sandbox, DynamicLoader, SpecForge, isSpecForgePaused } from '../../connector/code-forge/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function registerForgeRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { requireAdmin, modules } = deps
  const forgeProjectRoot = resolve(__dirname, '..', '..', '..')
  const forgeLoader = new DynamicLoader(forgeProjectRoot)

  app.post('/api/forge/generate', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { description, suggestedName, category } = req.body as {
      description?: string
      suggestedName?: string
      category?: 'biz-query' | 'data-transform' | 'report' | 'utility'
    }

    if (!description) {
      return reply.code(400).send({ error: 'description 为必填项' })
    }
    if (!modules?.llm) {
      return reply.code(503).send({ error: 'LLM 未初始化' })
    }

    const forge = new CodeForge(modules.llm)
    const result = await forge.generate({ description, suggestedName, category })

    const sandbox = new Sandbox(forgeProjectRoot)
    const verification = await sandbox.verify(result.code)

    return {
      toolName: result.toolName,
      code: result.code,
      testCode: result.testCode,
      explanation: result.explanation,
      verification: {
        passed: verification.passed,
        riskLevel: verification.riskLevel,
        violations: verification.staticAnalysis.violations,
        compilationErrors: verification.compilation.errors,
      },
      tokenUsage: result.tokenUsage,
    }
  })

  app.post('/api/forge/approve', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { toolName } = req.body as { toolName?: string }
    if (!toolName) {
      return reply.code(400).send({ error: 'toolName 为必填项' })
    }

    const pendingCode = forgeLoader.getPendingCode(toolName)
    if (!pendingCode) {
      return reply.code(404).send({ error: `工具 "${toolName}" 无待审批代码` })
    }

    const sandbox = new Sandbox(forgeProjectRoot)
    const verification = await sandbox.verify(pendingCode)
    if (!verification.staticAnalysis.passed) {
      return reply.code(422).send({
        error: '代码未通过静态安全检查，无法审批',
        violations: verification.staticAnalysis.violations,
      })
    }

    forgeLoader.approveTool(toolName, payload.username)
    return { ok: true, toolName, message: `工具 "${toolName}" 已审批并保存，重启后自动生效` }
  })

  app.get('/api/forge/tools', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    return { tools: forgeLoader.listTools() }
  })

  app.get('/api/forge/tools/:name/code', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return
    const { name } = req.params as { name: string }
    const code = forgeLoader.getPendingCode(name)
    if (!code) {
      return reply.code(404).send({ error: `工具 "${name}" 无待审批代码` })
    }
    return { toolName: name, code }
  })

  app.post('/api/forge/disable', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { toolName } = req.body as { toolName?: string }
    if (!toolName) {
      return reply.code(400).send({ error: 'toolName 为必填项' })
    }

    const success = forgeLoader.disableTool(toolName)
    if (!success) {
      return reply.code(404).send({ error: `工具 "${toolName}" 不存在` })
    }
    return { ok: true, message: `工具 "${toolName}" 已禁用` }
  })

  // ── SpecForge SDD Endpoints ──

  let specForgeInstance: InstanceType<typeof SpecForge> | null = null
  function getSpecForgeApi() {
    if (!specForgeInstance && modules?.llm) {
      specForgeInstance = new SpecForge(modules.llm, forgeProjectRoot)
    }
    return specForgeInstance
  }

  app.post('/api/forge/spec-generate', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { description, suggestedName, category } = req.body as {
      description?: string
      suggestedName?: string
      category?: 'biz-query' | 'data-transform' | 'report' | 'utility'
    }

    if (!description) {
      return reply.code(400).send({ error: 'description 为必填项' })
    }

    const sf = getSpecForgeApi()
    if (!sf) {
      return reply.code(503).send({ error: 'LLM 未初始化' })
    }

    const output = await sf.run({ description, suggestedName, category })

    if (isSpecForgePaused(output)) {
      return reply.code(202).send({
        status: 'paused',
        sessionId: output.sessionId,
        clarifications: output.clarifications,
      })
    }

    const sandbox = new Sandbox(forgeProjectRoot)
    const verification = await sandbox.verify(output.forge.code)

    if (verification.staticAnalysis.passed) {
      forgeLoader.savePendingTool(output.forge.toolName, output.forge.code, output.forge.explanation, {
        sessionId: output.session.id,
        phases: Object.keys(output.session.artifacts),
      })
    }

    return {
      toolName: output.forge.toolName,
      code: output.forge.code,
      testCode: output.forge.testCode,
      explanation: output.forge.explanation,
      pipeline: output.session.isSimple ? 'simple' : 'full',
      phases: Object.keys(output.session.artifacts),
      verification: {
        passed: verification.passed,
        riskLevel: verification.riskLevel,
        violations: verification.staticAnalysis.violations,
      },
      tokenUsage: output.forge.tokenUsage,
    }
  })

  app.post('/api/forge/resume', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { sessionId, clarification } = req.body as {
      sessionId?: string
      clarification?: string
    }

    if (!sessionId || !clarification) {
      return reply.code(400).send({ error: 'sessionId 和 clarification 为必填项' })
    }

    const sf = getSpecForgeApi()
    if (!sf) {
      return reply.code(503).send({ error: 'LLM 未初始化' })
    }

    const output = await sf.resume(sessionId, clarification)

    if (isSpecForgePaused(output)) {
      return reply.code(202).send({
        status: 'paused',
        sessionId: output.sessionId,
        clarifications: output.clarifications,
      })
    }

    const sandbox = new Sandbox(forgeProjectRoot)
    const verification = await sandbox.verify(output.forge.code)

    if (verification.staticAnalysis.passed) {
      forgeLoader.savePendingTool(output.forge.toolName, output.forge.code, output.forge.explanation, {
        sessionId: output.session.id,
        phases: Object.keys(output.session.artifacts),
      })
    }

    return {
      toolName: output.forge.toolName,
      code: output.forge.code,
      testCode: output.forge.testCode,
      explanation: output.forge.explanation,
      pipeline: output.session.isSimple ? 'simple' : 'full',
      verification: {
        passed: verification.passed,
        riskLevel: verification.riskLevel,
        violations: verification.staticAnalysis.violations,
      },
      tokenUsage: output.forge.tokenUsage,
    }
  })

  app.get('/api/forge/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const sf = getSpecForgeApi()
    if (!sf) {
      return { sessions: [] }
    }

    return { sessions: sf.listSessions() }
  })

  app.get('/api/forge/sessions/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = req.user as JwtPayload
    if (requireAdmin(payload, reply)) return

    const { id } = req.params as { id: string }
    const sf = getSpecForgeApi()
    const session = sf?.getSession(id)

    if (!session) {
      return reply.code(404).send({ error: `会话 "${id}" 不存在` })
    }

    return { session }
  })
}
