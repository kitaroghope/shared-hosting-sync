import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { ReliableTransport } from '../src/transport/reliable.js'
import { uploadOne } from '../src/uploader.js'
import { startFtpFixture } from './fixtures/ftp.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-reliability-'))
process.env.DEVSYNC_HOME = path.join(temp, 'vault')
const { acquireOperation, assertProjectIdle } = await import('../src/core/operationLock.js')
const { openDb, closeDb } = await import('../src/core/db.js')
const { createProject, saveConfiguration } = await import('../src/core/projects.js')
const { DeploymentService } = await import('../src/server/deployments.js')
const { createTransport } = await import('../src/transport/index.js')
const creds = { transport: 'ftp', host: 'example.test', port: 21, username: 'test' }
after(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }) })

test('shared locks reject another process and overlapping destinations, then release', async () => {
  const release = acquireOperation(1, 'watch', { creds, remotePath: '/site' })
  try {
    const script = `import { acquireOperation } from './src/core/operationLock.js'; try { acquireOperation(1, 'sync'); process.exit(9) } catch(e) { console.log(e.message); process.exit(e.statusCode === 409 ? 0 : 8) }`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: process.env })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /operation running/)
    assert.throws(() => acquireOperation(2, 'deploy', { creds, remotePath: '/site/nested' }), /operation running/)
    assert.throws(() => acquireOperation(2, 'deploy', { creds, remotePath: '/' }), /operation running/)
    const sibling = acquireOperation(2, 'sync', { creds, remotePath: '/site-other' })
    sibling()
    assert.throws(() => assertProjectIdle(1), /operation running/)
  } finally { release() }
  const next = acquireOperation(1, 'sync'); next(); next()
})

test('locks from a crashed process are reclaimed without expiring a live owner', async () => {
  const script = `import { acquireOperation } from './src/core/operationLock.js'; acquireOperation(22, 'watch'); console.log('locked'); setInterval(()=>{},1000)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await once(child.stdout, 'data')
    assert.throws(() => acquireOperation(22, 'sync'), /operation running/)
    const exited = once(child, 'exit'); child.kill(); await exited
    const release = acquireOperation(22, 'sync'); release()
  } finally { if (child.exitCode === null) child.kill() }
})

test('recovery retries the whole upload after a lost rename response', async () => {
  const source = path.join(temp, 'content.txt'); fs.writeFileSync(source, 'complete content')
  const remote = new Map()
  let connects = 0, puts = 0, renames = 0
  const transport = await new ReliableTransport(async () => {
    connects++
    return {
      ensureDir: async () => {}, delete: async (file) => remote.delete(file), close: async () => {},
      put: async (local, file) => { puts++; remote.set(file, fs.readFileSync(local, 'utf8')) },
      rename: async (from, to) => {
        remote.set(to, remote.get(from)); remote.delete(from)
        if (++renames === 1) throw Object.assign(new Error('lost acknowledgement'), { code: 'ECONNRESET' })
      }
    }
  }, { retryDelayMs: 1 }).connect()
  try {
    await uploadOne(transport, { abs: source, remote: '/site/index.txt', dirs: ['/site'] })
    assert.equal(connects, 2); assert.equal(puts, 2)
    assert.deepEqual([...remote], [['/site/index.txt', 'complete content']])
  } finally { await transport.close() }
})

test('retries are bounded and authentication/permission errors are not retried', async () => {
  let attempts = 0
  const offline = new ReliableTransport(async () => { attempts++; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) }, { retryDelayMs: 1 })
  await assert.rejects(offline.connect(), /offline/)
  assert.equal(attempts, 3)
  attempts = 0
  const denied = new ReliableTransport(async () => { attempts++; throw Object.assign(new Error('bad credentials'), { code: 530 }) }, { retryDelayMs: 1 })
  await assert.rejects(denied.connect(), /bad credentials/); assert.equal(attempts, 1)
  const permission = await new ReliableTransport(async () => ({ stat: async () => { throw Object.assign(new Error('denied'), { code: 3 }) }, close: async () => {} })).connect()
  await assert.rejects(permission.stat('/site'), /denied/); await permission.close()
})

test('real FTP reconnects after the control connection is dropped', async () => {
  const server = await startFtpFixture()
  const transport = await createTransport({ ...server, transport: 'ftp', secure: false, timeoutMs: 2000 }, undefined, { retryDelayMs: 1 })
  try {
    transport.raw.client.close()
    assert.deepEqual(await transport.list('/'), [])
  } finally { await transport.close(); await server.stop() }
})

test('a dashboard watch excludes CLI uploads and a second dashboard until stopped', async () => {
  const server = await startFtpFixture()
  const root = path.join(temp, 'shared'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'index.html'), 'test')
  const project = createProject({ label: 'shared', localPath: root })
  saveConfiguration(project.id, { DEVSYNC_TRANSPORT: 'ftp', DEVSYNC_HOST: server.host, DEVSYNC_PORT: server.port, DEVSYNC_USERNAME: server.username, DEVSYNC_PASSWORD: server.password, DEVSYNC_REMOTE_PATH: '/site' })
  const service = new DeploymentService(), other = new DeploymentService()
  try {
    service.start(project.id, 'watch')
    const child = spawnSync(process.execPath, ['src/cli.js', 'sync', project.label], { env: process.env, encoding: 'utf8' })
    assert.equal(child.status, 1); assert.match(child.stderr, /operation running/)
    assert.throws(() => other.start(project.id, 'deploy'), /operation running/)
    assert.ok(other.activity(project.id).externalOperation)
    service.stop(project.id); await service.close()
    assert.equal(openDb().prepare('SELECT count(*) AS n FROM operation_locks').get().n, 0)
  } finally { await service.close(); await other.close(); await server.stop() }
})

test('failed connections release dashboard locks for retry and settings edits', async () => {
  const root = path.join(temp, 'failed'); fs.mkdirSync(root)
  const project = createProject({ label: 'failed-connect', localPath: root })
  saveConfiguration(project.id, { DEVSYNC_TRANSPORT: 'ftp', DEVSYNC_HOST: 'example.test', DEVSYNC_PORT: 21, DEVSYNC_USERNAME: 'test', DEVSYNC_PASSWORD: 'test', DEVSYNC_REMOTE_PATH: '/failed' })
  const service = new DeploymentService({ connect: async () => { throw new Error('bad credentials') } })
  try {
    service.start(project.id, 'watch')
    for (let i = 0; i < 100 && service.activity(project.id).active; i++) await delay(10)
    assert.equal(service.activity(project.id).state, 'error')
    assertProjectIdle(project.id)
    const release = acquireOperation(project.id, 'settings'); release()
  } finally { await service.close() }
})
