import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { startFtpFixture } from './fixtures/ftp.js'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const cli = path.join(repo, 'src', 'cli.js')
const projectsUrl = new URL('../src/core/projects.js', import.meta.url).href

test('CLI saves destination and deploys same-size edits into that folder from another cwd', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-cli-'))
  const local = path.join(temp, 'local')
  fs.mkdirSync(local)
  const env = { ...process.env, DEVSYNC_HOME: path.join(temp, 'home'), DEVSYNC_ENV_FILE: '' }
  const run = (...args) => exec(process.execPath, [cli, ...args], { cwd: temp, env, timeout: 20000 })
  const seed = (script) => exec(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(projectsUrl)}); ${script}`], { env, cwd: temp })
  const srv = await startFtpFixture()
  t.after(async () => { await srv.stop(); fs.rmSync(temp, { recursive: true, force: true }) })
  fs.writeFileSync(path.join(local, 'index.html'), 'old!')
  fs.writeFileSync(path.join(srv.rootDir, 'keep.txt'), 'server-only')
  await run('add', 'site', local, '/public_html/site')
  // The launch folder must not override the selected project's connection/path.
  fs.writeFileSync(path.join(temp, '.devsync.env'), 'DEVSYNC_REMOTE_PATH=/wrong\nDEVSYNC_HOST=wrong.invalid')
  fs.writeFileSync(path.join(local, '.devsync.env'), [
    'DEVSYNC_TRANSPORT=ftp', `DEVSYNC_HOST=${srv.host}`, `DEVSYNC_PORT=${srv.port}`,
    `DEVSYNC_USERNAME=${srv.username}`, `DEVSYNC_PASSWORD=${srv.password}`
  ].join('\n'))
  const preview = await run('plan', 'site')
  assert.match(preview.stdout, /\/public_html\/site\/index.html/)
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html')), false)
  await run('sync', 'site', '--dry-run')
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html')), false)
  await run('sync', 'site')
  const deployed = path.join(srv.rootDir, 'public_html', 'site', 'index.html')
  assert.equal(fs.readFileSync(deployed, 'utf8'), 'old!')
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'index.html')), false)
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html/site/.devsync.env')), false)
  fs.writeFileSync(path.join(local, 'index.html'), 'new!')
  await run('sync', 'site')
  assert.equal(fs.readFileSync(deployed, 'utf8'), 'new!')
  assert.match((await run('sync', 'site')).stdout, /already up to date/)
  assert.equal(fs.readFileSync(path.join(srv.rootDir, 'keep.txt'), 'utf8'), 'server-only')
  // A parent occupied by a file must produce a nonzero exit and saved error.
  fs.writeFileSync(path.join(srv.rootDir, 'blocked'), 'file')
  await seed("const p = m.getProjectByLabel('site'); m.setEnvOverrides(p.id, [{key:'DEVSYNC_REMOTE_PATH',value:'/blocked/site',isSecret:false}]);")
  await assert.rejects(run('sync', 'site'), (err) => err.code === 1 && /failed/.test(err.stdout))
  const state = await seed("console.log(JSON.stringify(m.getProjectByLabel('site')))")
  const saved = JSON.parse(state.stdout)
  assert.equal(saved.lastStatus, 'error')
  assert.ok(saved.lastError)
  await seed("const p = m.getProjectByLabel('site'); m.setEnvOverrides(p.id, []);")
  await assert.rejects(run('sync', 'site'), /DEVSYNC_REMOTE_PATH/)
})
