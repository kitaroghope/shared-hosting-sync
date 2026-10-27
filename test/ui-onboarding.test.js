import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { startFtpFixture } from './fixtures/ftp.js'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-ui-test-'))
process.env.DEVSYNC_HOME = path.join(temp, 'vault')
const previousEnvFile = process.env.DEVSYNC_ENV_FILE
const launchEnv = path.join(temp, 'launch.env')
fs.writeFileSync(launchEnv, 'DEVSYNC_HOST=wrong-launch-host\nDEVSYNC_PASSWORD=wrong-launch-password')
process.env.DEVSYNC_ENV_FILE = launchEnv
const { startServer } = await import('../src/server/index.js')
const { readSessionToken } = await import('../src/server/session.js')
const { closeDb } = await import('../src/core/db.js')
const { listProjects, getSecrets, listEnvOverrides } = await import('../src/core/projects.js')
const { OnboardingService } = await import('../src/server/onboarding.js')
const app = await startServer({ port: 0, openBrowser: false })
const ftp = await startFtpFixture({ password: 'ui-test-password-42' })
fs.mkdirSync(path.join(ftp.rootDir, 'public_html', 'site'), { recursive: true })
after(async () => {
  await app.close()
  await ftp.stop()
  closeDb()
  if (previousEnvFile === undefined) delete process.env.DEVSYNC_ENV_FILE
  else process.env.DEVSYNC_ENV_FILE = previousEnvFile
  fs.rmSync(temp, { recursive: true, force: true })
})
const headers = { 'x-devsync-session': readSessionToken(), 'content-type': 'application/json' }
async function api(method, endpoint, body, expected = 200) {
  const response = await fetch(new URL(endpoint, app.url), { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const data = await response.json()
  assert.equal(response.status, expected, data.error)
  return data
}
const folder = (name) => { const value = path.join(temp, name); fs.mkdirSync(value); return value }
const connectionEntries = () => Object.entries({ DEVSYNC_TRANSPORT: 'ftp', DEVSYNC_HOST: ftp.host, DEVSYNC_PORT: ftp.port, DEVSYNC_USERNAME: ftp.username, DEVSYNC_PASSWORD: ftp.password }).map(([key, value]) => ({ key, value }))

test('directory picker requires a session and returns directories, roots, and parent navigation', async () => {
  const unauthenticated = await fetch(new URL('/api/local', app.url))
  assert.equal(unauthenticated.status, 401)
  const parent = folder('picker')
  const child = path.join(parent, 'child')
  fs.mkdirSync(child)
  fs.writeFileSync(path.join(parent, 'not-a-folder.txt'), 'file')
  const result = await api('GET', `/api/local?path=${encodeURIComponent(parent)}`)
  assert.equal(result.path, await fs.promises.realpath(parent))
  assert.deepEqual(result.entries.map((entry) => entry.name), ['child'])
  assert.equal(result.parent, path.dirname(result.path))
  assert.ok(result.roots.length)
  await api('GET', `/api/local?path=${encodeURIComponent(path.join(parent, 'not-a-folder.txt'))}`, undefined, 400)
  await api('GET', '/api/local?path=relative', undefined, 400)
})

test('selected-folder .env is used without revealing secrets; saved UI project works through CLI', async () => {
  const localPath = folder('environment-project')
  const contents = connectionEntries().map((entry) => `${entry.key}=${entry.value}`).join('\n') + '\nAPP_SECRET=unrelated-application-secret'
  fs.writeFileSync(path.join(localPath, '.env'), contents)
  fs.writeFileSync(path.join(localPath, 'index.html'), 'hello from UI')
  const draft = await api('POST', '/api/onboarding', { localPath }, 201)
  assert.equal(draft.values.DEVSYNC_HOST, ftp.host)
  assert.equal(draft.secrets.DEVSYNC_PASSWORD, true)
  assert.equal(draft.values.DEVSYNC_PASSWORD, undefined)
  assert.equal(draft.sources.DEVSYNC_PASSWORD, '.env')
  assert.equal(JSON.stringify(draft).includes(ftp.password), false)
  assert.equal(JSON.stringify(draft).includes('unrelated-application-secret'), false)
  assert.equal(listProjects().length, 0, 'loading settings does not register a project')
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  const listed = await api('POST', `/api/onboarding/${draft.id}/browse`, { path: '/public_html' })
  assert.deepEqual(listed.entries, [{ name: 'site', path: '/public_html/site' }])
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_REMOTE_PATH', value: '/public_html/site' }] })
  const saved = await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'ui-env' })
  assert.equal(getSecrets(saved.id).DEVSYNC_PASSWORD, ftp.password)
  assert.equal(listEnvOverrides(saved.id).find((entry) => entry.key === 'DEVSYNC_PASSWORD').value, null)
  const viewed = await api('GET', `/api/projects/${saved.id}/env`)
  assert.equal(JSON.stringify(viewed).includes(ftp.password), false)
  assert.equal(viewed.configuration.values.DEVSYNC_REMOTE_PATH, '/public_html/site')
  assert.equal(fs.readFileSync(path.join(localPath, '.env'), 'utf8'), contents)
  assert.deepEqual(fs.readdirSync(path.join(ftp.rootDir, 'public_html', 'site')), [], 'onboarding performs no uploads')
  const exec = promisify(execFile)
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
  const output = await exec(process.execPath, [cli, 'plan', 'ui-env'], {
    cwd: temp, env: { ...process.env, DEVSYNC_ENV_FILE: '' }, timeout: 20000
  })
  assert.match(output.stdout, /\/public_html\/site\/index.html/)
  await api('POST', `/api/onboarding/${draft.id}/test`, {}, 404)
})

