import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { SCHEMA_SQL } from './schema'

let _db: Database.Database | null = null

export function useDb(): Database.Database {
  if (_db) return _db

  const config = useRuntimeConfig()
  const dbPath = resolve(process.cwd(), config.dbPath)
  const dbDir = dirname(dbPath)
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })

  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA_SQL)

  _db = db
  return db
}

export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}
