import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

// Mock dependencies
vi.mock('../src/connector/biz/structured-store.js', () => ({
  computeLindyDays: vi.fn(),
}))

vi.mock('../src/kernel/external-prompts.js', () => ({
  TONE_PROFILES: {
    supplier: { address: '贵司', posture: 'partner', style: '沉稳、尊重' },
    customer: { address: '您', posture: 'service', style: '热情专业' },
    logistics: { address: '您', posture: 'efficient', style: '简洁高效' },
  },
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { enhanceMirrorText, type MirrorEnhanceInput } from '../src/connector/biz/mirror-enhancer.js'
import { computeLindyDays } from '../src/connector/biz/structured-store.js'
import type { LLMProvider } from '../src/shared/types.js'

const TENANT = 'default'
let tmpDir: string

// ── DB helpers ────────────────────────────────────────────────────

function insertCounterparty(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_counterparties (id, tenant_id, name, type, first_interaction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT,
    overrides.name || `交易对手${id}`,
    overrides.type || 'supplier',
    overrides.first_interaction || '2024-06-01',
    Date.now(), Date.now(),
  )
}

function addMissingColumn(table: string, col: string, def: string): void {
  const db = getDatabase()
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
}

function insertPurchase(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  addMissingColumn('biz_purchases', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  addMissingColumn('biz_purchases', 'space_id', 'TEXT')
  addMissingColumn('biz_purchases', 'deleted_at', 'INTEGER')
  db.prepare(`
    INSERT OR IGNORE INTO biz_purchases (id, tenant_id, space_id, date, doc_status, supplier_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-01-10',
    overrides.doc_status || 'confirmed',
    overrides.supplier_id || 'cp-1',
    overrides.tonnage || 100, overrides.unit_price || 4000, overrides.total_amount || 400000,
    Date.now(), Date.now(),
  )
}

function insertSale(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  addMissingColumn('biz_sales', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  addMissingColumn('biz_sales', 'space_id', 'TEXT')
  addMissingColumn('biz_sales', 'deleted_at', 'INTEGER')
  db.prepare(`
    INSERT OR IGNORE INTO biz_sales (id, tenant_id, space_id, date, doc_status, customer_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-02-15',
    overrides.doc_status || 'confirmed',
    overrides.customer_id || 'cp-2',
    overrides.tonnage || 50, overrides.unit_price || 4500, overrides.total_amount || 225000,
    Date.now(), Date.now(),
  )
}

function insertPayment(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  addMissingColumn('biz_payments', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  addMissingColumn('biz_payments', 'space_id', 'TEXT')
  addMissingColumn('biz_payments', 'deleted_at', 'INTEGER')
  db.prepare(`
    INSERT OR IGNORE INTO biz_payments (id, tenant_id, space_id, date, doc_status, direction, counterparty_id, amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-03-15',
    overrides.doc_status || 'confirmed',
    overrides.direction || 'out',
    overrides.counterparty_id || 'cp-1',
    overrides.amount || 200000,
    Date.now(), Date.now(),
  )
}

function insertLogistics(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  addMissingColumn('biz_logistics', 'doc_status', "TEXT NOT NULL DEFAULT 'draft'")
  addMissingColumn('biz_logistics', 'space_id', 'TEXT')
  addMissingColumn('biz_logistics', 'deleted_at', 'INTEGER')
  db.prepare(`
    INSERT OR IGNORE INTO biz_logistics (id, tenant_id, space_id, date, doc_status, carrier_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-04-01',
    overrides.doc_status || 'confirmed',
    overrides.carrier_id || 'cp-3',
    Date.now(), Date.now(),
  )
}

// ── LLM helper ──────────────────────────────────────────────────

function makeLLM(overrides: Record<string, any> = {}): LLMProvider {
  return {
    chat: vi.fn().mockResolvedValue({
      content: overrides.content || '尊敬的客户，贵司190000元的付款已确认收到，感谢您的信任与支持。',
      usage: { promptTokens: 100, completionTokens: 20 },
    }),
    chatStream: vi.fn(),
  } as LLMProvider
}

function makeInput(overrides: Partial<MirrorEnhanceInput> = {}): MirrorEnhanceInput {
  return {
    templateText: '【收款确认】190000元已到账',
    counterpartyId: 'cp-1',
    counterpartyName: '宝钢集团',
    counterpartyType: 'supplier',
    eventType: 'payment_in',
    spaceId: 'space-1',
    ...overrides,
  }
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mirror-enhancer-test-'))
  initDatabase(tmpDir, 'test-pass')
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.clearAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────

describe('enhanceMirrorText', () => {
  it('returns enhanced text from LLM with key numbers validated', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    const llm = makeLLM()
    const result = await enhanceMirrorText(llm, makeInput())

    expect(result).toBeTruthy()
    expect(result).toContain('190000')
    // LLM was called with system + user messages
    expect(llm.chat).toHaveBeenCalledTimes(1)
    const callArgs = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs).toHaveLength(2)
    expect(callArgs[0].role).toBe('system')
    expect(callArgs[1].role).toBe('user')
  })

  it('includes relationship context in the LLM prompt', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-01-15' })
    vi.mocked(computeLindyDays).mockReturnValue(490) // ~1年4个月

    const llm = makeLLM()
    await enhanceMirrorText(llm, makeInput())

    const userMsg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][1].content
    expect(userMsg).toContain('宝钢集团')
    expect(userMsg).toContain('供应商')
    expect(userMsg).toContain('合作时长')
    expect(userMsg).toContain('年')
  })

  it('uses TONE_PROFILES style in system prompt', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    const llm = makeLLM()
    await enhanceMirrorText(llm, makeInput({ counterpartyType: 'customer' }))

    const sysMsg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content
    expect(sysMsg).toContain('热情专业')
  })

  it('falls back to customer TONE_PROFILES for unknown type', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    const llm = makeLLM()
    // Cast to any since 'unknown_type' is not in the union type
    await enhanceMirrorText(llm, makeInput({ counterpartyType: 'unknown_type' as any }))

    const sysMsg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content
    expect(sysMsg).toContain('热情专业') // customer fallback
  })

  it('throws when key numbers are missing from enhanced text', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    const llm = makeLLM({ content: '尊敬的用户，您的款项已确认收到。' })

    await expect(enhanceMirrorText(llm, makeInput())).rejects.toThrow('Key number')
  })

  it('throws when LLM returns empty content', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    const llm = makeLLM({ content: '   ' })

    await expect(enhanceMirrorText(llm, makeInput())).rejects.toThrow('empty content')
  })

  it('throws on LLM timeout', async () => {
    insertCounterparty('cp-1', { first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)

    // LLM that never resolves
    const llm = {
      chat: vi.fn().mockReturnValue(new Promise(() => {})),
      chatStream: vi.fn(),
    } as unknown as LLMProvider

    await expect(enhanceMirrorText(llm, makeInput())).rejects.toThrow('timeout')
  }, 15000)

  it('includes transaction context from DB in LLM prompt', async () => {
    insertCounterparty('cp-1', { space_id: 'space-1', first_interaction: '2024-06-01' })
    vi.mocked(computeLindyDays).mockReturnValue(350)
    insertPurchase('pu-1', { space_id: 'space-1', date: '2025-03-01', supplier_id: 'cp-1' })
    insertPurchase('pu-2', { space_id: 'space-1', date: '2025-03-15', supplier_id: 'cp-1' })
    insertPayment('pm-1', { space_id: 'space-1', date: '2025-04-01', counterparty_id: 'cp-1' })

    const llm = makeLLM()
    await enhanceMirrorText(llm, makeInput({ spaceId: 'space-1' }))

    const userMsg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][1].content
    expect(userMsg).toContain('累计交易')
    // Should reflect the inserted transactions
    expect(userMsg).toContain('3笔')
  })

  it('uses formatLindyDays for new partners (null days)', async () => {
    insertCounterparty('cp-1', { first_interaction: null })
    vi.mocked(computeLindyDays).mockReturnValue(null as any)

    const llm = makeLLM()
    await enhanceMirrorText(llm, makeInput())

    const userMsg = (llm.chat as ReturnType<typeof vi.fn>).mock.calls[0][0][1].content
    expect(userMsg).toContain('新合作伙伴')
  })
})
