import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SCHEMA_SQL } from './schema'
import { runMigrations } from './migrations'

let _db: Database.Database | null = null

export function useDb(): Database.Database {
  if (_db) return _db

  const config = useRuntimeConfig()
  const dbPath = resolve(process.cwd(), config.dbPath)
  const dbDir = dirname(dbPath)
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  // synchronous = NORMAL is safe together with WAL (no risk of DB corruption
  // on crash — worst case is the last committed transaction is rolled back)
  // and is 2-3× faster on write-heavy paths like the upsert loop.
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 10000')
  // Bigger page cache — a full scrape touches indexes across most of the DB;
  // 20MB keeps everything hot without meaningfully increasing memory.
  db.pragma('cache_size = -20000')
  db.exec(SCHEMA_SQL)
  runMigrations(db)

  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
