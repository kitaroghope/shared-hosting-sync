// test/envResolver.test.js — discovery chain order + validation warnings
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

if (!process.env.DEVSYNC_HOME) {
  process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-env-'))
}
if (!fs.existsSync(process.env.DEVSYNC_HOME)) fs.mkdirSync(process.env.DEVSYNC_HOME, { recursive: true })

const { openDb } = await import('../src/core/db.js')
{
  const db = openDb()
  db.exec('DELETE FROM secrets')
  db.exec('DELETE FROM env_overrides')
  db.exec('DELETE FROM events')
  db.exec('DELETE FROM projects')
}

const { createProject, setSecrets, setEnvOverrides, deleteProject } = await import('../src/core/projects.js')
const { resolveEnv, credsFromResolved } = await import('../src/core/envResolver.js')
const { ENV_SCHEMA } = await import('../src/core/envSchema.js')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-envproj-'))
const freshTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-envproj-'))

test('defaultsFor produces the transport default port', async () => {
  const m = await import('../src/core/envSchema.js')
  assert.equal(m.defaultsFor('sftp').DEVSYNC_PORT, 22)
  assert.equal(m.defaultsFor('ftp').DEVSYNC_PORT, 21)
  assert.equal(m.defaultsFor('ftps').DEVSYNC_PORT, 21)
})

test('resolveEnv picks DB over defaults', () => {
  const p = createProject({ label: 'r1', localPath: freshTmp() })
  setEnvOverrides(p.id, [
    { key: 'DEVSYNC_TRANSPORT', value: 'sftp', isSecret: false },
    { key: 'DEVSYNC_HOST', value: 'db-host.example.com', isSecret: false }
  ])
  const r = resolveEnv(p.id, { transport: 'sftp' })
  assert.equal(r.values.DEVSYNC_HOST, 'db-host.example.com')
  assert.equal(r.sources.DEVSYNC_HOST, 'override')
  assert.equal(r.values.DEVSYNC_PORT, 22)
  assert.equal(r.sources.DEVSYNC_PORT, 'default')
  deleteProject(p.id)
})

test('resolveEnv surfaces required-key warnings', () => {
  const p = createProject({ label: 'r2', localPath: freshTmp() })
  const r = resolveEnv(p.id, { transport: 'sftp' })
  assert.ok(r.warnings.some((w) => w.includes('DEVSYNC_HOST')), 'expected DEVSYNC_HOST warning, got: ' + JSON.stringify(r.warnings))
  assert.ok(r.warnings.some((w) => w.includes('DEVSYNC_USERNAME')))
  deleteProject(p.id)
})

test('credsFromResolved produces the transport shape', () => {
  const c = credsFromResolved({
    DEVSYNC_TRANSPORT: 'sftp',
    DEVSYNC_HOST: 'h',
    DEVSYNC_PORT: 2222,
    DEVSYNC_USERNAME: 'u',
    DEVSYNC_PASSWORD: 'p'
  })
  assert.deepEqual(c, { transport: 'sftp', host: 'h', port: 2222, username: 'u', password: 'p', privateKeyPath: undefined, secure: false, timeoutMs: 20000 })
  const ftps = credsFromResolved({ DEVSYNC_TRANSPORT: 'ftps', DEVSYNC_HOST: 'h', DEVSYNC_USERNAME: 'u', DEVSYNC_PASSWORD: 'p' })
  assert.equal(ftps.secure, true)
  assert.equal(ftps.port, 21)
})

test('validate catches bad enum/int', () => {
  assert.equal(ENV_SCHEMA.length, 10)
  // spot-check the int min
  const port = ENV_SCHEMA.find((s) => s.key === 'DEVSYNC_PORT')
  assert.ok(port)
  assert.equal(port.min, 1)
  assert.equal(port.max, 65535)
})