test('manual settings need no .env, connection edits invalidate testing, and cancellation leaves no project', async () => {
  const localPath = folder('manual-project')
  const draft = await api('POST', '/api/onboarding', { localPath }, 201)
  assert.equal(draft.values.DEVSYNC_HOST, '')
  assert.equal(draft.values.DEVSYNC_TRANSPORT, '')
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: connectionEntries() })
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  const changed = await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_USERNAME', value: 'different-user' }] })
  assert.equal(changed.tested, false)
  await api('POST', `/api/onboarding/${draft.id}/browse`, { path: '/' }, 409)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: connectionEntries() })
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_REMOTE_PATH', value: '/' }] })
  const saved = await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'ui-manual' })
  assert.equal(saved.remotePath, '/')
  assert.equal(fs.existsSync(path.join(localPath, '.env')), false)
  assert.equal(getSecrets(saved.id).DEVSYNC_PASSWORD, ftp.password)
  const cancelled = await api('POST', '/api/onboarding', { localPath: folder('cancelled') }, 201)
  await api('DELETE', `/api/onboarding/${cancelled.id}`)
  await api('PUT', `/api/onboarding/${cancelled.id}`, { entries: [] }, 404)
  assert.equal(listProjects().some((project) => project.label === 'cancelled'), false)
})

test('invalid settings, failed authentication, missing server folders, and duplicate names do not register projects', async () => {
  const draft = await api('POST', '/api/onboarding', { localPath: folder('failed-setup') }, 201)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'APP_SECRET', value: 'unrelated' }] }, 400)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_HOST', value: {} }] }, 400)
  await api('POST', `/api/onboarding/${draft.id}/test`, {}, 400)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: connectionEntries().map((entry) => entry.key === 'DEVSYNC_PASSWORD' ? { ...entry, value: 'wrong-password' } : entry) })
  const error = await api('POST', `/api/onboarding/${draft.id}/test`, {}, 502)
  assert.equal(JSON.stringify(error).includes('wrong-password'), false)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: connectionEntries() })
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  await api('POST', `/api/onboarding/${draft.id}/browse`, { path: '/public_html/../other' }, 400)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_REMOTE_PATH', value: '/does-not-exist' }] })
  await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'missing-destination' }, 502)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [{ key: 'DEVSYNC_REMOTE_PATH', value: '/public_html/site' }] })
  await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'ui-env' }, 409)
  assert.equal(listProjects().length, 2)
  await api('DELETE', `/api/onboarding/${draft.id}`)
})

