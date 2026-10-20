// migrate.js — runs SQL files from ./migrations in order.
//
// Files are named NNN_anything.sql (e.g. 001_init.sql). The applied version
// is stored in schema_meta. On open, we read the current version, then
// apply every file whose NNN is greater, in numeric order. Each migration
// runs inside a transaction.
//
// Idempotency: migrations should be safe to re-run with IF NOT EXISTS so a
// crashed-run mid-migration can't leave the DB half-upgraded. The version
// row is the source of truth — we only bump it after the tx commits.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = path.join(HERE, 'migrations')

function listMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return []
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort() // alphabetical = numeric for "001_", "002_", …
    .map((f) => {
      const m = f.match(/^(\d+)_/)
      if (!m) throw new Error(`migration file must start with NNN_: ${f}`)
      return { file: f, version: Number(m[1]) }
    })
}

function currentVersion(db) {
  // schema_meta may not exist yet — brand-new DB starts at version 0.
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get()
  if (!row) return 0
  const r = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()
  return r ? Number(r.value) : 0
}

function setVersion(db, version) {
  // Two cases:
  //   - schema_meta table doesn't exist yet (this is the 001 migration
  //     itself) — 001's SQL creates it and inserts ('version','1').
  //   - schema_meta exists — UPSERT.
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'")
    .get()
  if (hasTable) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(version)
    )
  }
}

export function runMigrations(db) {
  const all = listMigrations()
  let version = currentVersion(db)
  const pending = all.filter((m) => m.version > version)
  for (const m of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8')
    db.exec('BEGIN')
    try {
      db.exec(sql)
      setVersion(db, m.version)
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch {}
      throw new Error(`migration ${m.file} failed: ${e.message}`)
    }
    version = m.version
  }
  return { applied: pending.map((m) => m.file), version }
}