// test/db.test.js — db.js + projects.js integration test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Process-level HOME (config.js reads this at import time).
if (!process.env.DEVSYNC_HOME) {
  process.env.DEVSYNC_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-dbtest-'))
}
if (!fs.existsSync(process.env.DEVSYNC_HOME)) fs.mkdirSync(process.env.DEVSYNC_HOME, { recursive: true })

const { openDb, closeDb, dbPath } = await import('../src/core/db.js')

// Each test file gets a clean DB. We open then truncate the tables we own.
// (Wiping the file would re-run migrations, which would also work, but
// truncating keeps the migration code under test.)
function wipeDb() {
  const db = openDb()
  db.exec('DELETE FROM secrets')
  db.exec('DELETE FROM env_overrides')
  db.exec('DELETE FROM events')
  db.exec('DELETE FROM projects')
}
wipeDb()
const {
  listProjects,
  getProject,
  getProjectByLabel,
  createProject,
  updateProject,
  deleteProject,
  setStatus,
  setSecrets,
  getSecrets,
  hasSecrets,
  deleteSecrets,
  setEnvOverrides,
  listEnvOverrides,
  effectiveEnv,
  saveConfiguration
} = await import('../src/core/projects.js')

test('onboarding snapshots encrypt secrets and roll back failed updates', () => {
  const p = createProject({ label: 'snapshot', localPath: fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-snapshot-')) })
  const db = openDb()
  try {
    saveConfiguration(p.id, {
      DEVSYNC_TRANSPORT: 'ftp', DEVSYNC_HOST: 'original-host', DEVSYNC_PASSWORD: 'original-secret', DEVSYNC_PORT: 21
    }, { sources: { DEVSYNC_PORT: 'default' } })
    assert.equal(getSecrets(p.id).DEVSYNC_PASSWORD, 'original-secret')
    assert.equal(listEnvOverrides(p.id).find((e) => e.key === 'DEVSYNC_PASSWORD').value, null)
    assert.equal(listEnvOverrides(p.id).some((e) => e.key === 'DEVSYNC_PORT'), false)
    db.exec(`CREATE TEMP TRIGGER reject_snapshot_update BEFORE INSERT ON env_overrides WHEN NEW.project_id = ${p.id} AND NEW.key = 'DEVSYNC_HOST' BEGIN SELECT RAISE(ABORT, 'test update failure'); END`)
    assert.throws(() => saveConfiguration(p.id, { DEVSYNC_HOST: 'new-host', DEVSYNC_PASSWORD: 'new-secret' }), /test update failure/)
    assert.equal(effectiveEnv(p.id, 'ftp').values.DEVSYNC_HOST, 'original-host')
    assert.equal(getSecrets(p.id).DEVSYNC_PASSWORD, 'original-secret')
  } finally {
    db.exec('DROP TRIGGER IF EXISTS reject_snapshot_update')
    deleteProject(p.id)
    fs.rmSync(p.localPath, { recursive: true, force: true })
  }
})

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-proj-'))
const freshTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-proj-'))

test('migrations create all 5 tables', () => {
  const db = openDb()
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
  assert.deepEqual(tables, ['env_overrides', 'events', 'projects', 'schema_meta', 'secrets'])
  const v = db.prepare("SELECT value FROM schema_meta WHERE key='version'").get()
  assert.equal(v.value, '1')
  assert.match(dbPath(), /devsync\.db$/)
})

test('createProject + listProjects + getProject round-trip', () => {
  const p = createProject({ label: 'alpha', localPath: tmpDir })
  assert.equal(typeof p.id, 'number')
  assert.equal(p.label, 'alpha')
  assert.equal(p.localPath, tmpDir)
  assert.equal(p.enabled, true)

  const all = listProjects()
  assert.equal(all.length, 1)
  assert.equal(all[0].label, 'alpha')

  const byLabel = getProjectByLabel('alpha')
  assert.equal(byLabel.id, p.id)

  const byId = getProject(p.id)
  assert.equal(byId.label, 'alpha')
})

test('createProject rejects bad input', () => {
  assert.throws(() => createProject({ label: 'x' }), /localPath is required/)
  assert.throws(() => createProject({ label: 'x', localPath: 'C:\\does\\not\\exist' }), /does not exist/)
  // Make a regular file under tmpDir to test the "not a directory" branch
  const filePath = path.join(freshTmp(), 'a-file.txt')
  fs.writeFileSync(filePath, 'hi')
  assert.throws(() => createProject({ label: 'x', localPath: filePath }), /not a directory/)
})

test('createProject rejects duplicate label', () => {
  assert.throws(() => createProject({ label: 'alpha', localPath: tmpDir }), /already exists/)
})

test('secrets: encrypt/decrypt round-trip and presence flag', () => {
  const p = getProjectByLabel('alpha')
  setSecrets(p.id, { DEVSYNC_PASSWORD: 'hunter2', DEVSYNC_HOST: 'h.example.com' })
  assert.equal(hasSecrets(p.id), true)
  const got = getSecrets(p.id)
  assert.deepEqual(got, { DEVSYNC_PASSWORD: 'hunter2', DEVSYNC_HOST: 'h.example.com' })
  // overwrite
  setSecrets(p.id, { DEVSYNC_PASSWORD: 'changed' })
  assert.deepEqual(getSecrets(p.id), { DEVSYNC_PASSWORD: 'changed' })
  deleteSecrets(p.id)
  assert.equal(hasSecrets(p.id), false)
  assert.equal(getSecrets(p.id), null)
})

test('env_overrides: set, list, is_secret hiding', () => {
  const p = createProject({ label: 'envtest', localPath: freshTmp() })
  setEnvOverrides(p.id, [
    { key: 'DEVSYNC_TRANSPORT', value: 'ftp', isSecret: false },
    { key: 'DEVSYNC_PASSWORD', value: null, isSecret: true }
  ])
  const rows = listEnvOverrides(p.id)
  assert.equal(rows.length, 2)
  const transport = rows.find((r) => r.key === 'DEVSYNC_TRANSPORT')
  const pwd = rows.find((r) => r.key === 'DEVSYNC_PASSWORD')
  assert.equal(transport.value, 'ftp')
  assert.equal(transport.is_secret, 0)
  assert.equal(pwd.value, null)
  assert.equal(pwd.is_secret, 1)

  deleteProject(p.id)
})

test('effectiveEnv merges defaults + overrides + secrets with sources', () => {
  const p = createProject({ label: 'eff', localPath: freshTmp() })
  setEnvOverrides(p.id, [
    { key: 'DEVSYNC_TRANSPORT', value: 'sftp', isSecret: false },
    { key: 'DEVSYNC_REMOTE_PATH', value: '/r/eff', isSecret: false }
  ])
  setSecrets(p.id, { DEVSYNC_PASSWORD: 'p4ss' })
  const r = effectiveEnv(p.id, 'sftp')
  assert.equal(r.values.DEVSYNC_TRANSPORT, 'sftp')
  assert.equal(r.values.DEVSYNC_PORT, 22) // default for sftp
  assert.equal(r.values.DEVSYNC_REMOTE_PATH, '/r/eff')
  assert.equal(r.values.DEVSYNC_PASSWORD, 'p4ss')
  assert.equal(r.sources.DEVSYNC_TRANSPORT, 'override')
  assert.equal(r.sources.DEVSYNC_PORT, 'default')
  assert.equal(r.sources.DEVSYNC_REMOTE_PATH, 'override')
  assert.equal(r.sources.DEVSYNC_PASSWORD, 'secret')
  deleteProject(p.id)
})

test('setStatus updates last_status', () => {
  const p = createProject({ label: 'status', localPath: freshTmp() })
  setStatus(p.id, 'syncing')
  assert.equal(getProject(p.id).lastStatus, 'syncing')
  setStatus(p.id, 'error', { error: 'boom' })
  assert.equal(getProject(p.id).lastStatus, 'error')
  assert.equal(getProject(p.id).lastError, 'boom')
  setStatus(p.id, 'idle')
  assert.equal(getProject(p.id).lastError, null)
  deleteProject(p.id)
})

test('ON DELETE CASCADE removes secrets + env_overrides', () => {
  const p = createProject({ label: 'cascade', localPath: freshTmp() })
  setSecrets(p.id, { DEVSYNC_PASSWORD: 'x' })
  setEnvOverrides(p.id, [{ key: 'DEVSYNC_HOST', value: 'h', isSecret: false }])
  assert.equal(hasSecrets(p.id), true)
  assert.equal(listEnvOverrides(p.id).length, 1)
  assert.equal(deleteProject(p.id), true)
  const db = openDb()
  const secrets = db.prepare('SELECT 1 FROM secrets WHERE project_id = ?').get(p.id)
  const ovs = db.prepare('SELECT 1 FROM env_overrides WHERE project_id = ?').get(p.id)
  assert.equal(secrets, undefined)
  assert.equal(ovs, undefined)
})

test('updateProject patches fields and bumps updated_at', async () => {
  const p = createProject({ label: 'upd', localPath: freshTmp() })
  const before = p.updatedAt
  await new Promise((r) => setTimeout(r, 5))
  const updated = updateProject(p.id, { enabled: false })
  assert.equal(updated.enabled, false)
  assert.notEqual(updated.updatedAt, before)
  deleteProject(p.id)
})
