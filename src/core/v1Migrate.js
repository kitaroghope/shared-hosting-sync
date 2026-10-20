// v1Migrate.js — import the v1 ~/.devsync/config.json + .env into the v2 DB.
//
// Strategy: one-time on first open of the DB, if v1 files are present and
// the DB has no projects yet, copy them in. The v1 .env is split into
// env_overrides (non-secret) + secrets (PASSWORD).
//
// Idempotent: if there are already projects in the DB, do nothing.
//
// Side-effects on disk: NONE. The v1 files are left in place; if the user
// wants to delete them they can after running `devsync doctor` and seeing
// that v2 is self-sufficient.

import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { HOME, CONFIG_FILE, ENV_FILE } from '../config.js'
import { openDb } from './db.js'
import { listProjects, createProject, setSecrets, setEnvOverrides } from './projects.js'

const V1_TO_V2_KEYS = {
  PROTO: 'DEVSYNC_TRANSPORT',
  HOST: 'DEVSYNC_HOST',
  PORT: 'DEVSYNC_PORT',
  USERNAME: 'DEVSYNC_USERNAME',
  PASSWORD: 'DEVSYNC_PASSWORD',
  PRIVATE_KEY_PATH: 'DEVSYNC_PRIVATE_KEY',
  REMOTE_PATH: 'DEVSYNC_REMOTE_PATH',
  IGNORE_DELETES: 'DEVSYNC_IGNORE_DELETES',
  DRY_RUN: 'DEVSYNC_DRY_RUN',
  DEBOUNCE_MS: 'DEVSYNC_DEBOUNCE_MS'
}

const SECRET_KEYS = new Set(['DEVSYNC_PASSWORD', 'DEVSYNC_PRIVATE_KEY'])

export function maybeRunV1Import() {
  if (!fs.existsSync(CONFIG_FILE)) return { imported: false, reason: 'no v1 config' }
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return { imported: false, reason: 'v1 config unreadable' }
  }
  const existing = listProjects()
  if (existing.length > 0) return { imported: false, reason: 'db already populated' }
  const v1Projects = Array.isArray(cfg.projects) ? cfg.projects : []
  if (!v1Projects.length) return { imported: false, reason: 'no v1 projects' }

  // Read v1 .env once (the creds are shared across projects in v1).
  let envVals = {}
  if (fs.existsSync(ENV_FILE)) {
    envVals = dotenv.parse(fs.readFileSync(ENV_FILE, 'utf8'))
  }

  const imported = []
  for (const p of v1Projects) {
    const localPath = path.resolve(p.localPath)
    if (!fs.existsSync(localPath)) continue // skip — v1 record pointed at a path that's gone
    const proj = createProject({
      label: p.label || p.id,
      localPath
    })
    // env overrides from v1 .env (per-project transport default could differ)
    const entries = []
    const transport = (p.transport || cfg.transport || envVals.PROTO || 'sftp').toLowerCase()
    entries.push({ key: 'DEVSYNC_TRANSPORT', value: transport, isSecret: false })
    if (envVals.HOST) entries.push({ key: 'DEVSYNC_HOST', value: envVals.HOST, isSecret: false })
    if (envVals.PORT) entries.push({ key: 'DEVSYNC_PORT', value: envVals.PORT, isSecret: false })
    if (envVals.USERNAME) entries.push({ key: 'DEVSYNC_USERNAME', value: envVals.USERNAME, isSecret: false })
    if (p.remotePath) entries.push({ key: 'DEVSYNC_REMOTE_PATH', value: p.remotePath, isSecret: false })
    if (envVals.PRIVATE_KEY_PATH)
      entries.push({ key: 'DEVSYNC_PRIVATE_KEY', value: envVals.PRIVATE_KEY_PATH, isSecret: true })
    setEnvOverrides(proj.id, entries)

    // secrets blob — only what we actually have
    const secrets = {}
    if (envVals.PASSWORD) secrets.DEVSYNC_PASSWORD = envVals.PASSWORD
    if (Object.keys(secrets).length) setSecrets(proj.id, secrets)
    imported.push(proj.label)
  }

  return { imported: true, projects: imported, source: 'v1-config' }
}