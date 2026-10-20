// server/index.js — loopback-only HTTP server for the v2 UI.
//
// Bind: 127.0.0.1 only. No CORS headers. Session token required for
// mutations. The UI is served from src/ui/index.html (same-origin).
//
// Lifecycle: startServer() resolves once the listener is up. Returns { url }
// so the CLI can print it. The server runs until SIGINT/SIGTERM.

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { handle } from './routes.js'
import { writeSessionToken, readSessionToken } from './session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_DIR = path.join(HERE, '..', 'ui')

const SESSION_COOKIE_NAME = 'devsync_sid'

function serveStatic(req, res) {
  // Map "/" -> index.html
  let p = req.url.split('?')[0]
  if (p === '/' || p === '') p = '/index.html'
  const fp = path.join(UI_DIR, p.replace(/^\/+/, ''))
  // Don't serve files outside UI_DIR
  if (!fp.startsWith(UI_DIR)) {
    res.statusCode = 403
    return res.end('forbidden')
  }
  if (!fs.existsSync(fp)) {
    res.statusCode = 404
    return res.end('not found')
  }
  const ext = path.extname(fp).toLowerCase()
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json'
  }[ext] || 'application/octet-stream'
  res.setHeader('content-type', mime)
  res.setHeader('cache-control', 'no-store')
  fs.createReadStream(fp).pipe(res)
}

export async function startServer({ port = 5180, host = '127.0.0.1', openBrowser = true } = {}) {
  // Make sure a session token exists.
  if (!readSessionToken()) writeSessionToken()

  const server = http.createServer(async (req, res) => {
    // Security headers — defence in depth even on loopback.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    if (req.url.startsWith('/api/')) {
      try {
        await handle(req, res)
      } catch (e) {
        console.error('[server] error in', req.method, req.url, e)
        if (!res.headersSent) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'internal: ' + (e.message || String(e)) }))
        }
      }
      return
    }
    serveStatic(req, res)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })

  const url = `http://${host}:${port}/`
  if (openBrowser) {
    try {
      const { spawn } = await import('node:child_process')
      const opener =
        process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`
      spawn(opener, { shell: true, stdio: 'ignore', detached: true }).unref()
    } catch {
      // best-effort
    }
  }

  // Graceful shutdown
  const close = () =>
    new Promise((res) => {
      server.close(() => res())
    })
  process.once('SIGINT', async () => { await close(); process.exit(0) })
  process.once('SIGTERM', async () => { await close(); process.exit(0) })

  return { server, url, close }
}