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
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const projectsUrl = new URL('../src/core/projects.js', import.meta.url).href

test('bare CLI onboards .env without questions; deploy uploads all and saved projects work elsewhere', async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-cli-onboard-'))
  const local = path.join(temp, 'my-site')
  fs.mkdirSync(local)
  const srv = await startFtpFixture()
  t.after(async () => { await srv.stop(); fs.rmSync(temp, { recursive: true, force: true }) })
  const env = { ...process.env, DEVSYNC_HOME: path.join(temp, 'home'), DEVSYNC_ENV_FILE: '' }
  const run = (cwd, ...args) => exec(process.execPath, [cli, ...args], { env, cwd, timeout: 20000 })
  const inspect = () => exec(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(projectsUrl)}); const p = m.getProjectByLabel('my-site'); console.log(JSON.stringify({project:p, entries:m.listEnvOverrides(p.id), values:m.effectiveEnv(p.id,'ftp').values}));`], { env, cwd: temp })
  const text = [
    'DEVSYNC_TRANSPORT=ftp', `DEVSYNC_HOST=${srv.host}`, `DEVSYNC_PORT=${srv.port}`,
    `DEVSYNC_USERNAME=${srv.username}`, `DEVSYNC_PASSWORD="${srv.password}"`,
    'DEVSYNC_REMOTE_PATH=/public_html/site', 'APP_SECRET=not-for-devsync'
  ].join('\n')
  fs.writeFileSync(path.join(local, '.env'), text)
  fs.writeFileSync(path.join(local, 'index.html'), 'hello')
  const initial = await run(local)
  assert.match(initial.stdout, /Connection test passed/)
  assert.match(initial.stdout, /Plan for/)
  assert.match(initial.stdout, /saved "my-site"/)
  assert.equal(initial.stdout.includes('not-for-devsync'), false)
  assert.equal(initial.stdout.includes(`DEVSYNC_PASSWORD=${srv.password}`), false)
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html')), false, 'onboarding only previews')
  assert.equal(fs.readFileSync(path.join(local, '.env'), 'utf8'), text)
  const saved = JSON.parse((await inspect()).stdout)
  assert.equal(saved.values.DEVSYNC_PASSWORD, srv.password)
  assert.equal(saved.values.APP_SECRET, undefined)
  assert.equal(saved.entries.find((e) => e.key === 'DEVSYNC_PASSWORD').value, null)
  assert.equal(saved.entries.find((e) => e.key === 'DEVSYNC_PASSWORD').is_secret, 1)
  await run(temp, 'deploy', 'my-site', '--dry-run')
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html')), false)
  await run(temp, 'deploy', 'my-site')
  const deployed = path.join(srv.rootDir, 'public_html/site/index.html')
  assert.equal(fs.readFileSync(deployed, 'utf8'), 'hello')
  assert.equal(fs.existsSync(path.join(srv.rootDir, 'public_html/site/.env')), false)
  assert.match((await run(temp, 'sync', 'my-site')).stdout, /already up to date/)
  assert.match((await run(temp, 'deploy', 'my-site')).stdout, /uploaded 1 file/)
  // Removing the local .env leaves a usable encrypted setup snapshot for both controls.
  fs.renameSync(path.join(local, '.env'), path.join(local, '.env.saved'))
  fs.writeFileSync(path.join(temp, '.env'), 'DEVSYNC_HOST=wrong.invalid')
  const existing = await run(temp, 'setup', 'my-site')
  assert.match(existing.stdout, /Connection test passed/)
  await run(temp, 'deploy', 'my-site', '--remote-path', '/another-site')
  assert.equal(fs.readFileSync(path.join(srv.rootDir, 'another-site/index.html'), 'utf8'), 'hello')
  assert.equal(JSON.parse((await inspect()).stdout).values.DEVSYNC_REMOTE_PATH, '/public_html/site', 'ordinary command overrides are not saved')
  const badLocal = path.join(temp, 'bad-auth')
  fs.mkdirSync(badLocal)
  fs.writeFileSync(path.join(badLocal, '.env'), text.replace(`DEVSYNC_PASSWORD="${srv.password}"`, 'DEVSYNC_PASSWORD="incorrect-test-password"'))
  await assert.rejects(run(badLocal, 'setup'), (err) => err.code === 1 && !err.killed && /Setup could not complete/.test(err.stderr))
  assert.equal((await run(temp, 'projects')).stdout.includes('bad-auth'), false, 'failed connection creates no project')
})

test('incomplete noninteractive onboarding exits promptly and leaves no project registration', async (t) => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-cli-incomplete-'))
  t.after(() => fs.rmSync(local, { recursive: true, force: true }))
  const env = { ...process.env, DEVSYNC_HOME: path.join(local, '.devsync'), DEVSYNC_ENV_FILE: '' }
  fs.writeFileSync(path.join(local, '.env'), 'DEVSYNC_HOST=ftp.example.com')
  await assert.rejects(exec(process.execPath, [cli], { cwd: local, env, timeout: 10000 }), /DEVSYNC_TRANSPORT.*DEVSYNC_USERNAME.*DEVSYNC_PASSWORD.*DEVSYNC_REMOTE_PATH/)
  const listed = await exec(process.execPath, [cli, 'projects'], { cwd: local, env })
  assert.match(listed.stdout, /No projects yet/)
})
