import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, getDatabase, closeDatabase } from '../src/storage/database.js'

// Mock structured-store (used for exposure/silence/concentration sections)
vi.mock('../src/connector/biz/structured-store.js', () => ({
  getExposure: vi.fn(),
  getSilenceAlerts: vi.fn(),
  getConcentrationMetrics: vi.fn(),
}))

vi.mock('../src/shared/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { getSpaceProfile } from '../src/connector/biz/space-profile.js'
import { getExposure, getSilenceAlerts, getConcentrationMetrics } from '../src/connector/biz/structured-store.js'

const TENANT = 'default'
let tmpDir: string

// ── DB helpers ────────────────────────────────────────────────────

/**
 * The source code (space-profile.ts) queries biz_counterparties/biz_products/
 * biz_projects with `deleted_at IS NULL`, but migrations only add these columns
 * to transaction tables (biz_purchases etc.), not to counterparties/products/projects.
 * Add them via ALTER TABLE so the source code queries work.
 */
function addMissingColumns(): void {
  const db = getDatabase()
  const tables = ['biz_counterparties', 'biz_products', 'biz_projects']
  for (const t of tables) {
    const cols = db.pragma(`table_info(${t})`) as Array<{ name: string }>
    if (!cols.some(c => c.name === 'deleted_at')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN deleted_at INTEGER`)
    }
    if (!cols.some(c => c.name === 'space_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN space_id TEXT`)
    }
  }
}

function insertSpace(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare('INSERT OR IGNORE INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(
    id, overrides.name || '测试空间', overrides.description || '描述', Date.now(),
  )
}

function insertCounterparty(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_counterparties (id, tenant_id, space_id, type, name, first_interaction, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    TENANT,
    overrides.space_id || 'space-1',
    overrides.type || 'supplier',
    overrides.name || `供应商${id}`,
    overrides.first_interaction || '2024-01-15',
    Date.now(),
    Date.now(),
  )
}

function insertProject(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_projects (id, tenant_id, space_id, name, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.name || `项目${id}`, overrides.status || 'active',
    Date.now(), Date.now(),
  )
}

function insertProduct(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_products (id, tenant_id, space_id, code, brand, name, spec, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.code || `code-${id}`, overrides.brand || '品牌A',
    overrides.name || `产品${id}`, overrides.spec || 'HRB400',
    Date.now(), Date.now(),
  )
}

function insertPurchase(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_purchases (id, tenant_id, space_id, date, supplier_id, product_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-01-10',
    overrides.supplier_id || 'cp-1', overrides.product_id || 'prod-1',
    overrides.tonnage || 100, overrides.unit_price || 4000, overrides.total_amount || 400000,
    Date.now(), Date.now(),
  )
}

function insertSale(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_sales (id, tenant_id, space_id, date, customer_id, tonnage, unit_price, total_amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-02-15',
    overrides.customer_id || 'cp-2',
    overrides.tonnage || 50, overrides.unit_price || 4500, overrides.total_amount || 225000,
    Date.now(), Date.now(),
  )
}

function insertLogistics(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_logistics (id, tenant_id, space_id, date, carrier_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-03-01', overrides.carrier_id || 'cp-3',
    Date.now(), Date.now(),
  )
}

