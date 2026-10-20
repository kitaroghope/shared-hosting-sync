// envResolver.js — assemble the effective DEVSYNC_* values for a project.
//
// Discovery order (first source wins):
//   1. --env-file flag (passed in by the CLI as { envFile })
//   2. process.env.DEVSYNC_ENV_FILE (if set)
//   3. <project>/.devsync.env (project-scoped dotfile, not the user's .env)
//   4. DB vault: env_overrides + secrets (always)
//   5. Schema defaults
//
// Important: items 1–3 are *raw dotenv values*. Item 4 is the structured
// DB. We merge them, with earlier sources winning.

import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { ENV_SCHEMA, defaultsFor } from './envSchema.js'
import { effectiveEnv } from './projects.js'

/**
 * Resolve the effective env for `projectId` against a given transport.
 * Returns { values: { KEY: value }, sources: { KEY: 'cli'|'env'|'file'|'db'|'default' } }
 */
export function resolveEnv(projectId, { transport, envFile } = {}) {
  const sources = {}
  const values = { ...defaultsFor(transport) }
  for (const s of ENV_SCHEMA) {
    sources[s.key] = 'default'
  }

  // DB — always present, lowest priority among user-supplied sources.
  const fromDb = effectiveEnv(projectId, transport)
  for (const [k, v] of Object.entries(fromDb.values)) {
    if (v !== null && v !== undefined && v !== '') {
      values[k] = v
      sources[k] = fromDb.sources[k] || 'db'
    }
  }

  // Then layered sources in priority order: flag > env var > .devsync.env
  // (each one wins over the previous).
  const layers = []

  // (2) env var pointing at a file
  if (!envFile && process.env.DEVSYNC_ENV_FILE) envFile = process.env.DEVSYNC_ENV_FILE
  // (1) explicit flag wins
  if (envFile) layers.push({ kind: 'file', file: envFile })

  // (3) project-scoped .devsync.env (only if no explicit file was given AND no env var pointed us somewhere else)
  if (layers.length === 0) {
    const cwd = process.cwd()
    const candidate = path.join(cwd, '.devsync.env')
    if (fs.existsSync(candidate)) layers.push({ kind: 'file', file: candidate })
  }

  for (const layer of layers) {
    if (!fs.existsSync(layer.file)) continue
    const parsed = dotenv.parse(fs.readFileSync(layer.file, 'utf8'))
    for (const k of Object.keys(parsed)) {
      if (parsed[k] !== '' && parsed[k] != null) {
        values[k] = parsed[k]
        sources[k] = layer.kind
      }
    }
  }

  // Validate everything we have. We don't throw — we collect warnings.
  const warnings = []
  for (const s of ENV_SCHEMA) {
    const v = values[s.key]
    if (v == null || v === '') {
      if (s.required) warnings.push(`${s.key} is required`)
      continue
    }
    const r = validateLive(s.key, v)
    if (!r.ok) warnings.push(r.message)
  }

  return { values, sources, warnings }
}

/**
 * Validate a value against the schema without re-importing — avoids a circular
 * import between projects.js and envSchema.js's `validate`.
 */
function validateLive(key, value) {
  const s = ENV_SCHEMA.find((x) => x.key === key)
  if (!s) return { ok: false, message: `unknown key: ${key}` }
  if ((value === '' || value == null) && s.required) {
    return { ok: false, message: `${key} is required` }
  }
  if (value === '' || value == null) return { ok: true }
  switch (s.type) {
    case 'int': {
      const n = Number(value)
      if (!Number.isInteger(n)) return { ok: false, message: `${key} must be an integer` }
      if (s.min != null && n < s.min) return { ok: false, message: `${key} must be >= ${s.min}` }
      if (s.max != null && n > s.max) return { ok: false, message: `${key} must be <= ${s.max}` }
      return { ok: true }
    }
    case 'bool':
      if (value === true || value === false) return { ok: true }
      if (value === 'true' || value === 'false' || value === '1' || value === '0') return { ok: true }
      return { ok: false, message: `${key} must be true or false` }
    case 'enum':
      if (!s.values.includes(value)) {
        return { ok: false, message: `${key} must be one of: ${s.values.join(', ')}` }
      }
      return { ok: true }
    case 'string':
    case 'path':
    case 'secret':
      return { ok: true }
  }
  return { ok: true }
}

/** Build the credentials shape the transport layer expects, from resolved env. */
export function credsFromResolved(values) {
  const transport = values.DEVSYNC_TRANSPORT
  const port =
    values.DEVSYNC_PORT !== undefined && values.DEVSYNC_PORT !== ''
      ? Number(values.DEVSYNC_PORT)
      : transport === 'sftp'
      ? 22
      : 21
  return {
    transport,
    host: values.DEVSYNC_HOST,
    port,
    username: values.DEVSYNC_USERNAME,
    password: values.DEVSYNC_PASSWORD || undefined,
    privateKeyPath: values.DEVSYNC_PRIVATE_KEY || undefined,
    secure: transport === 'ftps',
    timeoutMs: 20000
  }
}