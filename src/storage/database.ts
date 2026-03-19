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
}

function seedData(database: Database.Database, defaultPassword: string) {
  const userCount = (database.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt
  if (userCount > 0) return

  const now = Date.now()
  const hash = bcrypt.hashSync(defaultPassword, 10)

  // Create default spaces
  const workId = ulid()
  const personalId = ulid()
  database.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(workId, '工作', '团队工作空间', now)
  database.prepare('INSERT INTO spaces (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(personalId, '个人', '个人空间', now)

  // Create default admin user
  const adminId = ulid()
  database.prepare('INSERT INTO users (id, username, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(adminId, 'admin', hash, '管理员', 'admin', now)

  // Assign spaces
  database.prepare('INSERT INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(adminId, workId)
  database.prepare('INSERT INTO user_spaces (user_id, space_id) VALUES (?, ?)').run(adminId, personalId)

  // Migrate existing bubbles to work space
  const migrated = database.prepare('UPDATE bubbles SET space_id = ? WHERE space_id IS NULL').run(workId)
  logger.info(`Seed: 2 spaces, 1 admin user created. ${migrated.changes} bubbles migrated to work space`)
}

export function initDatabase(dataDir: string, defaultPassword = 'bubble123'): Database.Database {
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
