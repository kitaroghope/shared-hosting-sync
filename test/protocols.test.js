import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startFtpFixture } from './fixtures/ftp.js'
import { startSftpFixture } from './fixtures/sftp.js'
import { createTransport } from '../src/transport/index.js'
import { buildMatcher } from '../src/ignore.js'
import { buildPlan, runPlan } from '../src/uploader.js'

// Public test-only localhost certificate and key; never use for real hosting.
const tls = {
  key: fs.readFileSync(new URL('./fixtures/tls/localhost-key.pem', import.meta.url)),
  cert: fs.readFileSync(new URL('./fixtures/tls/localhost-cert.pem', import.meta.url))
}

after(async () => {
  await new Promise(setImmediate)
  if (process.env.CI) console.log('Protocol fixture resources after cleanup:', process.getActiveResourcesInfo())
})

for (const kind of ['ftps', 'sftp']) {
  test(`${kind}: real server preview, nested deployment, same-size sync, exclusions and failure`, async () => {
    let server, root, transport
    try {
      server = kind === 'sftp' ? await startSftpFixture() : await startFtpFixture({ tls })
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-protocol-'))
      const creds = kind === 'sftp' ? server.creds : {
        transport: 'ftps', secure: true, host: server.host, port: server.port, username: server.username, password: server.password,
        timeoutMs: 3000, secureOptions: { ca: tls.cert }
      }
      fs.mkdirSync(path.join(root, 'nested'))
      fs.writeFileSync(path.join(root, 'nested/index.html'), 'old!')
      const payload = Buffer.alloc(256 * 1024, 0x6b)
      fs.writeFileSync(path.join(root, 'nested/payload.bin'), payload)
      fs.writeFileSync(path.join(root, 'nested/empty.txt'), '')
      fs.writeFileSync(path.join(root, '.env'), 'APP_SECRET=test-only')
      fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules/pkg.js'), 'never')
      const project = { localPath: root, remotePath: '/public_html/site' }, matcher = buildMatcher(root)
      transport = await createTransport(creds)
      const plan = await buildPlan(project, matcher, transport)
      assert.equal(plan.uploads.length, 3)
      await runPlan(plan, transport, { dryRun: true })
      assert.deepEqual(fs.readdirSync(server.rootDir), [])
      assert.equal((await runPlan(plan, transport)).failed.length, 0)
      const remote = path.join(server.rootDir, 'public_html/site/nested/index.html')
      assert.equal(fs.readFileSync(remote, 'utf8'), 'old!')
      assert.deepEqual(fs.readFileSync(path.join(server.rootDir, 'public_html/site/nested/payload.bin')), payload)
      assert.equal((await buildPlan(project, matcher, transport)).uploads.length, 0)
      fs.writeFileSync(path.join(root, 'nested/index.html'), 'new!')
      const changed = await buildPlan(project, matcher, transport)
      assert.equal(changed.uploads.length, 1)
      assert.equal((await runPlan(changed, transport)).failed.length, 0)
      assert.equal(fs.readFileSync(remote, 'utf8'), 'new!')
      assert.equal(fs.existsSync(path.join(server.rootDir, 'public_html/site/.env')), false)
      const bad = await buildPlan({ ...project, remotePath: '/blocked/site' }, matcher, transport)
      fs.writeFileSync(path.join(server.rootDir, 'blocked'), 'file')
      assert.equal((await runPlan(bad, transport)).failed.length, 3)
      assert.equal(fs.existsSync(remote + '.devsync-uploading'), false)
    } catch (error) { console.error(`${kind} integration failed:`, error); throw error }
    finally { if (transport) await transport.close(); if (server) await server.stop(); if (root) fs.rmSync(root, { recursive: true, force: true }) }
  })
}

test('FTPS rejects untrusted certificates instead of disabling verification', async () => {
  const server = await startFtpFixture({ tls })
  try {
    await assert.rejects(createTransport({ transport: 'ftps', secure: true, host: server.host, port: server.port, username: server.username, password: server.password, timeoutMs: 2000 }), /certificate|self.signed/i)
  } finally { await server.stop() }
})
