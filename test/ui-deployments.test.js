import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startFtpFixture } from './fixtures/ftp.js'
import { createMockTransport } from './fixtures/mock-transport.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-ui-deploy-'))
process.env.DEVSYNC_HOME = path.join(temp, 'vault')
const { startServer } = await import('../src/server/index.js')
const { readSessionToken } = await import('../src/server/session.js')
const { createProject, saveConfiguration, getProject } = await import('../src/core/projects.js')
const { closeDb } = await import('../src/core/db.js')
const { DeploymentService } = await import('../src/server/deployments.js')
const app = await startServer({ port: 0, openBrowser: false })
const ftp = await startFtpFixture({ password: 'deployment-test-secret' })
after(async () => { await app.close(); await ftp.stop(); closeDb(); fs.rmSync(temp, { recursive: true, force: true }) })
const headers = { 'content-type': 'application/json', 'x-devsync-session': readSessionToken() }
async function api(method, endpoint, body, expected = 200) {
  const response = await fetch(new URL(endpoint, app.url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json()
  assert.equal(response.status, expected, result.error)
  return result
}
async function until(action, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await action()
    if (predicate(result)) return result
    await delay(40)
  }
  throw new Error('Timed out waiting for deployment activity')
}
const activity = (id) => api('GET', `/api/projects/${id}/activity`)
const done = (id) => until(() => activity(id), (value) => !value.active)
function project(name, extra = {}) {
  const localPath = path.join(temp, name)
  fs.mkdirSync(localPath)
  fs.writeFileSync(path.join(localPath, 'index.html'), 'old!')
  fs.writeFileSync(path.join(localPath, '.env'), 'APP_SECRET=not-for-upload')
  fs.mkdirSync(path.join(localPath, 'test'))
  fs.writeFileSync(path.join(localPath, 'test', 'fixture.txt'), 'ignored')
  fs.writeFileSync(path.join(localPath, '.deployignore'), '/test/\n.deployignore\n')
  const saved = createProject({ label: name, localPath })
  saveConfiguration(saved.id, {
    DEVSYNC_TRANSPORT: 'ftp', DEVSYNC_HOST: ftp.host, DEVSYNC_PORT: ftp.port,
    DEVSYNC_USERNAME: ftp.username, DEVSYNC_PASSWORD: ftp.password,
    DEVSYNC_REMOTE_PATH: `/public_html/${name}`, DEVSYNC_DEBOUNCE_MS: 100, ...extra
  })
  return saved
}

test('dashboard previews never upload; deploy and sync use current content and selected destination', async () => {
  const saved = project('uploads')
  const endpoint = `/api/projects/${saved.id}`
  await api('POST', endpoint + '/preview', { mode: 'sync' }, 202)
  const preview = await done(saved.id)
  assert.equal(preview.state, 'success')
  assert.equal(preview.plan.uploadCount, 1)
  assert.equal(preview.plan.uploads[0].remote, '/public_html/uploads/index.html')
  assert.ok(preview.plan.excluded.some((entry) => entry.rel === '.env'))
  assert.ok(preview.plan.excluded.some((entry) => entry.rel === 'test/'))
  assert.equal(preview.result.uploaded, 0)
  assert.equal(preview.lastSyncAt, null)
  assert.equal(fs.existsSync(path.join(ftp.rootDir, 'public_html/uploads')), false)
  await api('POST', endpoint + '/deploy', {}, 202)
  const deployed = await done(saved.id)
  const remoteFile = path.join(ftp.rootDir, 'public_html/uploads/index.html')
  assert.equal(deployed.result.uploaded, 1)
  assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'old!')
  assert.ok(deployed.lastSyncAt)
  assert.equal(deployed.progress.current, 1)
  assert.equal(deployed.progress.bytes, 4)
  assert.equal(fs.existsSync(path.join(ftp.rootDir, 'public_html/uploads/.env')), false)
  await api('POST', endpoint + '/sync', {}, 202)
  assert.equal((await done(saved.id)).result.uploaded, 0)
  await api('POST', endpoint + '/preview', { mode: 'deploy' }, 202)
  assert.equal((await done(saved.id)).plan.uploadCount, 1)
  fs.writeFileSync(path.join(saved.localPath, 'index.html'), 'new!')
  await api('POST', endpoint + '/sync', { dryRun: true }, 202)
  assert.equal((await done(saved.id)).result.uploaded, 0)
  assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'old!')
  await api('POST', endpoint + '/sync', {}, 202)
  const synced = await done(saved.id)
  assert.equal(synced.state, 'success')
  assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'new!')
  assert.equal(JSON.stringify(synced).includes(ftp.password), false)
  assert.ok(synced.logs.some((entry) => entry.message.includes('Uploaded index.html')))
})

