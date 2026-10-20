// routes.js — REST handlers, mounted by server/index.js.
//
// All mutating routes require `X-Devsync-Session`. GET /api/session does
// not (that's how the UI bootstraps).
//
// Errors are returned as { error: 'message' } with appropriate status.

import path from 'node:path'
import fs from 'node:fs'
import { ENV_SCHEMA } from '../core/envSchema.js'
import {
  listProjects,
  getProject,
  createProject,
  deleteProject,
  updateProject,
  listEnvOverrides,
  setEnvOverrides,
  setSecrets,
  getSecrets,
  hasSecrets,
  effectiveEnv
} from '../core/projects.js'
import { checkSession, readSessionToken } from './session.js'
import { browseRemote, normaliseRemotePath } from './browse.js'
import { credsFromResolved, resolveEnv } from '../core/envResolver.js'
import { createTransport } from '../transport/index.js'

function sessionOk(req, res) {
  const tok = req.headers['x-devsync-session']
  if (!checkSession(tok)) {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ error: 'session token required' }))
    return false
  }
  return true
}

function json(res, status, obj) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (!buf.length) return resolve({})
      try { resolve(JSON.parse(buf.toString('utf8'))) }
      catch (e) { reject(new Error('invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

/** Strip isSecret flags; redact secret values to a presence bool. */
function shapeOverrides(rows) {
  return rows.map((r) => ({
    key: r.key,
    value: r.is_secret ? null : r.value,
    isSecret: !!r.is_secret,
    present: r.is_secret ? !!r.value || undefined : true
  }))
}

export async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = `${req.method} ${url.pathname}`

  // ---------- public ----------
  if (route === 'GET /api/health') {
    return json(res, 200, { ok: true, name: 'devsync', version: '2.0.0-mvp' })
  }

  if (route === 'GET /api/session') {
    // Loopback-only + same-origin = the browser is trusted. We hand back
    // the session token so the UI can attach it to mutating requests.
    // The token is also stored on disk at ~/.devsync/session.token.
    const tok = readSessionToken()
    if (!tok) return json(res, 503, { error: 'session token not initialised' })
    return json(res, 200, { ok: true, token: tok })
  }

  if (route === 'GET /api/schema') {
    return json(res, 200, {
      keys: ENV_SCHEMA.map((s) => ({
        key: s.key,
        type: s.type,
        required: !!s.required,
        default: s.default !== undefined ? s.default : (s.defaultBy === 'transport' ? '__transport_default__' : undefined),
        values: s.values,
        min: s.min,
        max: s.max,
        label: s.label,
        help: s.help,
        secret: s.type === 'secret'
      }))
    })
  }

  // All routes below need auth.
  if (!sessionOk(req, res)) return

  if (route === 'GET /api/projects') {
    const all = listProjects()
    return json(res, 200, {
      projects: all.map((p) => ({
        id: p.id,
        label: p.label,
        localPath: p.localPath,
        enabled: p.enabled,
        lastStatus: p.lastStatus,
        lastError: p.lastError,
        lastSyncAt: p.lastSyncAt,
        credsSet: hasSecrets(p.id)
      }))
    })
  }

  // ---------- project CRUD ----------
  if (route === 'POST /api/projects' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch (e) { return json(res, 400, { error: e.message }) }
    if (!body.label || !body.localPath) return json(res, 400, { error: 'label and localPath required' })
    try {
      const p = createProject({ label: body.label, localPath: path.resolve(body.localPath) })
      return json(res, 201, { id: p.id, label: p.label, localPath: p.localPath })
    } catch (e) {
      return json(res, 400, { error: e.message })
    }
  }

  if (url.pathname.startsWith('/api/projects/') && req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop())
    if (!Number.isFinite(id)) return json(res, 400, { error: 'bad id' })
    const ok = deleteProject(id)
    return json(res, ok ? 200 : 404, { ok })
  }

  // ---------- project env (the main UI form) ----------
  const envMatch = url.pathname.match(/^\/api\/projects\/(\d+)\/env$/)
  if (envMatch) {
    const id = Number(envMatch[1])
    const proj = getProject(id)
    if (!proj) return json(res, 404, { error: 'project not found' })

    if (req.method === 'GET') {
      const rows = listEnvOverrides(id)
      const e = effectiveEnv(id, rows.find((r) => r.key === 'DEVSYNC_TRANSPORT')?.value || 'sftp')
      return json(res, 200, {
        label: proj.label,
        localPath: proj.localPath,
        overrides: shapeOverrides(rows),
        effective: { ...e.values, DEVSYNC_PASSWORD: e.values.DEVSYNC_PASSWORD ? '***' : null, DEVSYNC_PRIVATE_KEY: e.values.DEVSYNC_PRIVATE_KEY ? '***' : null },
        credsSet: hasSecrets(id)
      })
    }

    if (req.method === 'PUT') {
      let body
      try { body = await readJson(req) } catch (e) { return json(res, 400, { error: e.message }) }
      // body = { entries: [{ key, value, isSecret }] }
      if (!Array.isArray(body.entries)) return json(res, 400, { error: 'entries array required' })
      // Separate secrets from overrides.
      const overrides = []
      const secrets = {}
      let transport = 'sftp'
      for (const e of body.entries) {
        if (!e.key || !e.key.startsWith('DEVSYNC_')) return json(res, 400, { error: `bad key: ${e.key}` })
        if (e.key === 'DEVSYNC_TRANSPORT') transport = e.value || 'sftp'
        if (e.isSecret || e.key === 'DEVSYNC_PASSWORD') {
          // Stored as a secret — only set if a non-empty value was supplied
          if (e.value && e.value !== '***') secrets[e.key] = e.value
        } else {
          overrides.push({ key: e.key, value: e.value, isSecret: false })
        }
      }
      // Validate entries
      const errors = []
      for (const e of body.entries) {
        const s = ENV_SCHEMA.find((x) => x.key === e.key)
        if (!s) { errors.push(`unknown key: ${e.key}`); continue }
        const v = e.value
        if (s.required && (!v || v === '')) errors.push(`${e.key} is required`)
        if (s.type === 'enum' && v && !s.values.includes(v)) errors.push(`${e.key} must be one of ${s.values.join(', ')}`)
        if (s.type === 'int' && v) {
          const n = Number(v)
          if (!Number.isInteger(n)) errors.push(`${e.key} must be an integer`)
          else if (s.min != null && n < s.min) errors.push(`${e.key} must be >= ${s.min}`)
          else if (s.max != null && n > s.max) errors.push(`${e.key} must be <= ${s.max}`)
        }
      }
      if (errors.length) return json(res, 400, { error: errors.join('; ') })

      // Preserve existing secrets we weren't given (so the UI doesn't have to
      // re-enter the password to change other fields).
      const existing = getSecrets(id) || {}
      const merged = { ...existing, ...secrets }
      // Strip out empty secrets we explicitly cleared
      for (const e of body.entries) {
        if ((e.isSecret || e.key === 'DEVSYNC_PASSWORD') && (!e.value || e.value === '')) {
          delete merged[e.key]
        }
      }

      setEnvOverrides(id, overrides)
      setSecrets(id, merged)
      return json(res, 200, { ok: true, credsSet: Object.keys(merged).length > 0 })
    }
  }

  // ---------- browse ----------
  if (route === 'GET /api/browse' || (url.pathname === '/api/browse' && req.method === 'GET')) {
    const id = Number(url.searchParams.get('projectId'))
    const sub = url.searchParams.get('path') || '/'
    if (!Number.isFinite(id)) return json(res, 400, { error: 'projectId required' })
    const proj = getProject(id)
    if (!proj) return json(res, 404, { error: 'project not found' })
    if (!hasSecrets(id)) return json(res, 400, { error: 'creds not set for this project' })
    const r = resolveEnv(id, { transport: 'sftp' })
    const creds = credsFromResolved(r.values)
    try {
      const entries = await browseRemote(creds, normaliseRemotePath(sub))
      return json(res, 200, { path: normaliseRemotePath(sub), entries })
    } catch (e) {
      return json(res, 502, { error: e.message })
    }
  }

  // ---------- test connection ----------
  if (url.pathname === '/api/test' && req.method === 'POST') {
    let body
    try { body = await readJson(req) } catch (e) { return json(res, 400, { error: e.message }) }
    const id = Number(body.projectId)
    const proj = getProject(id)
    if (!proj) return json(res, 404, { error: 'project not found' })
    if (!hasSecrets(id)) return json(res, 400, { error: 'creds not set' })
    const r = resolveEnv(id, { transport: 'sftp' })
    const creds = credsFromResolved(r.values)
    try {
      const t = await createTransport(creds, creds.transport)
      await t.list('/')
      await t.close()
      return json(res, 200, { ok: true, transport: creds.transport, host: creds.host })
    } catch (e) {
      return json(res, 502, { error: e.message })
    }
  }

  // 404
  json(res, 404, { error: `no route for ${route}` })
}