test('project-scoped connection files set the protocol port and ignore unrelated keys', () => {
  const localPath = freshTmp()
  const p = createProject({ label: 'file-config', localPath })
  try {
    fs.writeFileSync(path.join(localPath, '.devsync.env'), 'DEVSYNC_TRANSPORT=ftp\nDEVSYNC_HOST=project-host\nAPP_SECRET=ignored\n')
    const r = resolveEnv(p.id, { transport: 'sftp' })
    assert.equal(r.values.DEVSYNC_HOST, 'project-host')
    assert.equal(r.values.DEVSYNC_PORT, 21)
    assert.equal(r.values.APP_SECRET, undefined)
    assert.equal(r.values.DEVSYNC_REMOTE_PATH, undefined, 'no implicit server root')
    assert.ok(r.warnings.some((w) => w.includes('DEVSYNC_REMOTE_PATH')))
  } finally {
    deleteProject(p.id)
    fs.rmSync(localPath, { recursive: true, force: true })
  }
})

test('.env overrides legacy and saved values; explicit files and CLI options take precedence', () => {
  const localPath = freshTmp()
  const external = freshTmp()
  const p = createProject({ label: 'precedence', localPath })
  const previousFile = process.env.DEVSYNC_ENV_FILE
  try {
    delete process.env.DEVSYNC_ENV_FILE
    setEnvOverrides(p.id, [{ key: 'DEVSYNC_HOST', value: 'saved-host', isSecret: false }])
    fs.writeFileSync(path.join(localPath, '.devsync.env'), 'DEVSYNC_HOST=legacy-host')
    fs.writeFileSync(path.join(localPath, '.env'), 'DEVSYNC_HOST=project-host\nAPP_SECRET=must-not-import\nDEVSYNC_REMOTE_PATH=/project')
    const automatic = resolveEnv(p.id)
    assert.equal(automatic.values.DEVSYNC_HOST, 'project-host')
    assert.equal(automatic.sources.DEVSYNC_HOST, '.env')
    assert.equal(automatic.values.APP_SECRET, undefined)
    const file = path.join(external, 'credentials.env')
    fs.writeFileSync(file, 'DEVSYNC_HOST=explicit-host')
    process.env.DEVSYNC_ENV_FILE = file
    assert.equal(resolveEnv(p.id).values.DEVSYNC_HOST, 'explicit-host')
    assert.equal(resolveEnv(p.id, { envFile: path.join(localPath, '.env') }).values.DEVSYNC_HOST, 'project-host')
    assert.equal(resolveEnv(p.id, { envFile: file, overrides: { DEVSYNC_HOST: 'cli-host' } }).values.DEVSYNC_HOST, 'cli-host')
    assert.equal(resolveEnv(p.id, { envFile: file }).values.DEVSYNC_REMOTE_PATH, undefined, 'explicit file replaces auto discovery')
    assert.throws(() => resolveEnv(p.id, { envFile: path.join(external, 'missing') }), /does not exist/)
    fs.writeFileSync(path.join(localPath, 'credentials.txt'), 'DEVSYNC_PASSWORD=secret')
    assert.throws(() => resolveEnv(p.id, { envFile: path.join(localPath, 'credentials.txt') }), /stays excluded/)
  } finally {
    if (previousFile === undefined) delete process.env.DEVSYNC_ENV_FILE
    else process.env.DEVSYNC_ENV_FILE = previousFile
    deleteProject(p.id)
    fs.rmSync(localPath, { recursive: true, force: true })
    fs.rmSync(external, { recursive: true, force: true })
  }
})

test('relative SFTP key paths resolve from the selected project and replace password requirements', () => {
  const localPath = freshTmp()
  try {
    fs.writeFileSync(path.join(localPath, 'id_ed25519'), 'test-only-placeholder')
    fs.writeFileSync(path.join(localPath, '.env'), 'DEVSYNC_TRANSPORT=sftp\nDEVSYNC_PRIVATE_KEY=./id_ed25519')
    const r = resolveEnv(null, { localPath })
    assert.equal(r.values.DEVSYNC_PRIVATE_KEY, path.join(localPath, 'id_ed25519'))
    assert.equal(r.warnings.some((w) => w.includes('PASSWORD') || w.includes('PRIVATE_KEY')), false)
  } finally { fs.rmSync(localPath, { recursive: true, force: true }) }
})
