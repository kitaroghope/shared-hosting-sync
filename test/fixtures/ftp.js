// In-process FTP server fixture for tests.
// Wraps ftp-srv with the devsync test shape: a real filesystem root, a
// username/password we control, and a stop() that tears down cleanly.
//
// Usage:
//   const srv = await startFtpFixture({ rootDir })
//   const transport = new FtpTransport({ host: srv.host, port: srv.port,
//     username: srv.username, password: srv.password, secure: false })
//   await transport.connect()
//   ... run the test ...
//   await srv.stop()

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { FtpSrv } from 'ftp-srv'
import { fileURLToPath } from 'node:url'

const FIXTURE_DIR = path.dirname(fileURLToPath(import.meta.url))

export async function startFtpFixture({ username = 'tester', password = 'pw', rootDir = null, tls } = {}) {
  const root = rootDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-ftp-'))
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true })

  const server = new FtpSrv({
    url: 'ftp://127.0.0.1',
    anonymous: false,
    tls,
    pasv_url: '127.0.0.1',
    pasv_min: 40000,
    pasv_max: 40100,
    // ftp-srv resolves relative paths against process.cwd() by default. We
    // override the root to point at the per-test tmp directory.
    root: () => root
  })

  server.on('login', ({ username: u, password: p, connection }, resolve, reject) => {
    if (u === username && p === password) {
      // ftp-srv treats a numeric zero SIZE message as absent. Real FTP servers
      // return "213 0"; keep empty-file coverage faithful to the protocol.
      const reply = connection.reply.bind(connection)
      connection.reply = (code, message, ...args) => reply(code, message?.message === 0 ? { ...message, message: '0' } : message, ...args)
      return resolve({ root })
    }
    return reject(new Error('bad credentials'))
  })

  // ftp-srv's listen() returns a Promise that resolves with the string
  // 'Listening' once the control port is bound. It does not emit a
  // 'listening' or 'ready' event; we await the Promise instead.
  await server.listen()
  // The actual port (when url has no explicit port) lives on the inner
  // net.Server, not on the FtpSrv instance.
  const bound = server.server.address()
  return {
    host: bound.address,
    port: bound.port,
    username,
    password,
    rootDir: root,
    stop: () =>
      new Promise((res) => {
        server.close()
          .catch(() => {})
          .finally(() => {
            try {
              fs.rmSync(root, { recursive: true, force: true })
            } catch {}
            res()
          })
      })
  }
}