test('watch performs initial sync, follows edits, rejects competing operations, and stops cleanly', async () => {
  const saved = project('watching')
  const endpoint = `/api/projects/${saved.id}`
  await api('POST', endpoint + '/watch', {}, 202)
  await until(() => activity(saved.id), (value) => value.watching && value.state === 'watching' && value.result?.uploaded === 1)
  const remoteFile = path.join(ftp.rootDir, 'public_html/watching/index.html')
  assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'old!')
  await api('POST', endpoint + '/deploy', {}, 409)
  await api('DELETE', endpoint, undefined, 409)
  await api('POST', '/api/onboarding', { projectId: saved.id }, 409)
  fs.writeFileSync(path.join(saved.localPath, 'index.html'), 'new!')
  await until(async () => fs.readFileSync(remoteFile, 'utf8'), (value) => value === 'new!')
  await api('POST', endpoint + '/watch/stop', {}, 202)
  const stopped = await done(saved.id)
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.watching, false)
  assert.equal(getProject(saved.id).lastStatus, 'idle')
  fs.writeFileSync(path.join(saved.localPath, 'index.html'), 'last')
  await delay(400)
  assert.equal(fs.readFileSync(remoteFile, 'utf8'), 'new!')
})

test('saved preview-only setting prevents uploads even when the request asks for writes', async () => {
  const saved = project('read-only', { DEVSYNC_DRY_RUN: true })
  await api('POST', `/api/projects/${saved.id}/deploy`, { dryRun: false }, 202)
  const result = await done(saved.id)
  assert.equal(result.result.dryRun, true)
  assert.equal(result.result.uploaded, 0)
  assert.equal(fs.existsSync(path.join(ftp.rootDir, 'public_html/read-only')), false)
  await api('POST', `/api/projects/${saved.id}/watch`, {}, 202)
  await until(() => activity(saved.id), (value) => value.state === 'watching' && value.result?.dryRun)
  await api('POST', `/api/projects/${saved.id}/watch/stop`, {}, 202)
  await done(saved.id)
  assert.equal(fs.existsSync(path.join(ftp.rootDir, 'public_html/read-only')), false)
})

test('failed uploads remain visible and invalid actions are rejected', async () => {
  const saved = project('failed', { DEVSYNC_REMOTE_PATH: '/blocked/site' })
  fs.writeFileSync(path.join(ftp.rootDir, 'blocked'), 'not-a-directory')
  await api('POST', `/api/projects/${saved.id}/sync`, {}, 202)
  const failed = await done(saved.id)
  assert.equal(failed.state, 'error')
  assert.equal(failed.result.failedCount, 1)
  assert.match(failed.result.failed[0].rel, /index.html/)
  assert.equal(getProject(saved.id).lastStatus, 'error')
  assert.ok(failed.logs.some((entry) => entry.level === 'error'))
  await api('POST', `/api/projects/${saved.id}/sync`, { dryRun: 'false' }, 400)
  await api('POST', `/api/projects/${saved.id}/preview`, { mode: 'invalid' }, 400)
  await api('POST', `/api/projects/${saved.id}/watch/stop`, {}, 409)
  assert.equal((await fetch(new URL(`/api/projects/${saved.id}/activity`, app.url))).status, 401)
})

