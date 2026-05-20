import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { RouteDeps } from '../route-types.js'
import * as biz from '../../connector/biz/structured-store.js'
import * as docEngine from '../../connector/biz/doc-engine.js'
import * as reports from '../../connector/biz/reports.js'

export function registerBizRoutes(app: FastifyInstance, deps: RouteDeps) {
  const { getBizCtx } = deps

  // ── Products ────────────────────────────────────────────────────

  app.get('/api/biz/products', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { q } = req.query as { q?: string }
    return { data: biz.getProducts(ctx, q) }
  })

  app.post('/api/biz/products', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.code || !body.name) return reply.code(400).send({ error: 'code 和 name 为必填项' })
    return { data: biz.createProduct(ctx, body as any) }
  })

  app.put('/api/biz/products/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    if (!biz.getProductById(id)) return reply.code(404).send({ error: '产品不存在' })
    biz.updateProduct(id, req.body as Record<string, unknown>, ctx.spaceId)
    return { data: biz.getProductById(id) }
  })

  app.delete('/api/biz/products/:id', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    biz.deleteProduct(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Counterparties ──────────────────────────────────────────────

  app.get('/api/biz/counterparties', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { type } = req.query as { type?: string }
    return { data: biz.getCounterparties(ctx, type) }
  })

  app.post('/api/biz/counterparties', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.name || !body.type) return reply.code(400).send({ error: 'name 和 type 为必填项' })
    return { data: biz.createCounterparty(ctx, body as any) }
  })

  app.put('/api/biz/counterparties/:id', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    biz.updateCounterparty(id, req.body as Record<string, unknown>, ctx.spaceId)
    return { ok: true }
  })

  app.delete('/api/biz/counterparties/:id', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    biz.deleteCounterparty(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Projects ────────────────────────────────────────────────────

  app.get('/api/biz/projects', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    return { data: biz.getProjects(ctx) }
  })

  app.post('/api/biz/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.name) return reply.code(400).send({ error: 'name 为必填项' })
    return { data: biz.createProject(ctx, body as any) }
  })

  app.put('/api/biz/projects/:id', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    biz.updateProject(id, req.body as Record<string, unknown>, ctx.spaceId)
    return { ok: true }
  })

  app.delete('/api/biz/projects/:id', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    biz.deleteProject(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Purchases ──────────────────────────────────────────────────

  app.get('/api/biz/purchases', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getPurchases(ctx, filter) }
  })

  app.post('/api/biz/purchases', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.date || !body.supplierId || !body.productId) {
      return reply.code(400).send({ error: 'date, supplierId, productId 为必填项' })
    }
    body.spaceId = ctx.spaceId
    return { data: biz.createPurchase(body as any) }
  })

  app.put('/api/biz/purchases/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraft('purchase', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.updatePurchase(id, req.body as Record<string, unknown>, ctx.spaceId)
    return { ok: true }
  })

  app.delete('/api/biz/purchases/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraftForDelete('purchase', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.deletePurchase(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Sales ───────────────────────────────────────────────────────

  app.get('/api/biz/sales', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getSales(ctx, filter) }
  })

  app.post('/api/biz/sales', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.date || !body.customerId || !body.productId) {
      return reply.code(400).send({ error: 'date, customerId, productId 为必填项' })
    }
    if (body.costPrice == null) {
      const lastPrice = biz.getLastPurchasePrice(ctx, body.productId as string)
      if (lastPrice != null) {
        body.costPrice = lastPrice
        body.costAmount = Math.round(Number(body.tonnage || 0) * lastPrice * 100) / 100
        body.profit = Math.round((Number(body.totalAmount || 0) - Number(body.costAmount || 0)) * 100) / 100
      }
    }
    body.spaceId = ctx.spaceId
    return { data: biz.createSale(body as any) }
  })

  app.put('/api/biz/sales/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraft('sale', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.updateSale(id, req.body as Record<string, unknown>, ctx.spaceId)
    return { ok: true }
  })

  app.delete('/api/biz/sales/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraftForDelete('sale', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.deleteSale(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Logistics ──────────────────────────────────────────────────

  app.get('/api/biz/logistics', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getLogistics(ctx, filter) }
  })

  app.post('/api/biz/logistics', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.date) return reply.code(400).send({ error: 'date 为必填项' })
    body.spaceId = ctx.spaceId
    return { data: biz.createLogistics(body as any) }
  })

  app.delete('/api/biz/logistics/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraftForDelete('logistics', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.deleteLogistics(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Payments ────────────────────────────────────────────────────

  app.get('/api/biz/payments', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getPayments(ctx, filter) }
  })

  app.post('/api/biz/payments', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.date || !body.direction || !body.counterpartyId || !body.amount) {
      return reply.code(400).send({ error: 'date, direction, counterpartyId, amount 为必填项' })
    }
    body.spaceId = ctx.spaceId
    return { data: biz.createPayment(body as any) }
  })

  app.delete('/api/biz/payments/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraftForDelete('payment', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.deletePayment(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Invoices ────────────────────────────────────────────────────

  app.get('/api/biz/invoices', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const filter = req.query as biz.BizQueryFilter
    return { data: biz.getInvoices(ctx, filter) }
  })

  app.post('/api/biz/invoices', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const body = req.body as Record<string, unknown>
    if (!body.date || !body.direction || !body.counterpartyId || !body.amount) {
      return reply.code(400).send({ error: 'date, direction, counterpartyId, amount 为必填项' })
    }
    body.spaceId = ctx.spaceId
    return { data: biz.createInvoice(body as any) }
  })

  app.delete('/api/biz/invoices/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { id } = req.params as { id: string }
    const guard = docEngine.assertDraftForDelete('invoice', id)
    if (!guard.ok) return reply.code(400).send({ error: guard.error })
    biz.deleteInvoice(id, ctx.spaceId)
    return { ok: true }
  })

  // ── Document Lifecycle (v0.6) ────────────────────────────────────

  app.post('/api/biz/doc/transition', async (req: FastifyRequest, reply: FastifyReply) => {
    const { docType, id, newStatus, cancelReason } = req.body as {
      docType?: string; id?: string; newStatus?: string; cancelReason?: string
    }
    if (!docType || !id || !newStatus) {
      return reply.code(400).send({ error: 'docType, id, newStatus 为必填项' })
    }
    const result = docEngine.transitionStatus(docType, id, newStatus as any, cancelReason)
    if (!result.ok) return reply.code(400).send({ error: result.error })
    return { ok: true }
  })

  app.get('/api/biz/doc/links/:docType/:id', async (req: FastifyRequest) => {
    const { docType, id } = req.params as { docType: string; id: string }
    return docEngine.getLinkedDocs(docType, id)
  })

  app.post('/api/biz/doc/create-from', async (req: FastifyRequest, reply: FastifyReply) => {
    const { action, sourceId } = req.body as { action?: string; sourceId?: string }
    if (!action || !sourceId) {
      return reply.code(400).send({ error: 'action, sourceId 为必填项' })
    }
    try {
      switch (action) {
        case 'logistics-from-sale':
          return { data: biz.createLogisticsFromSale(sourceId) }
        case 'invoice-from-sale':
          return { data: biz.createInvoiceFromSale(sourceId) }
        case 'invoice-from-purchase':
          return { data: biz.createInvoiceFromPurchase(sourceId) }
        default:
          return reply.code(400).send({ error: `未知的 action: ${action}` })
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.post('/api/biz/doc/link-payment', async (req: FastifyRequest, reply: FastifyReply) => {
    const { paymentId, invoiceId } = req.body as { paymentId?: string; invoiceId?: string }
    if (!paymentId || !invoiceId) {
      return reply.code(400).send({ error: 'paymentId, invoiceId 为必填项' })
    }
    const link = biz.linkPaymentToInvoice(paymentId, invoiceId)
    return { data: link }
  })

  app.post('/api/biz/doc/amend', async (req: FastifyRequest, reply: FastifyReply) => {
    const { docType, id } = req.body as { docType?: string; id?: string }
    if (!docType || !id) {
      return reply.code(400).send({ error: 'docType, id 为必填项' })
    }
    const result = docEngine.amendDocument(docType, id)
    if (!result.ok) return reply.code(400).send({ error: result.error })
    return { ok: true, newId: result.newId }
  })

  // ── Computed Views ──────────────────────────────────────────────

  app.get('/api/biz/inventory', async (req: FastifyRequest) => ({ data: biz.getInventory(getBizCtx(req)) }))
  app.get('/api/biz/receivables', async (req: FastifyRequest) => ({ data: biz.getReceivables(getBizCtx(req)) }))
  app.get('/api/biz/payables', async (req: FastifyRequest) => ({ data: biz.getPayables(getBizCtx(req)) }))
  app.get('/api/biz/dashboard', async (req: FastifyRequest) => ({ data: biz.getDashboard(getBizCtx(req)) }))
  app.get('/api/biz/exposure', async (req: FastifyRequest) => ({ data: biz.getExposure(getBizCtx(req)) }))
  app.get('/api/biz/reconciliation', async (req: FastifyRequest) => ({ data: biz.getProjectReconciliation(getBizCtx(req)) }))

  // ── Reports (v0.6 SaaS) ─────────────────────────────────────────

  app.get('/api/biz/reports/profit', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { dateFrom, dateTo, customerId, supplierId } = req.query as {
      dateFrom?: string; dateTo?: string; customerId?: string; supplierId?: string
    }
    return { data: reports.getProfitReport(ctx, { dateFrom, dateTo, customerId, supplierId }) }
  })

  app.get('/api/biz/reports/statement/:counterpartyId', async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = getBizCtx(req)
    const { counterpartyId } = req.params as { counterpartyId: string }
    const { dateFrom, dateTo } = req.query as { dateFrom?: string; dateTo?: string }
    try {
      return { data: reports.getCounterpartyStatement(ctx, counterpartyId, dateFrom, dateTo) }
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/biz/reports/monthly', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { year } = req.query as { year?: string }
    return { data: reports.getMonthlyOverview(ctx, year ? parseInt(year) : undefined) }
  })

  app.get('/api/biz/reports/profit-by-order', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { dateFrom, dateTo, customerId, supplierId } = req.query as {
      dateFrom?: string; dateTo?: string; customerId?: string; supplierId?: string
    }
    return { data: reports.getProfitByOrder(ctx, { dateFrom, dateTo, customerId, supplierId }) }
  })

  // ── Purchases with Line Items (v0.7) ────────────────────────────

  app.post('/api/biz/purchases-with-lines', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const ctx = getBizCtx(req)
      const body = req.body as biz.CreatePurchaseWithLinesInput
      body.spaceId = ctx.spaceId
      const result = biz.createPurchaseWithLines(body)
      return { data: result }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/biz/purchases/:purchaseId/lines', async (req: FastifyRequest) => {
    const { purchaseId } = req.params as { purchaseId: string }
    return { data: biz.getPurchaseLines(purchaseId) }
  })

  app.put('/api/biz/purchases/:purchaseId/lines', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { purchaseId } = req.params as { purchaseId: string }
      const { lines } = req.body as { lines: biz.CreatePurchaseLineInput[] }
      biz.updatePurchaseLines(purchaseId, lines)
      return { success: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── Sales with Line Items (v0.7) ────────────────────────────────

  app.post('/api/biz/sales-with-lines', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const ctx = getBizCtx(req)
      const body = req.body as biz.CreateSaleWithLinesInput
      body.spaceId = ctx.spaceId
      const result = biz.createSaleWithLines(body)
      return { data: result }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  app.get('/api/biz/sales/:saleId/lines', async (req: FastifyRequest) => {
    const { saleId } = req.params as { saleId: string }
    return { data: biz.getSaleLines(saleId) }
  })

  app.put('/api/biz/sales/:saleId/lines', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { saleId } = req.params as { saleId: string }
      const { lines } = req.body as { lines: biz.CreatePurchaseLineInput[] }
      biz.updateSaleLines(saleId, lines)
      return { success: true }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── Trade Cascade (v1.0.2) ─────────────────────────────────────

  app.post('/api/biz/trades', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const ctx = getBizCtx(req)
      const body = req.body as biz.CreateTradeInput
      body.spaceId = ctx.spaceId
      const result = biz.createTradeWithCascade(body)
      return { data: result }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── Uninvoiced Amount ──────────────────────────────────────────

  app.get('/api/biz/uninvoiced/:counterpartyId', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { counterpartyId } = req.params as { counterpartyId: string }
    const { direction } = req.query as { direction?: 'in' | 'out' }
    return { data: biz.getUninvoicedAmount(ctx, counterpartyId, direction || 'in') }
  })

  // ── Lookup (VLOOKUP replacement) ────────────────────────────────

  app.get('/api/biz/lookup/product', async (req: FastifyRequest) => {
    const { code } = req.query as { code?: string }
    return { data: code ? biz.lookupProduct(code) ?? null : null }
  })

  app.get('/api/biz/lookup/last-price', async (req: FastifyRequest) => {
    const ctx = getBizCtx(req)
    const { productId } = req.query as { productId?: string }
    return { data: productId ? biz.getLastPurchasePrice(ctx, productId) ?? null : null }
  })
}
