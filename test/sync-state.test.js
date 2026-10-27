import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { createMockTransport } from './fixtures/mock-transport.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-sync-state-'))
process.env.DEVSYNC_HOME = path.join(temp, 'vault')
const { createProject, deleteProject } = await import('../src/core/projects.js')
const { closeDb, openDb } = await import('../src/core/db.js')
const { syncScope, syncStatus, readSyncFiles } = await import('../src/core/syncState.js')
const { buildPlan, runPlan, scanServer } = await import('../src/uploader.js')
const { buildMatcher } = await import('../src/ignore.js')
const { ProjectWatcher } = await import('../src/watcher.js')
const { runMigrations } = await import('../src/core/migrate.js')
after(() => { closeDb(); fs.rmSync(temp, { recursive: true, force: true }) })
const creds = { transport: 'ftp', host: 'example.test', port: 21, username: 'user' }
function setup(name) {
  const localPath = path.join(temp, name)
  fs.mkdirSync(localPath)
  fs.writeFileSync(path.join(localPath, 'index.html'), 'old!')
  const project = { ...createProject({ label: name, localPath }), remotePath: '/site' }
  project.syncScope = syncScope(project, creds)
  return { project, matcher: buildMatcher(localPath), file: path.join(localPath, 'index.html'), transport: createMockTransport() }
}
const plan = ({ project, matcher }, transport = null) => buildPlan(project, matcher, transport)

test('normal sync persists successful uploads across database reopen and never reads remote metadata', async () => {
  const ctx = setup('persistent')
  fs.writeFileSync(path.join(ctx.project.localPath, '.env'), 'SECRET=excluded')
  const initial = await plan(ctx)
  assert.equal(initial.uploads.length, 1)
  assert.ok(initial.excluded.some(file => file.rel === '.env'))
  await runPlan(initial, ctx.transport)
  assert.equal(ctx.transport.calls.some(call => ['stat', 'checksum', 'list'].includes(call.method)), false)
  closeDb()
  assert.equal((await plan(ctx)).skipped.length, 1)
  assert.equal(syncStatus(ctx.project.syncScope).trackedFiles, 1)
  await delay(5)
  fs.writeFileSync(ctx.file, 'new!')
  assert.equal((await plan(ctx)).uploads.length, 1, 'same size edits are detected')
  await runPlan(await plan(ctx), ctx.transport)
  const before = fs.statSync(ctx.file)
  fs.utimesSync(ctx.file, before.atime, new Date(before.mtimeMs + 3000))
  assert.equal((await plan(ctx)).uploads.length, 1, 'timestamp changes are detected')
  await runPlan(await plan(ctx), ctx.transport)
  fs.writeFileSync(ctx.file, 'larger file')
  fs.writeFileSync(path.join(ctx.project.localPath, 'new.txt'), 'new')
  assert.equal((await plan(ctx)).uploads.length, 2)
  await runPlan(await plan(ctx), ctx.transport)
  assert.equal((await plan(ctx)).uploads.length, 0)
  const forced = await buildPlan(ctx.project, ctx.matcher, null, { force: true })
  assert.equal(forced.uploads.length, 2)
  deleteProject(ctx.project.id)
  assert.equal(openDb().prepare('SELECT COUNT(*) AS count FROM sync_targets WHERE project_id = ?').get(ctx.project.id).count, 0)
})

test('preview and failed uploads do not mark pending files as synchronized; partial successes survive retries', async () => {
  const ctx = setup('partial')
  fs.writeFileSync(path.join(ctx.project.localPath, 'second.html'), 'second')
  await runPlan(await plan(ctx), null, { dryRun: true })
  assert.equal(syncStatus(ctx.project.syncScope).ready, false)
  const rename = ctx.transport.rename
  ctx.transport.rename = async (from, to) => {
    if (to.endsWith('/second.html')) throw new Error('permission denied')
    return rename(from, to)
  }
  const result = await runPlan(await plan(ctx), ctx.transport)
  assert.equal(result.done.length, 1)
  assert.equal(result.failed.length, 1)
  assert.equal(syncStatus(ctx.project.syncScope).trackedFiles, 1)
  const retry = await plan(ctx)
  assert.deepEqual(retry.uploads.map(file => file.rel), ['second.html'])
  assert.equal(retry.skipped.length, 1)
  ctx.transport.rename = rename
  await runPlan(retry, ctx.transport)
  assert.equal((await plan(ctx)).uploads.length, 0)
})

test('an edit during upload remains pending for the next sync', async () => {
  const ctx = setup('mid-upload')
  const put = ctx.transport.put
  ctx.transport.put = async (...args) => { await put(...args); fs.writeFileSync(ctx.file, 'edited while uploading') }
  await runPlan(await plan(ctx), ctx.transport)
  assert.equal(syncStatus(ctx.project.syncScope).trackedFiles, 0)
  assert.equal((await plan(ctx)).uploads.length, 1)
})

