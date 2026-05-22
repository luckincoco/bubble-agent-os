import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

import {
  transitionStatus,
  createDocLink,
  getLinkedDocs,
  amendDocument,
  assertDraft,
  assertDraftForDelete,
} from '../src/connector/biz/doc-engine.js'

let tmpDir: string

const TENANT = 'default'
const NOW = Date.now()

// ── Helpers ────────────────────────────────────────────────────

function ensureCounterparty(id: string): void {
  const db = getDatabase()
  const exists = db.prepare('SELECT id FROM biz_counterparties WHERE id = ?').get(id)
  if (exists) return
  db.prepare(`
    INSERT INTO biz_counterparties (id, tenant_id, name, type, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, '{}', ?, ?)
  `).run(id, TENANT, id, 'supplier', NOW, NOW)
}

function ensureProduct(id: string): void {
  const db = getDatabase()
  const exists = db.prepare('SELECT id FROM biz_products WHERE id = ?').get(id)
  if (exists) return
  db.prepare(`
    INSERT INTO biz_products (id, tenant_id, code, brand, name, spec, category, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, TENANT, id, '品牌', '产品', '规格', 'steel', NOW, NOW)
}

function insertPurchase(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const cpId = overrides.supplier_id || 'cp-default'
  const prodId = overrides.product_id || 'prod-default'
  ensureCounterparty(cpId)
  ensureProduct(prodId)
  db.prepare(`
    INSERT INTO biz_purchases (id, tenant_id, date, order_no, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, doc_status, created_at, updated_at, invoice_status, payment_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.date || '2026-01-01', overrides.order_no || null,
    cpId, prodId, overrides.bundle_count ?? 0, overrides.tonnage ?? 0,
    overrides.unit_price ?? 0, overrides.total_amount ?? 0,
    overrides.doc_status || 'draft', NOW, NOW,
    overrides.invoice_status || 'none', overrides.payment_status || 'unpaid',
  )
}

function insertSale(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const cpId = overrides.customer_id || 'cp-default'
  const prodId = overrides.product_id || 'prod-default'
  ensureCounterparty(cpId)
  ensureProduct(prodId)
  db.prepare(`
    INSERT INTO biz_sales (id, tenant_id, date, order_no, customer_id, supplier_id, product_id, bundle_count, tonnage, unit_price, total_amount, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.date || '2026-01-01', overrides.order_no || null,
    cpId, overrides.supplier_id || null, prodId,
    overrides.bundle_count ?? 0, overrides.tonnage ?? 0,
    overrides.unit_price ?? 0, overrides.total_amount ?? 0,
    overrides.doc_status || 'draft', NOW, NOW,
  )
}

function insertPayment(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const cpId = overrides.counterparty_id || 'cp-default'
  ensureCounterparty(cpId)
  db.prepare(`
    INSERT INTO biz_payments (id, tenant_id, date, direction, counterparty_id, amount, method, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.date || '2026-01-01',
    overrides.direction || '付', cpId, overrides.amount ?? 0,
    overrides.method || null, overrides.doc_status || 'draft', NOW, NOW,
  )
}

function insertLogistics(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  const cpId = overrides.carrier_id || 'cp-default'
  ensureCounterparty(cpId)
  db.prepare(`
    INSERT INTO biz_logistics (id, tenant_id, date, carrier_id, destination, tonnage, freight, total_fee, doc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.date || '2026-01-01', cpId,
    overrides.destination || null, overrides.tonnage ?? 0,
    overrides.freight ?? 0, overrides.total_fee ?? 0,
    overrides.doc_status || 'draft', NOW, NOW,
  )
}

function insertDocLink(id: string, sourceType: string, sourceId: string, targetType: string, targetId: string): void {
  const db = getDatabase()
  db.prepare(`
    INSERT INTO biz_doc_links (id, source_type, source_id, target_type, target_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, sourceType, sourceId, targetType, targetId, NOW)
}

// ── Setup / Teardown ──────────────────────────────────────────

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'doc-engine-'))
  initDatabase(tmpDir, 'test-password-123')
})

