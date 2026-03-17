import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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
`

export function initDatabase(dataDir: string): Database.Database {
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