test('local APIs reject foreign origins and hosts, and static routes cannot expose sources', async () => {
  const origin = await fetch(new URL('/api/session', app.url), { headers: { origin: 'https://example.com' } })
  assert.equal(origin.status, 403)
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.request(new URL('/api/session', app.url), { headers: { host: 'example.com' } }, (response) => {
      response.resume()
      resolve(response.statusCode)
    })
    request.on('error', reject)
    request.end()
  })
  assert.equal(hostStatus, 403)
  assert.equal((await fetch(new URL('/src/core/secrets.js', app.url))).status, 404)
  const page = await fetch(app.url)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  const html = await page.text()
  assert.match(html, /style.css/)
  assert.match(html, /class="app-version" id="aboutVersion"/)
  const health = await (await fetch(new URL('/api/health', app.url))).json()
  const metadata = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(health.version, metadata.version)
  assert.equal(health.name, metadata.name)
  assert.match(html, /class="brand-logo" src="\/logo\.svg"/)
  const logo = await fetch(new URL('/logo.svg', app.url))
  assert.equal(logo.status, 200)
  assert.match(logo.headers.get('content-type'), /image\/svg\+xml/)
  assert.match(await logo.text(), /<title>DevSync<\/title>/)
})

test('drafts expire and discard connection secrets', () => {
  let now = 1000
  const service = new OnboardingService({ now: () => now, maxAgeMs: 10 })
  const draft = service.load({ localPath: folder('expired') })
  now += 11
  assert.throws(() => service.update(draft.id, []), /expired/)
  assert.equal(service.drafts.size, 0)
})

test('saved project can be relocated after its original folder moves', async () => {
  const original = folder('relocate-original')
  let draft = await api('POST', '/api/onboarding', { localPath: original }, 201)
  await api('PUT', `/api/onboarding/${draft.id}`, { entries: [...connectionEntries(), { key: 'DEVSYNC_REMOTE_PATH', value: '/public_html/site' }] })
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  const saved = await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'relocate-project' })
  const moved = path.join(temp, 'relocated-project')
  fs.renameSync(original, moved)
  const count = listProjects().length
  draft = await api('POST', '/api/onboarding', { projectId: saved.id }, 201)
  assert.equal(draft.localPath, saved.localPath)
  await api('DELETE', `/api/onboarding/${draft.id}`)
  fs.writeFileSync(path.join(moved, '.env'), 'DEVSYNC_DEBOUNCE_MS=987')
  draft = await api('POST', '/api/onboarding', { projectId: saved.id, localPath: moved }, 201)
  assert.equal(draft.projectId, saved.id)
  assert.equal(draft.values.DEVSYNC_DEBOUNCE_MS, '987')
  assert.equal(draft.secrets.DEVSYNC_PASSWORD, true)
  assert.equal(draft.values.DEVSYNC_REMOTE_PATH, '/public_html/site')
  assert.equal(listProjects().find(p => p.id === saved.id).localPath, saved.localPath)
  await api('POST', `/api/onboarding/${draft.id}/test`, {})
  const updated = await api('POST', `/api/onboarding/${draft.id}/save`, { label: 'relocated-project' })
  assert.equal(updated.id, saved.id)
  assert.equal(listProjects().length, count)
  const viewed = await api('GET', `/api/projects/${saved.id}/env`)
  assert.equal(viewed.localPath, fs.realpathSync(moved))
  assert.equal(viewed.configuration.values.DEVSYNC_DEBOUNCE_MS, '987')
  assert.equal(getSecrets(saved.id).DEVSYNC_PASSWORD, ftp.password)
  await api('POST', '/api/onboarding', { projectId: saved.id, localPath: path.join(temp, 'missing-folder') }, 400)
  const otherPath = listProjects().find(p => p.id !== saved.id).localPath
  await api('POST', '/api/onboarding', { projectId: saved.id, localPath: otherPath }, 409)
})