afterAll(() => {
  closeDatabase()
  rmSync(tmpDir, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDatabase()
  db.exec('BEGIN TRANSACTION')
})

afterEach(() => {
  const db = getDatabase()
  db.exec('ROLLBACK')
})

// ── transitionStatus ───────────────────────────────────────────

describe('transitionStatus', () => {
  it('transitions from draft to confirmed', () => {
    insertPurchase('test-p1', { doc_status: 'draft' })

    const result = transitionStatus('purchase', 'test-p1', 'confirmed')
    expect(result.ok).toBe(true)

    const db = getDatabase()
    const row = db.prepare('SELECT doc_status FROM biz_purchases WHERE id = ?').get('test-p1') as { doc_status: string }
    expect(row.doc_status).toBe('confirmed')
  })

  it('rejects invalid transition (draft → completed)', () => {
    insertPurchase('test-p2', { doc_status: 'draft' })

    const result = transitionStatus('purchase', 'test-p2', 'completed')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不允许')
  })

  it('rejects cancellation without reason', () => {
    insertPurchase('test-p3', { doc_status: 'confirmed' })

    const result = transitionStatus('purchase', 'test-p3', 'cancelled')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('原因')
  })

  it('cancels with reason', () => {
    insertPurchase('test-p4', { doc_status: 'confirmed' })

    const result = transitionStatus('purchase', 'test-p4', 'cancelled', '客户取消')
    expect(result.ok).toBe(true)

    const db = getDatabase()
    const row = db.prepare('SELECT doc_status, cancel_reason FROM biz_purchases WHERE id = ?').get('test-p4') as any
    expect(row.doc_status).toBe('cancelled')
    expect(row.cancel_reason).toBe('客户取消')
  })

  it('returns error when doc does not exist', () => {
    const result = transitionStatus('purchase', 'nonexistent', 'confirmed')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
  })

  it('throws for unknown docType', () => {
    insertPurchase('test-p5', { doc_status: 'draft' })
    expect(() => transitionStatus('unknown_type', 'test-p5', 'draft')).toThrow('Unknown docType')
  })
})

// ── createDocLink + getLinkedDocs ──────────────────────────────

describe('createDocLink + getLinkedDocs', () => {
  it('creates a link and retrieves it from both sides', () => {
    insertPurchase('test-link-p1')
    insertPayment('test-link-pay1')

    const link = createDocLink('purchase', 'test-link-p1', 'payment', 'test-link-pay1')
    expect(link.sourceType).toBe('purchase')
    expect(link.targetType).toBe('payment')

    const result = getLinkedDocs('purchase', 'test-link-p1')
    expect(result.children).toHaveLength(1)
    expect(result.children[0].targetId).toBe('test-link-pay1')

    const reverse = getLinkedDocs('payment', 'test-link-pay1')
    expect(reverse.parents).toHaveLength(1)
    expect(reverse.parents[0].sourceId).toBe('test-link-p1')
  })

  it('returns empty arrays when no links exist', () => {
    insertPurchase('test-link-p2')

    const result = getLinkedDocs('purchase', 'test-link-p2')
    expect(result.children).toHaveLength(0)
    expect(result.parents).toHaveLength(0)
  })
})

// ── amendDocument ──────────────────────────────────────────────

describe('amendDocument', () => {
  it('creates amended draft and cancels original', () => {
    insertPurchase('test-amend-p1', { doc_status: 'confirmed', supplier_id: 'cp-amend' })

    const result = amendDocument('purchase', 'test-amend-p1')
    expect(result.ok).toBe(true)
    expect(result.newId).toBeDefined()

    const db = getDatabase()
    // Original is cancelled
    const original = db.prepare('SELECT doc_status, cancel_reason FROM biz_purchases WHERE id = ?').get('test-amend-p1') as any
    expect(original.doc_status).toBe('cancelled')
    expect(original.cancel_reason).toContain('已修正')

    // New draft exists with amended_from pointing back
    const amended = db.prepare('SELECT doc_status, amended_from FROM biz_purchases WHERE id = ?').get(result.newId!) as any
    expect(amended.doc_status).toBe('draft')
    expect(amended.amended_from).toBe('test-amend-p1')
  })

  it('rejects amendment of draft documents', () => {
    insertPurchase('test-amend-p2', { doc_status: 'draft' })

    const result = amendDocument('purchase', 'test-amend-p2')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('已确认')
  })

  it('rejects amendment of non-existent document', () => {
    const result = amendDocument('purchase', 'nonexistent')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
  })
})

// ── assertDraft / assertDraftForDelete ─────────────────────────

describe('assertDraft', () => {
  it('allows draft documents', () => {
    insertPurchase('test-assert-p1', { doc_status: 'draft' })

    const result = assertDraft('purchase', 'test-assert-p1')
    expect(result.ok).toBe(true)
  })

  it('rejects confirmed documents', () => {
    insertPurchase('test-assert-p2', { doc_status: 'confirmed' })

    const result = assertDraft('purchase', 'test-assert-p2')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('草稿')
  })

  it('rejects non-existent documents', () => {
    const result = assertDraft('purchase', 'nonexistent')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('不存在')
  })
})

describe('assertDraftForDelete', () => {
  it('allows deleting draft documents', () => {
    insertPurchase('test-del-p1', { doc_status: 'draft' })

    const result = assertDraftForDelete('purchase', 'test-del-p1')
    expect(result.ok).toBe(true)
  })

  it('rejects deleting confirmed documents', () => {
    insertPurchase('test-del-p2', { doc_status: 'confirmed' })

    const result = assertDraftForDelete('purchase', 'test-del-p2')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('草稿')
  })
})

// ── autoCheckParentCompletion ──────────────────────────────────

describe('autoCheckParentCompletion', () => {
  it('auto-completes parent when all children are done', () => {
    insertPurchase('test-auto-p1', { doc_status: 'confirmed' })
    insertPayment('test-auto-pay1', { doc_status: 'confirmed', counterparty_id: 'cp-auto' })
    insertDocLink('test-link-1', 'purchase', 'test-auto-p1', 'payment', 'test-auto-pay1')

    // Child is already confirmed; transitionStatus(null) not changing it but triggering autoCheckParentCompletion
    const result = transitionStatus('payment', 'test-auto-pay1', 'completed')

    // If all children are complete, parent should auto-complete
    const db = getDatabase()
    const parent = db.prepare('SELECT doc_status FROM biz_purchases WHERE id = ?').get('test-auto-p1') as { doc_status: string }
    expect(parent.doc_status).toBe('completed')
  })

  it('does not auto-complete when some children are pending', () => {
    insertPurchase('test-auto-p2', { doc_status: 'confirmed' })
    insertPayment('test-auto-pay2', { doc_status: 'confirmed', counterparty_id: 'cp-auto2' })
    insertLogistics('test-auto-log2', { doc_status: 'draft', carrier_id: 'cp-auto2' })
    insertDocLink('test-link-2a', 'purchase', 'test-auto-p2', 'payment', 'test-auto-pay2')
    insertDocLink('test-link-2b', 'purchase', 'test-auto-p2', 'logistics', 'test-auto-log2')

    transitionStatus('payment', 'test-auto-pay2', 'completed')

    const db = getDatabase()
    const parent = db.prepare('SELECT doc_status FROM biz_purchases WHERE id = ?').get('test-auto-p2') as { doc_status: string }
    // logistics is still draft, so parent should stay confirmed
    expect(parent.doc_status).toBe('confirmed')
  })
})
