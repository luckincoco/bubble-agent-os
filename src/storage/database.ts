import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { ulid } from 'ulid'
import bcrypt from 'bcryptjs'
import { logger } from '../shared/logger.js'

let db: Database.Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bubbles (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  embedding TEXT,
  source TEXT NOT NULL DEFAULT 'system',
  confidence REAL NOT NULL DEFAULT 1.0,
  decay_rate REAL NOT NULL DEFAULT 0.1,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accessed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bubble_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  link_source TEXT NOT NULL DEFAULT 'system',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (source_id) REFERENCES bubbles(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES bubbles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bubbles_type ON bubbles(type);
CREATE INDEX IF NOT EXISTS idx_bubbles_tags ON bubbles(tags);
CREATE INDEX IF NOT EXISTS idx_bubbles_accessed ON bubbles(accessed_at);
CREATE INDEX IF NOT EXISTS idx_links_source ON bubble_links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON bubble_links(target_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_spaces (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, space_id)
);
`

function runMigrations(database: Database.Database, defaultPassword: string) {
  // Check if bubbles table has space_id column
  const cols = database.pragma('table_info(bubbles)') as Array<{ name: string }>
  const hasSpaceId = cols.some(c => c.name === 'space_id')
  if (!hasSpaceId) {
    database.exec('ALTER TABLE bubbles ADD COLUMN space_id TEXT DEFAULT NULL')
    logger.info('Migration: added space_id column to bubbles')
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_bubbles_space ON bubbles(space_id)')

  // Create bobi (波比) bot user if not exists
  const bobi = database.prepare('SELECT id FROM users WHERE username = ?').get('bobi') as { id: string } | undefined
  if (!bobi) {
    const bobiId = ulid()
    const bobiPwd = process.env.BOBI_PASSWORD || defaultPassword
    const hash = bcrypt.hashSync(bobiPwd, 10)
    database.prepare(
      'INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(bobiId, 'bobi', hash, '波比', 'admin', Date.now())

    // Give bobi access to all existing spaces
    const spaces = database.prepare('SELECT id FROM spaces').all() as Array<{ id: string }>
    for (const space of spaces) {
      database.prepare('INSERT OR IGNORE INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(bobiId, space.id)
    }
    logger.info(`Migration: created bobi user (admin) with access to ${spaces.length} spaces`)
  }

  // Create scheduled_tasks table if not exists
  database.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      cron TEXT NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run INTEGER,
      next_run INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

  // P2-4: Add role column to user_spaces for space-level permissions
  const usCols = database.pragma('table_info(user_spaces)') as Array<{ name: string }>
  if (!usCols.some(c => c.name === 'role')) {
    database.exec("ALTER TABLE user_spaces ADD COLUMN role TEXT NOT NULL DEFAULT 'editor'")
    // Existing members become owners
    database.exec("UPDATE user_spaces SET role = 'owner'")
    logger.info('Migration: added role column to user_spaces')
  }

  // P2-4: Add creator_id column to spaces
  const spCols = database.pragma('table_info(spaces)') as Array<{ name: string }>
  if (!spCols.some(c => c.name === 'creator_id')) {
    database.exec('ALTER TABLE spaces ADD COLUMN creator_id TEXT')
    logger.info('Migration: added creator_id column to spaces')
  }

  // P2-3: Create custom_agents table
  database.exec(`
    CREATE TABLE IF NOT EXISTS custom_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      system_prompt TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      tools TEXT DEFAULT '[]',
      space_ids TEXT DEFAULT '[]',
      creator_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_agents_creator ON custom_agents(creator_id)')

  // Ensure every user has at least one personal space (user isolation)
  const usersWithoutSpace = database.prepare(`
    SELECT u.id, u.username, u.display_name FROM users u
    WHERE u.id NOT IN (SELECT DISTINCT user_id FROM user_spaces)
  `).all() as Array<{ id: string; username: string; display_name: string }>

  for (const u of usersWithoutSpace) {
    const spaceId = ulid()
    const spaceName = u.display_name || u.username
    database.prepare('INSERT INTO spaces (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(spaceId, spaceName, `${spaceName}的个人空间`, u.id, Date.now())
    database.prepare("INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, 'owner')")
      .run(u.id, spaceId)
    logger.info(`Migration: created personal space "${spaceName}" for user ${u.username}`)
  }

  // Fix orphan bubbles: move empty-string space_id to first available space
  const orphanCount = (database.prepare("SELECT COUNT(*) as cnt FROM bubbles WHERE space_id = '' OR space_id IS NULL").get() as { cnt: number }).cnt
  if (orphanCount > 0) {
    const firstSpace = database.prepare('SELECT id FROM spaces ORDER BY created_at LIMIT 1').get() as { id: string } | undefined
    if (firstSpace) {
      const fixed = database.prepare("UPDATE bubbles SET space_id = ? WHERE space_id = '' OR space_id IS NULL").run(firstSpace.id)
      logger.info(`Migration: moved ${fixed.changes} orphan bubbles to space ${firstSpace.id}`)
    }
  }

  // Bubble Compaction: add abstraction_level column
  const bubbleCols2 = database.pragma('table_info(bubbles)') as Array<{ name: string }>
  if (!bubbleCols2.some(c => c.name === 'abstraction_level')) {
    database.exec('ALTER TABLE bubbles ADD COLUMN abstraction_level INTEGER NOT NULL DEFAULT 0')
    logger.info('Migration: added abstraction_level column to bubbles')
  }
  database.exec('CREATE INDEX IF NOT EXISTS idx_bubbles_abstraction ON bubbles(abstraction_level)')

  // v0.4: add summary column for tiered loading
  const bubbleCols3 = database.pragma('table_info(bubbles)') as Array<{ name: string }>
  if (!bubbleCols3.some(c => c.name === 'summary')) {
    database.exec('ALTER TABLE bubbles ADD COLUMN summary TEXT')
    logger.info('Migration: added summary column to bubbles')
  }

  // ── v0.5: Structured business tables (进销存) ─────────────────────

  // Products master data
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_products (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      code TEXT NOT NULL,
      brand TEXT NOT NULL,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      spec_display TEXT,
      category TEXT DEFAULT '螺纹钢',
      measure_type TEXT DEFAULT '理计',
      weight_per_bundle REAL,
      pieces_per_bundle INTEGER,
      lifting_fee REAL,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, code)
    )
  `)

  // Counterparties (suppliers, customers, logistics providers)
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_counterparties (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      contact TEXT,
      phone TEXT,
      address TEXT,
      bank_info TEXT,
      tax_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, name, type)
    )
  `)

  // Projects (construction sites / customer projects)
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      customer_id TEXT REFERENCES biz_counterparties(id),
      contract_no TEXT,
      address TEXT,
      builder TEXT,
      developer TEXT,
      contact TEXT,
      phone TEXT,
      status TEXT DEFAULT 'active',
      metadata TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, name)
    )
  `)

  // Purchase records
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_purchases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      order_no TEXT,
      supplier_id TEXT REFERENCES biz_counterparties(id),
      product_id TEXT REFERENCES biz_products(id),
      bundle_count INTEGER,
      tonnage REAL NOT NULL,
      unit_price REAL NOT NULL,
      total_amount REAL NOT NULL,
      project_id TEXT REFERENCES biz_projects(id),
      invoice_status TEXT DEFAULT 'none',
      payment_status TEXT DEFAULT 'unpaid',
      notes TEXT,
      bubble_id TEXT,
      raw_input TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_purchases_date ON biz_purchases(date)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_purchases_supplier ON biz_purchases(supplier_id)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_purchases_product ON biz_purchases(product_id)')

  // Sales records
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_sales (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      order_no TEXT,
      customer_id TEXT REFERENCES biz_counterparties(id),
      supplier_id TEXT REFERENCES biz_counterparties(id),
      product_id TEXT REFERENCES biz_products(id),
      bundle_count INTEGER,
      tonnage REAL NOT NULL,
      unit_price REAL NOT NULL,
      total_amount REAL NOT NULL,
      cost_price REAL,
      cost_amount REAL,
      profit REAL,
      project_id TEXT REFERENCES biz_projects(id),
      logistics_provider TEXT,
      invoice_status TEXT DEFAULT 'none',
      collection_status TEXT DEFAULT 'uncollected',
      notes TEXT,
      bubble_id TEXT,
      raw_input TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_sales_date ON biz_sales(date)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_sales_customer ON biz_sales(customer_id)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_sales_product ON biz_sales(product_id)')

  // Logistics records
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_logistics (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      waybill_no TEXT,
      carrier_id TEXT REFERENCES biz_counterparties(id),
      project_id TEXT REFERENCES biz_projects(id),
      destination TEXT,
      tonnage REAL,
      freight REAL DEFAULT 0,
      lifting_fee REAL DEFAULT 0,
      total_fee REAL DEFAULT 0,
      driver TEXT,
      driver_phone TEXT,
      license_plate TEXT,
      settlement_status TEXT DEFAULT 'unpaid',
      notes TEXT,
      bubble_id TEXT,
      raw_input TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_logistics_date ON biz_logistics(date)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_logistics_carrier ON biz_logistics(carrier_id)')

  // Payment records
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_payments (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      doc_no TEXT,
      direction TEXT NOT NULL,
      counterparty_id TEXT REFERENCES biz_counterparties(id),
      project_id TEXT REFERENCES biz_projects(id),
      amount REAL NOT NULL,
      method TEXT,
      reference_no TEXT,
      notes TEXT,
      bubble_id TEXT,
      raw_input TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_payments_date ON biz_payments(date)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_payments_counterparty ON biz_payments(counterparty_id)')

  // Invoice records
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_invoices (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      date TEXT NOT NULL,
      direction TEXT NOT NULL,
      invoice_no TEXT,
      counterparty_id TEXT REFERENCES biz_counterparties(id),
      amount REAL NOT NULL,
      tax_rate REAL DEFAULT 0.13,
      tax_amount REAL,
      total_amount REAL,
      related_ids TEXT DEFAULT '[]',
      status TEXT DEFAULT 'registered',
      notes TEXT,
      bubble_id TEXT,
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_invoices_date ON biz_invoices(date)')

  logger.info('Migration: biz tables created/verified')

  // ── v0.6: Document lifecycle + linking ──────────────────────────────

  const purchaseCols = database.pragma('table_info(biz_purchases)') as Array<{ name: string }>
  if (!purchaseCols.some(c => c.name === 'doc_status')) {
    const txnTables = ['biz_purchases', 'biz_sales', 'biz_logistics', 'biz_payments', 'biz_invoices']
    for (const table of txnTables) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN doc_status TEXT NOT NULL DEFAULT 'draft'`)
      database.exec(`ALTER TABLE ${table} ADD COLUMN source_type TEXT`)
      database.exec(`ALTER TABLE ${table} ADD COLUMN source_id TEXT`)
      database.exec(`ALTER TABLE ${table} ADD COLUMN cancel_reason TEXT`)
      database.exec(`ALTER TABLE ${table} ADD COLUMN amended_from TEXT`)
      // Backfill: treat all existing records as confirmed
      database.exec(`UPDATE ${table} SET doc_status = 'confirmed' WHERE deleted_at IS NULL`)
      database.exec(`UPDATE ${table} SET doc_status = 'cancelled' WHERE deleted_at IS NOT NULL`)
      // Performance index
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(tenant_id, doc_status)`)
    }
    logger.info('Migration v0.6: added doc_status + linking columns to all transaction tables')
  }

  // Document linking table (many-to-many)
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_doc_links (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_doc_links_source ON biz_doc_links(source_type, source_id)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_doc_links_target ON biz_doc_links(target_type, target_id)')

  // v0.4: Add preferences column to users table
  const userCols = database.pragma('table_info(users)') as Array<{ name: string }>
  if (!userCols.some(c => c.name === 'preferences')) {
    database.exec("ALTER TABLE users ADD COLUMN preferences TEXT DEFAULT '{}'")
    logger.info('Migration: added preferences column to users')
  }

  // ── v0.7: Event-centric model — line items + soft delete ──────────

  // Bubbles: soft delete support
  const bubbleCols7 = database.pragma('table_info(bubbles)') as Array<{ name: string }>
  if (!bubbleCols7.some(c => c.name === 'deleted_at')) {
    database.exec('ALTER TABLE bubbles ADD COLUMN deleted_at INTEGER')
    database.exec('ALTER TABLE bubbles ADD COLUMN delete_reason TEXT')
    logger.info('Migration v0.7: added deleted_at/delete_reason to bubbles')
  }

  // Purchases: new event fields
  const purCols7 = database.pragma('table_info(biz_purchases)') as Array<{ name: string }>
  if (!purCols7.some(c => c.name === 'location')) {
    database.exec('ALTER TABLE biz_purchases ADD COLUMN location TEXT')
    database.exec('ALTER TABLE biz_purchases ADD COLUMN doc_no TEXT')
    database.exec('ALTER TABLE biz_purchases ADD COLUMN paid_amount REAL DEFAULT 0')
    database.exec('ALTER TABLE biz_purchases ADD COLUMN unpaid_amount REAL DEFAULT 0')
    database.exec('ALTER TABLE biz_purchases ADD COLUMN payment_method TEXT')
    database.exec('ALTER TABLE biz_purchases ADD COLUMN payment_notes TEXT')
    logger.info('Migration v0.7: added event fields to biz_purchases')
  }

  // Sales: new event fields
  const salCols7 = database.pragma('table_info(biz_sales)') as Array<{ name: string }>
  if (!salCols7.some(c => c.name === 'location')) {
    database.exec('ALTER TABLE biz_sales ADD COLUMN location TEXT')
    database.exec('ALTER TABLE biz_sales ADD COLUMN doc_no TEXT')
    database.exec('ALTER TABLE biz_sales ADD COLUMN paid_amount REAL DEFAULT 0')
    database.exec('ALTER TABLE biz_sales ADD COLUMN unpaid_amount REAL DEFAULT 0')
    database.exec('ALTER TABLE biz_sales ADD COLUMN payment_method TEXT')
    database.exec('ALTER TABLE biz_sales ADD COLUMN payment_notes TEXT')
    logger.info('Migration v0.7: added event fields to biz_sales')
  }

  // Logistics: user doc_no
  const logCols7 = database.pragma('table_info(biz_logistics)') as Array<{ name: string }>
  if (!logCols7.some(c => c.name === 'doc_no')) {
    database.exec('ALTER TABLE biz_logistics ADD COLUMN doc_no TEXT')
    logger.info('Migration v0.7: added doc_no to biz_logistics')
  }

  // Purchase line items table
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_purchase_lines (
      id TEXT PRIMARY KEY,
      purchase_id TEXT NOT NULL REFERENCES biz_purchases(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      product_id TEXT REFERENCES biz_products(id),
      brand TEXT,
      material TEXT,
      spec TEXT,
      measure_unit TEXT DEFAULT '吨',
      weigh_mode TEXT DEFAULT '理计',
      bundle_count INTEGER,
      weight_per_pc REAL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      tax_inclusive INTEGER DEFAULT 1,
      subtotal REAL NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_purchase_lines_pid ON biz_purchase_lines(purchase_id)')

  // Sale line items table
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_sale_lines (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES biz_sales(id) ON DELETE CASCADE,
      line_no INTEGER NOT NULL,
      product_id TEXT REFERENCES biz_products(id),
      brand TEXT,
      material TEXT,
      spec TEXT,
      measure_unit TEXT DEFAULT '吨',
      weigh_mode TEXT DEFAULT '理计',
      bundle_count INTEGER,
      weight_per_pc REAL,
      quantity REAL NOT NULL,
      unit_price REAL NOT NULL,
      tax_inclusive INTEGER DEFAULT 1,
      subtotal REAL NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_sale_lines_sid ON biz_sale_lines(sale_id)')

  // Migrate existing single-row purchases to line items (one-time)
  const existingPurchaseLines = (database.prepare('SELECT COUNT(*) as cnt FROM biz_purchase_lines').get() as { cnt: number }).cnt
  if (existingPurchaseLines === 0) {
    const purchases = database.prepare(`
      SELECT id, product_id, bundle_count, tonnage, unit_price, total_amount, created_at, updated_at
      FROM biz_purchases WHERE deleted_at IS NULL
    `).all() as Array<{ id: string; product_id: string; bundle_count: number | null; tonnage: number; unit_price: number; total_amount: number; created_at: number; updated_at: number }>

    if (purchases.length > 0) {
      const insertLine = database.prepare(`
        INSERT INTO biz_purchase_lines (id, purchase_id, line_no, product_id, quantity, unit_price, subtotal, bundle_count, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `)
      const migrate = database.transaction(() => {
        for (const p of purchases) {
          insertLine.run(ulid(), p.id, p.product_id, p.tonnage, p.unit_price, p.total_amount, p.bundle_count, p.created_at, p.updated_at)
        }
      })
      migrate()
      logger.info(`Migration v0.7: migrated ${purchases.length} purchases to line items`)
    }
  }

  // Migrate existing single-row sales to line items (one-time)
  const existingSaleLines = (database.prepare('SELECT COUNT(*) as cnt FROM biz_sale_lines').get() as { cnt: number }).cnt
  if (existingSaleLines === 0) {
    const sales = database.prepare(`
      SELECT id, product_id, bundle_count, tonnage, unit_price, total_amount, created_at, updated_at
      FROM biz_sales WHERE deleted_at IS NULL
    `).all() as Array<{ id: string; product_id: string; bundle_count: number | null; tonnage: number; unit_price: number; total_amount: number; created_at: number; updated_at: number }>

    if (sales.length > 0) {
      const insertLine = database.prepare(`
        INSERT INTO biz_sale_lines (id, sale_id, line_no, product_id, quantity, unit_price, subtotal, bundle_count, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)
      `)
      const migrate = database.transaction(() => {
        for (const s of sales) {
          insertLine.run(ulid(), s.id, s.product_id, s.tonnage, s.unit_price, s.total_amount, s.bundle_count, s.created_at, s.updated_at)
        }
      })
      migrate()
      logger.info(`Migration v0.7: migrated ${sales.length} sales to line items`)
    }
  }

  logger.info('Migration v0.7: event-centric tables ready')

  // ── Migration v1.0: backfill doc_no from order_no/waybill_no ─────────
  const needBackfill = (database.prepare(
    "SELECT COUNT(*) as cnt FROM biz_purchases WHERE (doc_no IS NULL OR doc_no = '') AND order_no IS NOT NULL AND order_no != ''"
  ).get() as { cnt: number }).cnt
  if (needBackfill > 0) {
    const r1 = database.prepare(
      "UPDATE biz_purchases SET doc_no = order_no WHERE (doc_no IS NULL OR doc_no = '') AND order_no IS NOT NULL AND order_no != ''"
    ).run()
    const r2 = database.prepare(
      "UPDATE biz_sales SET doc_no = order_no WHERE (doc_no IS NULL OR doc_no = '') AND order_no IS NOT NULL AND order_no != ''"
    ).run()
    const r3 = database.prepare(
      "UPDATE biz_logistics SET doc_no = waybill_no WHERE (doc_no IS NULL OR doc_no = '') AND waybill_no IS NOT NULL AND waybill_no != ''"
    ).run()
    logger.info(`Migration v1.0: backfilled doc_no — purchases: ${r1.changes}, sales: ${r2.changes}, logistics: ${r3.changes}`)
  }

  // ── Migration v1.0: add space_id to all biz_* tables ─────────────
  const bizPurCols10 = database.pragma('table_info(biz_purchases)') as Array<{ name: string }>
  if (!bizPurCols10.some(c => c.name === 'space_id')) {
    const bizTables = [
      'biz_products', 'biz_counterparties', 'biz_projects',
      'biz_purchases', 'biz_sales', 'biz_logistics',
      'biz_payments', 'biz_invoices',
      'biz_purchase_lines', 'biz_sale_lines', 'biz_doc_links',
    ]
    for (const t of bizTables) {
      database.exec(`ALTER TABLE ${t} ADD COLUMN space_id TEXT`)
    }

    // Backfill: assign all existing records to the first space
    const firstSpace = database.prepare('SELECT id FROM spaces ORDER BY created_at LIMIT 1').get() as { id: string } | undefined
    if (firstSpace) {
      let totalBackfilled = 0
      for (const t of bizTables) {
        const r = database.prepare(`UPDATE ${t} SET space_id = ? WHERE space_id IS NULL`).run(firstSpace.id)
        totalBackfilled += r.changes
      }
      logger.info(`Migration v1.0: added space_id to biz tables, backfilled ${totalBackfilled} records to space ${firstSpace.id}`)
    }

    // Add indexes for space_id
    const indexedTables = [
      'biz_products', 'biz_counterparties',
      'biz_purchases', 'biz_sales', 'biz_logistics',
      'biz_payments', 'biz_invoices',
    ]
    for (const t of indexedTables) {
      database.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_space ON ${t}(space_id)`)
    }
  }

  // ── Migration v1.0.2: Trade entity + cascade support ────────────

  // 1A: Create biz_trades table (parent entity for cascaded trades)
  database.exec(`
    CREATE TABLE IF NOT EXISTS biz_trades (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      space_id TEXT,
      trade_type TEXT NOT NULL,
      date TEXT NOT NULL,
      doc_no TEXT,
      counterparty_id TEXT REFERENCES biz_counterparties(id),
      contact TEXT,
      phone TEXT,
      settlement_method TEXT DEFAULT 'cash',
      credit_term_days INTEGER,
      due_date TEXT,
      total_amount REAL DEFAULT 0,
      total_tonnage REAL DEFAULT 0,
      project_id TEXT REFERENCES biz_projects(id),
      location TEXT,
      logistics_carrier TEXT,
      logistics_freight REAL,
      logistics_lifting_fee REAL,
      logistics_destination TEXT,
      notes TEXT,
      doc_status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_trades_date ON biz_trades(date)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_trades_counterparty ON biz_trades(counterparty_id)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_trades_space ON biz_trades(space_id)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_biz_trades_status ON biz_trades(tenant_id, doc_status)')

  // 1B: Add trade_id column to child tables
  const purCols102 = database.pragma('table_info(biz_purchases)') as Array<{ name: string }>
  if (!purCols102.some(c => c.name === 'trade_id')) {
    const tradeTables = ['biz_purchases', 'biz_sales', 'biz_logistics', 'biz_payments', 'biz_invoices']
    for (const t of tradeTables) {
      database.exec(`ALTER TABLE ${t} ADD COLUMN trade_id TEXT`)
    }
    logger.info('Migration v1.0.2: added trade_id column to all transaction tables')
  }

  // 1C: Add settlement fields to biz_purchases and biz_sales
  const purCols102b = database.pragma('table_info(biz_purchases)') as Array<{ name: string }>
  if (!purCols102b.some(c => c.name === 'settlement_method')) {
    for (const t of ['biz_purchases', 'biz_sales']) {
      database.exec(`ALTER TABLE ${t} ADD COLUMN settlement_method TEXT DEFAULT 'cash'`)
      database.exec(`ALTER TABLE ${t} ADD COLUMN credit_term_days INTEGER`)
      database.exec(`ALTER TABLE ${t} ADD COLUMN due_date TEXT`)
    }
    logger.info('Migration v1.0.2: added settlement_method/credit_term_days/due_date to purchases and sales')
  }

  logger.info('Migration v1.0.2: trade entity + cascade support ready')

  // ── Migration phase0: Time attributes (t_lindy) ─────────────────
  const cpColsPhase0 = database.pragma('table_info(biz_counterparties)') as Array<{ name: string }>
  if (!cpColsPhase0.some(c => c.name === 'first_interaction')) {
    database.exec('ALTER TABLE biz_counterparties ADD COLUMN first_interaction TEXT')
    // Backfill from earliest transaction date across all four transaction tables
    database.exec(`
      UPDATE biz_counterparties SET first_interaction = (
        SELECT MIN(d) FROM (
          SELECT MIN(date) as d FROM biz_purchases
            WHERE supplier_id = biz_counterparties.id AND deleted_at IS NULL
          UNION ALL
          SELECT MIN(date) FROM biz_sales
            WHERE customer_id = biz_counterparties.id AND deleted_at IS NULL
          UNION ALL
          SELECT MIN(date) FROM biz_payments
            WHERE counterparty_id = biz_counterparties.id AND deleted_at IS NULL
          UNION ALL
          SELECT MIN(date) FROM biz_logistics
            WHERE carrier_id = biz_counterparties.id AND deleted_at IS NULL
        )
      ) WHERE first_interaction IS NULL
    `)
    logger.info('Migration phase0: added first_interaction to biz_counterparties with backfill')
  }

  // ── Phase 2: External contacts ──────────────────────────────────
  database.exec(`
    CREATE TABLE IF NOT EXISTS external_contacts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      space_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      counterparty_id TEXT NOT NULL REFERENCES biz_counterparties(id),
      permission_level TEXT NOT NULL DEFAULT 'query',
      enabled INTEGER NOT NULL DEFAULT 1,
      bound_by TEXT,
      bound_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(tenant_id, platform, platform_user_id)
    )
  `)
  database.exec('CREATE INDEX IF NOT EXISTS idx_ext_contacts_lookup ON external_contacts(platform, platform_user_id, enabled)')
  database.exec('CREATE INDEX IF NOT EXISTS idx_ext_contacts_cp ON external_contacts(counterparty_id)')

  database.exec(`
    CREATE TABLE IF NOT EXISTS external_audit_log (
      id TEXT PRIMARY KEY,
      external_contact_id TEXT,
      counterparty_id TEXT,
      action TEXT NOT NULL,
      input TEXT,
      output TEXT,
      created_at INTEGER NOT NULL
    )
  `)

  // ── Phase 3: Multi-role expansion — relax UNIQUE + add is_active ──
  // Check if is_active column exists; if not, migrate the table
  const extColInfo = database.prepare("PRAGMA table_info(external_contacts)").all() as Array<{ name: string }>
  const hasIsActive = extColInfo.some(c => c.name === 'is_active')
  if (!hasIsActive) {
    database.exec('BEGIN TRANSACTION')
    try {
      database.exec(`
        CREATE TABLE external_contacts_v2 (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          space_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          platform_user_id TEXT NOT NULL,
          counterparty_id TEXT NOT NULL REFERENCES biz_counterparties(id),
          permission_level TEXT NOT NULL DEFAULT 'query',
          enabled INTEGER NOT NULL DEFAULT 1,
          is_active INTEGER NOT NULL DEFAULT 0,
          bound_by TEXT,
          bound_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(tenant_id, platform, platform_user_id, counterparty_id)
        )
      `)
      database.exec(`
        INSERT INTO external_contacts_v2
        SELECT id, tenant_id, space_id, platform, platform_user_id, counterparty_id,
               permission_level, enabled, 1 as is_active, bound_by, bound_at, created_at, updated_at
        FROM external_contacts
      `)
      database.exec('DROP TABLE external_contacts')
      database.exec('ALTER TABLE external_contacts_v2 RENAME TO external_contacts')
      database.exec('CREATE INDEX IF NOT EXISTS idx_ext_contacts_lookup ON external_contacts(platform, platform_user_id, enabled, is_active)')
      database.exec('CREATE INDEX IF NOT EXISTS idx_ext_contacts_cp ON external_contacts(counterparty_id)')
      database.exec('COMMIT')
    } catch (err) {
      database.exec('ROLLBACK')
      throw err
    }
  }
}

function seedData(database: Database.Database, defaultPassword: string) {
  const userCount = (database.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
  if (userCount > 0) return

  const now = Date.now()
  const hash = bcrypt.hashSync(defaultPassword, 10)

  // Create default admin user with their own personal space
  const adminId = ulid()
  const personalId = ulid()
  database.prepare('INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(adminId, 'admin', hash, '管理员', 'admin', now)
  database.prepare('INSERT INTO spaces (id, name, description, creator_id, created_at) VALUES (?, ?, ?, ?, ?)').run(personalId, '管理员', '管理员的个人空间', adminId, now)
  database.prepare("INSERT INTO user_spaces (user_id, space_id, role) VALUES (?, ?, 'owner')").run(adminId, personalId)

  // Migrate existing bubbles to admin's space
  const migrated = database.prepare('UPDATE bubbles SET space_id = ? WHERE space_id IS NULL').run(personalId)
  logger.info(`Seed: 1 space, 1 admin user created. ${migrated.changes} bubbles migrated`)
}

export function initDatabase(dataDir: string, defaultPassword = process.env.DEFAULT_PASSWORD || 'bubble123'): Database.Database {
  if (db) return db

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const dbPath = resolve(dataDir, 'bubble.db')
  logger.info(`Database: ${dbPath}`)

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  runMigrations(db, defaultPassword)
  seedData(db, defaultPassword)

  return db
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
  }
}

// Helper: build SQL IN clause with parameter binding
export function buildInClause(values: string[]): { placeholders: string; params: string[] } {
  return {
    placeholders: values.map(() => '?').join(','),
    params: [...values],
  }
}