test('running progress is observable and competing operations cannot share its connection', async () => {
  const saved = project('progress')
  const transport = createMockTransport()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const put = transport.put.bind(transport)
  transport.put = async (...args) => { await gate; return put(...args) }
  const service = new DeploymentService({ connect: async () => transport })
  service.start(saved.id, 'deploy')
  try {
    await until(async () => service.activity(saved.id), (value) => value.phase === 'uploading')
    assert.equal(service.activity(saved.id).progress.current, 0)
    assert.equal(service.activity(saved.id).progress.total, 1)
    assert.throws(() => service.start(saved.id, 'sync'), /already has an operation/)
    release()
    await until(async () => service.activity(saved.id), (value) => !value.active)
    assert.equal(service.activity(saved.id).progress.current, 1)
    assert.equal(transport.calls.filter((call) => call.method === 'close').length, 1)
  } finally { release(); await service.close() }
})

test('server shutdown stops active watchers before returning', async () => {
  const saved = project('shutdown')
  const other = await startServer({ port: 0, openBrowser: false })
  const endpoint = new URL(`/api/projects/${saved.id}/watch`, other.url)
  await fetch(endpoint, { method: 'POST', headers, body: '{}' })
  await until(async () => {
    const response = await fetch(new URL(`/api/projects/${saved.id}/activity`, other.url), { headers })
    return response.json()
  }, (value) => value.state === 'watching')
  await other.close()
  assert.equal(getProject(saved.id).lastStatus, 'idle')
})

test('watch can be stopped while its connection is still opening', async () => {
  const saved = project('early-stop')
  const transport = createMockTransport()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = new DeploymentService({ connect: async () => { await gate; return transport } })
  try {
    service.start(saved.id, 'watch')
    const stopping = service.stop(saved.id)
    assert.equal(stopping.stopping, true)
    release()
    const stopped = await until(async () => service.activity(saved.id), (value) => !value.active)
    assert.equal(stopped.state, 'stopped')
    assert.equal(transport.calls.some((call) => call.method === 'put'), false)
    assert.equal(transport.calls.filter((call) => call.method === 'close').length, 1)
  } finally { release(); await service.close() }
})

test('initial scan requires confirmation, performs no uploads, and seeds a persistent baseline', async () => {
  const saved = project('initial-scan')
  const endpoint = `/api/projects/${saved.id}`
  const remoteDir = path.join(ftp.rootDir, 'public_html', 'initial-scan')
  fs.mkdirSync(remoteDir, { recursive: true })
  fs.writeFileSync(path.join(remoteDir, 'index.html'), 'old!')
  fs.writeFileSync(path.join(remoteDir, 'server-only.txt'), 'keep me')
  await api('POST', endpoint + '/scan', {}, 400)
  await api('POST', endpoint + '/scan', { confirmed: 'true' }, 400)
  const unauthorized = await fetch(new URL(endpoint + '/scan', app.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: true }) })
  assert.equal(unauthorized.status, 401)
  const before = fs.statSync(path.join(remoteDir, 'index.html')).mtimeMs
  await api('POST', endpoint + '/scan', { confirmed: true }, 202)
  const scan = await done(saved.id)
  assert.equal(scan.state, 'success')
  assert.equal(scan.result.scanned, 1)
  assert.equal(scan.result.matched, 1)
  assert.equal(scan.result.uploaded, 0)
  assert.equal(scan.lastSyncAt, null)
  assert.equal(scan.baseline.trackedFiles, 1)
  assert.ok(scan.baseline.scannedAt)
  assert.equal(fs.statSync(path.join(remoteDir, 'index.html')).mtimeMs, before)
  assert.equal(fs.readFileSync(path.join(remoteDir, 'server-only.txt'), 'utf8'), 'keep me')
  let connects = 0
  const restarted = new DeploymentService({ connect: async () => { connects++; throw new Error('No remote connection should be opened') } })
  try {
    restarted.start(saved.id, 'sync')
    await until(async () => restarted.activity(saved.id), value => !value.active)
    assert.equal(restarted.activity(saved.id).state, 'success')
    assert.equal(restarted.activity(saved.id).result.uploaded, 0)
    restarted.start(saved.id, 'preview')
    await until(async () => restarted.activity(saved.id), value => !value.active)
    assert.equal(restarted.activity(saved.id).plan.skippedCount, 1)
    assert.equal(connects, 0)
  } finally { await restarted.close() }
})