test('explicit scan verifies server content, saves only matches, and never uploads', async () => {
  const ctx = setup('scan')
  fs.writeFileSync(path.join(ctx.project.localPath, 'different.html'), 'new!')
  fs.writeFileSync(path.join(ctx.project.localPath, 'missing.html'), 'missing')
  ctx.transport = createMockTransport({ remoteRoot: { site: {
    'index.html': { content: 'old!', _meta: { type: 'file', size: 4 } },
    'different.html': { content: 'old!', _meta: { type: 'file', size: 4 } },
    'server-only.txt': { content: 'keep', _meta: { type: 'file', size: 4 } }
  } } })
  const result = await scanServer(ctx.project, ctx.matcher, ctx.transport)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.uploads.length, 2)
  assert.equal(syncStatus(ctx.project.syncScope).trackedFiles, 1)
  assert.ok(syncStatus(ctx.project.syncScope).scannedAt)
  assert.equal(ctx.transport.calls.some(call => ['put', 'rename', 'delete', 'ensureDir'].includes(call.method)), false)
  assert.deepEqual((await plan(ctx)).uploads.map(file => file.rel).sort(), ['different.html', 'missing.html'])
  assert.ok(ctx.transport.remote.site['server-only.txt'])
  ctx.transport.failNext('checksum', new Error('connection lost'))
  await assert.rejects(scanServer(ctx.project, ctx.matcher, ctx.transport), /connection lost/)
  assert.equal(syncStatus(ctx.project.syncScope).trackedFiles, 1, 'failed scan preserves previous baseline')
})

test('a fresh explicit scan detects remote-only edits and replaces stale matching records', async () => {
  const ctx = setup('remote-edits')
  await runPlan(await plan(ctx), ctx.transport)
  ctx.transport.remote.site['index.html'].content = 'evil'
  assert.equal((await plan(ctx)).uploads.length, 0, 'ordinary sync trusts the database')
  await scanServer(ctx.project, ctx.matcher, ctx.transport)
  assert.equal((await plan(ctx)).uploads.length, 1, 'explicit scan invalidates remote mismatches')
})

test('sync metadata is isolated by source, protocol, host, port, user and destination, but not password', async () => {
  const ctx = setup('target-scope')
  await runPlan(await plan(ctx), ctx.transport)
  for (const override of [{ host: 'other.test' }, { port: 2121 }, { username: 'other' }, { transport: 'sftp' }]) {
    assert.equal(syncStatus(syncScope(ctx.project, { ...creds, ...override })).ready, false)
  }
  assert.equal(syncStatus(syncScope({ ...ctx.project, remotePath: '/other' }, creds)).ready, false)
  assert.equal(syncStatus(syncScope({ ...ctx.project, localPath: '/other' }, creds)).ready, false)
  assert.equal(syncStatus(syncScope(ctx.project, { ...creds, password: 'changed' })).trackedFiles, 1)
  assert.equal(syncStatus(syncScope(ctx.project, { ...creds, host: 'EXAMPLE.TEST' })).trackedFiles, 1)
})

test('watch cycles use the same persisted baseline and only upload changed local files', async () => {
  const ctx = setup('watch-baseline')
  await runPlan(await plan(ctx), ctx.transport)
  ctx.transport.calls.length = 0
  const watcher = new ProjectWatcher(ctx.project, ctx.matcher, ctx.transport)
  await watcher.runCycle()
  assert.equal(ctx.transport.calls.length, 0)
  fs.writeFileSync(ctx.file, 'watch change')
  await watcher.runCycle()
  assert.equal(ctx.transport.calls.filter(call => call.method === 'put').length, 1)
  assert.equal(ctx.transport.calls.some(call => ['stat', 'checksum', 'list'].includes(call.method)), false)
  assert.equal(readSyncFiles(ctx.project.syncScope).get('index.html').size, 12)
  await watcher.stop()
})

test('version 2 databases migrate without losing saved projects', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(new URL('../src/core/migrations/001_init.sql', import.meta.url), 'utf8'))
  db.exec(fs.readFileSync(new URL('../src/core/migrations/002_operation_locks.sql', import.meta.url), 'utf8'))
  db.exec("UPDATE schema_meta SET value = '2' WHERE key = 'version'")
  db.exec("INSERT INTO projects (label, local_path, created_at, updated_at) VALUES ('existing', '/existing', 'now', 'now')")
  const result = runMigrations(db)
  assert.equal(result.version, 3)
  assert.deepEqual(result.applied, ['003_sync_state.sql'])
  assert.equal(db.prepare('SELECT label FROM projects').get().label, 'existing')
  assert.equal(runMigrations(db).applied.length, 0)
  db.close()
})
