// projects.js — CRUD for the projects / secrets / env_overrides tables.
// The CLI, the UI, and the v1→v2 importer all go through this layer.
//
// Conventions:
//   - All public functions take an already-open db handle (or call openDb()).
//   - is_secret fields are NEVER returned in plain form to the UI — the
//     route layer replaces them with a presence flag.
//   - Upsert = insert or update by primary key / unique constraint.

import fs from 'node:fs'
import path from 'node:path'
import { openDb } from './db.js'
import { encrypt, decrypt } from './secrets.js'
import { defaultsFor } from './envSchema.js'

const now = () => new Date().toISOString()

// ---------- projects ----------

export function listProjects({ enabledOnly = false } = {}) {
  const db = openDb()
  const sql = enabledOnly
    ? 'SELECT * FROM projects WHERE enabled = 1 ORDER BY label'
    : 'SELECT * FROM projects ORDER BY label'
  return db.prepare(sql).all().map(rowToProject)
}

export function getProject(id) {
  const db = openDb()
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
  return row ? rowToProject(row) : null
}

export function getProjectByLabel(label) {
  const db = openDb()
  const row = db.prepare('SELECT * FROM projects WHERE label = ?').get(label)
  return row ? rowToProject(row) : null
}

export function getProjectByLocalPath(localPath) {
  const db = openDb()
  const row = db.prepare('SELECT * FROM projects WHERE local_path = ?').get(localPath)
  return row ? rowToProject(row) : null
}

export function createProject({ label, localPath }) {
  if (!label) throw new Error('label is required')
  if (!localPath) throw new Error('localPath is required')
  if (!fs.existsSync(localPath)) throw new Error(`localPath does not exist: ${localPath}`)
  if (!fs.statSync(localPath).isDirectory()) throw new Error(`localPath is not a directory: ${localPath}`)
  const db = openDb()
  const t = now()
  try {
    const info = db
      .prepare(
        `INSERT INTO projects (label, local_path, enabled, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`
      )
      .run(label, localPath, t, t)
    return getProject(info.lastInsertRowid)
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      throw new Error(`project "${label}" already exists`)
    }
    throw e
  }
}

export function updateProject(id, patch) {
  const db = openDb()
  const allowed = ['label', 'local_path', 'enabled']
  const sets = []
  const vals = []
  for (const k of allowed) {
    if (k in patch) {
      sets.push(`${k} = ?`)
      // SQLite needs integers for INTEGER columns; JS booleans don't bind.
      vals.push(toSqlValue(patch[k]))
    }
  }
  if (!sets.length) return getProject(id)
  sets.push('updated_at = ?')
  vals.push(now())
  vals.push(id)
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  return getProject(id)
}

function toSqlValue(v) {
  if (typeof v === 'boolean') return v ? 1 : 0
  return v
}

export function deleteProject(id) {
  const db = openDb()
  const info = db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  return info.changes > 0
}

export function setStatus(id, status, { error = null } = {}) {
  const db = openDb()
  db.prepare(
    `UPDATE projects SET last_status = ?, last_error = ?, updated_at = ? WHERE id = ?`
  ).run(status, error, now(), id)
}

// ---------- secrets ----------

/** Persist creds for a project. Replaces the previous row. */
export function setSecrets(projectId, secretsObj) {
  const db = openDb()
  const { ciphertext, iv, auth_tag } = encrypt(secretsObj)
  db.prepare(
    `INSERT INTO secrets (project_id, ciphertext, iv, auth_tag, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       ciphertext = excluded.ciphertext,
       iv = excluded.iv,
       auth_tag = excluded.auth_tag,
       updated_at = excluded.updated_at`
  ).run(projectId, ciphertext, iv, auth_tag, now())
}

/** Get the decrypted secrets object for a project (or null). */
export function getSecrets(projectId) {
  const db = openDb()
  const row = db.prepare('SELECT ciphertext, iv, auth_tag FROM secrets WHERE project_id = ?').get(projectId)
  if (!row) return null
  return decrypt(row)
}

/** Tell whether a project has any secrets stored. */
export function hasSecrets(projectId) {
  const db = openDb()
  const row = db.prepare('SELECT 1 FROM secrets WHERE project_id = ?').get(projectId)
  return !!row
}

export function deleteSecrets(projectId) {
  const db = openDb()
  db.prepare('DELETE FROM secrets WHERE project_id = ?').run(projectId)
}

// ---------- env_overrides ----------

/**
 * Replace the full env_overrides set for a project.
 * `entries` is [{ key, value, isSecret }]. Pass [] to clear.
 */
export function setEnvOverrides(projectId, entries) {
  const db = openDb()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM env_overrides WHERE project_id = ?').run(projectId)
    const ins = db.prepare(
      `INSERT INTO env_overrides (project_id, key, value, is_secret, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    for (const e of entries) {
      ins.run(
        projectId,
        e.key,
        e.isSecret ? null : (e.value ?? null),
        e.isSecret ? 1 : 0,
        now()
      )
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

export function listEnvOverrides(projectId) {
  const db = openDb()
  return db
    .prepare('SELECT key, value, is_secret FROM env_overrides WHERE project_id = ? ORDER BY key')
    .all(projectId)
}

/**
 * Build the effective env (key → value) for a project by layering:
 *   1. schema defaults (defaultsFor(transport))
 *   2. env_overrides from the DB (non-secret keys)
 *   3. secrets from the DB (secret keys)
 *
 * Returns { values, sources } where sources maps KEY → 'default'|'override'|'secret'.
 */
export function effectiveEnv(projectId, transport) {
  const values = { ...defaultsFor(transport) }
  const sources = {}
  for (const k of Object.keys(values)) sources[k] = 'default'
  // env_overrides (non-secret only)
  const ovs = listEnvOverrides(projectId).filter((r) => !r.is_secret)
  for (const r of ovs) {
    if (r.value !== null && r.value !== undefined && r.value !== '') {
      values[r.key] = r.value
      sources[r.key] = 'override'
    }
  }
  // secrets (everything that is_secret)
  const secrets = getSecrets(projectId) || {}
  for (const [k, v] of Object.entries(secrets)) {
    if (v !== null && v !== undefined && v !== '') {
      values[k] = v
      sources[k] = 'secret'
    }
  }
  return { values, sources }
}

// ---------- helpers ----------

function rowToProject(r) {
  return {
    id: r.id,
    label: r.label,
    localPath: r.local_path,
    enabled: !!r.enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastSyncAt: r.last_sync_at,
    lastUploadBytes: r.last_upload_bytes,
    probeShell: r.probe_shell,
    probeTar: r.probe_tar,
    probeUnzip: r.probe_unzip,
    probeAt: r.probe_at
  }
}