// Loopback dashboard and authenticated local setup API.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { handle } from './routes.js'
import { writeSessionToken, readSessionToken } from './session.js'
import { OnboardingService } from './onboarding.js'

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui')
const assets = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/ui.js', ['ui.js', 'application/javascript']], ['/style.css', ['style.css', 'text/css']]
])

export async function startServer({ port = 5180, host = '127.0.0.1', openBrowser = true } = {}) {
  if (host !== '127.0.0.1') throw new Error('The dashboard must bind to 127.0.0.1')
  if (!readSessionToken()) writeSessionToken()
  const onboarding = new OnboardingService()
  const server = http.createServer(async (req, res) => {
    const actualPort = server.address().port
    const hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]
    const origins = hosts.map((value) => `http://${value}`)
    if (!hosts.includes(req.headers.host) || req.headers.origin && !origins.includes(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Open the dashboard using its local URL' }))
    }
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (req.url.startsWith('/api/')) {
      try { await handle(req, res, { onboarding }) }
      catch {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'Could not complete that operation. Please try again.' }))
        }
      }
      return
    }
    const asset = assets.get(req.url.split('?')[0])
    if (!asset || req.method !== 'GET') { res.writeHead(404); return res.end('Not found') }
    res.setHeader('content-type', asset[1] + '; charset=utf-8')
    const stream = fs.createReadStream(path.join(UI_DIR, asset[0]))
    stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end('Not found') })
    stream.pipe(res)
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) })
  const url = `http://${host}:${server.address().port}/`
  let closing
  const close = () => {
    if (!closing) {
      onboarding.clear()
      process.off('SIGINT', shutdown)
      process.off('SIGTERM', shutdown)
      closing = new Promise((resolve) => server.close(resolve))
    }
    return closing
  }
  const shutdown = async () => { await close(); process.exit(0) }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  if (openBrowser) {
    try {
      const { spawn } = await import('node:child_process')
      const opener = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`
      spawn(opener, { shell: true, stdio: 'ignore', detached: true }).unref()
    } catch {}
  }
  return { server, url, close }
}