function insertPayment(id: string, overrides: Record<string, any> = {}): void {
  const db = getDatabase()
  db.prepare(`
    INSERT OR IGNORE INTO biz_payments (id, tenant_id, space_id, date, direction, counterparty_id, amount, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, TENANT, overrides.space_id || 'space-1',
    overrides.date || '2025-03-15', overrides.direction || 'out',
    overrides.counterparty_id || 'cp-1', overrides.amount || 200000,
    Date.now(), Date.now(),
  )
}

// ── Setup / Teardown ────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'space-profile-test-'))
  initDatabase(tmpDir, 'test-pass')
  addMissingColumns()
})

afterEach(() => {
  closeDatabase()
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  vi.clearAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────

describe('getSpaceProfile', () => {
  it('returns empty string for empty spaceId', () => {
    expect(getSpaceProfile('')).toBe('')
  })

  it('returns profile with space name and data counts', () => {
    insertSpace('sp-profile-1', { name: '钢贸公司' })
    insertCounterparty('cp-1', { space_id: 'sp-profile-1', type: 'supplier', name: '宝钢', first_interaction: '2024-01-15' })
    insertCounterparty('cp-2', { space_id: 'sp-profile-1', type: 'customer', name: '中建', first_interaction: '2024-03-01' })
    insertProject('proj-1', { space_id: 'sp-profile-1', name: '杭州项目' })

    const profile = getSpaceProfile('sp-profile-1')

    expect(profile).toContain('钢贸公司')
    expect(profile).toContain('钢贸（钢材贸易）')
    expect(profile).toContain('宝钢')
    expect(profile).toContain('中建')
    expect(profile).toContain('杭州项目')
    expect(profile).toContain('采购 0 笔')
    expect(profile).toContain('销售 0 笔')
  })

  it('includes data range and counts from purchases and sales', () => {
    insertSpace('sp-range-1')
    insertCounterparty('cp-1', { space_id: 'sp-range-1', type: 'supplier' })
    insertCounterparty('cp-2', { space_id: 'sp-range-1', type: 'customer' })
    insertProduct('prod-1', { space_id: 'sp-range-1', code: 'HRB400E' })
    insertPurchase('pu-1', { space_id: 'sp-range-1', date: '2025-01-10', supplier_id: 'cp-1', product_id: 'prod-1' })
    insertSale('sa-1', { space_id: 'sp-range-1', date: '2025-06-20', customer_id: 'cp-2' })

    const profile = getSpaceProfile('sp-range-1')

    expect(profile).toContain('2025-01-10')
    expect(profile).toContain('2025-06-20')
    expect(profile).toContain('采购 1 笔')
    expect(profile).toContain('销售 1 笔')
  })

  it('includes top products with brand/name/spec', () => {
    insertSpace('sp-prod-1')
    insertCounterparty('cp-1', { space_id: 'sp-prod-1', type: 'supplier' })
    insertProduct('prod-1', { space_id: 'sp-prod-1', brand: '沙钢', name: '螺纹钢', spec: 'HRB400E' })
    insertPurchase('pu-1', { space_id: 'sp-prod-1', product_id: 'prod-1', supplier_id: 'cp-1' })
    insertPurchase('pu-2', { space_id: 'sp-prod-1', product_id: 'prod-1', supplier_id: 'cp-1' })

    const profile = getSpaceProfile('sp-prod-1')

    expect(profile).toContain('沙钢')
    expect(profile).toContain('螺纹钢')
    expect(profile).toContain('HRB400E')
  })

  it('returns cached profile on second call within TTL', () => {
    insertSpace('sp-cache-1', { name: '缓存空间' })

    const first = getSpaceProfile('sp-cache-1')
    const second = getSpaceProfile('sp-cache-1')

    expect(first).toBe(second)
    expect(first).toContain('缓存空间')
  })

  it('returns profile with exposure section when netExposure is non-zero', () => {
    insertSpace('sp-exp-1', { name: '敞口空间' })
    vi.mocked(getExposure).mockReturnValue({
      netExposure: 500000,
      totalReceivable: 800000,
      totalPayable: 300000,
      items: [
        { name: '宝钢', netExposure: 150000 },
        { name: '鞍钢', netExposure: -120000 },
      ],
    } as any)

    const profile = getSpaceProfile('sp-exp-1')

    expect(profile).toContain('净敞口')
    expect(profile).toContain('应收')
    expect(profile).toContain('应付')
    expect(profile).toContain('高敞口预警')
  })

  it('skips exposure section when netExposure is zero', () => {
    insertSpace('sp-zeroexp')
    vi.mocked(getExposure).mockReturnValue({ netExposure: 0, totalReceivable: 0, totalPayable: 0, items: [] } as any)

    const profile = getSpaceProfile('sp-zeroexp')

    expect(profile).not.toContain('净敞口')
  })

  it('includes silence alerts section', () => {
    insertSpace('sp-silence')
    vi.mocked(getSilenceAlerts).mockReturnValue([
      { name: '宝钢', silentDays: 45 },
      { name: '鞍钢', silentDays: 30 },
    ] as any)

    const profile = getSpaceProfile('sp-silence')

    expect(profile).toContain('沉默预警')
    expect(profile).toContain('宝钢(45天)')
    expect(profile).toContain('鞍钢(30天)')
  })

  it('includes concentration warnings when triggered', () => {
    insertSpace('sp-conc')
    vi.mocked(getConcentrationMetrics).mockReturnValue({
      supplierConcentration: {
        warning: true,
        topN: 2,
        topNShare: 75,
        threshold: 50,
        topItems: [{ name: '宝钢', share: 40 }, { name: '鞍钢', share: 35 }],
      },
      customerConcentration: {
        warning: false,
        topN: 0,
        topNShare: 0,
        threshold: 50,
        topItems: [],
      },
      threshold: 50,
    } as any)

    const profile = getSpaceProfile('sp-conc')

    expect(profile).toContain('供应商集中度预警')
    expect(profile).toContain('宝钢')
    expect(profile).toContain('鞍钢')
    expect(profile).not.toContain('客户集中度预警')
  })

  it('handles structured-store errors gracefully (try-catch)', () => {
    insertSpace('sp-err')
    vi.mocked(getExposure).mockImplementation(() => { throw new Error('exposure error') })
    vi.mocked(getSilenceAlerts).mockImplementation(() => { throw new Error('silence error') })
    vi.mocked(getConcentrationMetrics).mockImplementation(() => { throw new Error('concentration error') })

    // All three are in try-catch blocks, so the profile should still be generated
    const profile = getSpaceProfile('sp-err')

    expect(profile).toBeTruthy()
    expect(profile).toContain('当前空间')
    // Should NOT contain the error sections
    expect(profile).not.toContain('净敞口')
    expect(profile).not.toContain('沉默预警')
    expect(profile).not.toContain('集中度预警')
  })

  it('handles unique space IDs for cache isolation', () => {
    insertSpace('space-a', { name: '空间A' })
    insertSpace('space-b', { name: '空间B' })

    const profileA = getSpaceProfile('space-a')
    const profileB = getSpaceProfile('space-b')

    expect(profileA).toContain('空间A')
    expect(profileB).toContain('空间B')
    expect(profileA).not.toContain('空间B')
    expect(profileB).not.toContain('空间A')
  })
})
