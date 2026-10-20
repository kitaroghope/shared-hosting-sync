// session.js — single-use-on-bootstrap session token file.
//
// On `devsync ui` start we write a random 32-byte hex token to
// ~/.devsync/session.token (mode 0600). The UI fetches the token via
// GET /api/session (same-origin, loopback-only), then sends it as
// `X-Devsync-Session` on every mutating request.
//
// This is enough to keep the door closed against:
//
//   - Other local processes on non-loopback hosts (server binds 127.0.0.1)
//   - Cross-origin pages (no CORS headers)
//   - Casual snooping (token is needed for POST/PUT/DELETE)
//
// It is NOT enough to keep out a determined attacker who can run code as
// the same user — that's the obfuscation-not-KMS trade-off and is
// documented.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { HOME } from '../config.js'

const TOKEN_FILE = path.join(HOME, 'session.token')

function ensureHome() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true })
  return HOME
}

export function writeSessionToken() {
  ensureHome()
  const tok = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(TOKEN_FILE, tok, { mode: 0o600 })
  try { fs.chmodSync(TOKEN_FILE, 0o600) } catch {}
  return tok
}

export function readSessionToken() {
  if (!fs.existsSync(TOKEN_FILE)) return null
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim()
}

export function checkSession(provided) {
  const expected = readSessionToken()
  if (!expected) return false
  if (!provided) return false
  // Both are hex strings of the same length — constant-time compare
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
  } catch {
    return false
  }
}

export function sessionTokenPath() {
  return TOKEN_FILE
}