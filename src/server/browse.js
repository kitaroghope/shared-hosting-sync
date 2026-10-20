// browse.js — remote directory listing for the UI's Browse button.
//
// Wraps the existing transport layer. Normalises paths to POSIX, never
// escapes the connection's root via "../", and never lets the UI reach
// outside what the user typed.

import path from 'node:path'
import { createTransport } from '../transport/index.js'

function norm(p) {
  if (!p) return '/'
  // Treat backslashes as separators (Windows users typing paths).
  let s = p.replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  // collapse ../ by tracking segments
  const parts = []
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { parts.pop(); continue }
    parts.push(seg)
  }
  return '/' + parts.join('/')
}

/** List a remote directory, returning [{ name, type, path }]. */
export async function browseRemote(creds, remotePath) {
  const p = norm(remotePath)
  const t = await createTransport(creds, creds.transport)
  try {
    const entries = await t.list(p)
    return entries.map((e) => ({
      name: e.name,
      type: e.type === 'dir' ? 'dir' : 'file',
      path: joinRemote(p, e.name)
    }))
  } finally {
    await t.close()
  }
}

function joinRemote(base, name) {
  const b = norm(base)
  return b === '/' ? '/' + name : b + '/' + name
}

export { norm as normaliseRemotePath }