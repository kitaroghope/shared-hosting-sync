// db.js — thin node:sqlite wrapper around ~/.devsync/devsync.db
//
// Responsibilities:
//   - Open the DB at ~/.devsync/devsync.db with WAL + foreign keys
//   - Apply any pending migrations on open
//   - Expose prepared statements as a singleton (one connection per process)
//   - Run small helper queries (getProject, listProjects, …)
//
// Everything else (CRUD for projects/secrets/env_overrides/events) is built
// on top of this in core/projects.js, core/secrets.js, etc.

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HOME } from '../config.js'
import { runMigrations } from './migrate.js'

const DB_FILE = path.join(HOME, 'devsync.db')

let _db = null

function ensureHome() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true })
  return HOME
}

/**
 * Open (or return cached) DB connection. Migrations run on first open.
 *
 * Foreign keys are ON. WAL is enabled so a slow UI doesn't lock the CLI.
 * synchronous=NORMAL is the sqlite default and is what we want.
 */
export function openDb() {
  if (_db) return _db
  ensureHome()
  const db = new DatabaseSync(DB_FILE, { open: true })
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA synchronous = NORMAL')
  runMigrations(db)
  _db = db
  return db
}

/** Close the cached connection. Mainly used in tests. */
export function closeDb() {
  if (!_db) return
  _db.close()
  _db = null
}

/** Path to the DB file (for diagnostics, doctor, the UI's GET /api/health). */
export function dbPath() {
  return DB_FILE
}

/** Whether the DB has ever been opened on disk — quick check without paying open cost. */
export function dbExists() {
  return fs.existsSync(DB_FILE)
}
