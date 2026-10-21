import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { startFtpFixture } from '../test/fixtures/ftp.js'

const exec = promisify(execFile)
const repo = fileURLToPath(new URL('../', import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run this check with npm run release:check')
const artifacts = path.join(repo, 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-hosting-sync-release-'))
const env = { ...process.env, DEVSYNC_HOME: path.join(temp, 'settings') }
const options = { cwd: temp, env, maxBuffer: 16 * 1024 * 1024 }
let ftp, ui

async function run(file, args, extra = {}) {
  try {
    const { stream = false, ...settings } = extra
    const task = exec(file, args, { ...options, ...settings })
    if (stream) {
      task.child.stdout.on('data', (data) => process.stdout.write(data))
      task.child.stderr.on('data', (data) => process.stderr.write(data))
    }
    return await task
  }
  catch (error) { console.error(error.stdout || '', error.stderr || ''); throw error }
}

try {
  console.log('Packing the release; prepack runs the complete test suite…')
  const packed = await run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', artifacts], { cwd: repo, stream: true })
  const jsonStart = packed.stdout.lastIndexOf('\n[') + 1
  const [manifest] = JSON.parse(packed.stdout.slice(jsonStart))
  assert.equal(manifest.name, pkg.name)
  const files = manifest.files.map((entry) => entry.path)
  for (const required of ['src/bin.js', 'src/cli.js', 'src/ui/index.html', 'src/ui/deployments.js', 'src/core/migrations/001_init.sql', 'src/core/migrations/002_operation_locks.sql', '.env.example', 'LICENSE', 'README.md', 'CHANGELOG.md']) assert.ok(files.includes(required), `Missing ${required}`)
  for (const file of files) {
    assert.ok(file.startsWith('src/') || ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'RELEASING.md', 'PHASES.md', 'PRODUCT.md', '.env.example'].includes(file), `Unexpected packaged file: ${file}`)
    assert.ok(!/\.(pem|key|db|log)$|(^|\/)\.env$|master\.key|session\.token/.test(file), `Sensitive file in package: ${file}`)
  }
  const archive = path.join(artifacts, manifest.filename)
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
  fs.writeFileSync(path.join(artifacts, 'SHA256SUMS'), `${checksum}  ${manifest.filename}\n`)
  fs.writeFileSync(path.join(artifacts, 'release.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Package audited: ${files.length} files, ${(manifest.size / 1024).toFixed(1)} KB compressed.`)

  const prefix = path.join(temp, 'global install')
  await run(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--omit=dev', '--no-audit', '--no-fund', archive])
  const installed = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', pkg.name)
  const entry = path.join(installed, 'src/bin.js')
  const cli = async (...args) => (await run(process.execPath, [entry, ...args])).stdout
  assert.equal((await cli('--version')).trim(), `${pkg.name} ${pkg.version}`)
  assert.match(await cli('help'), /shared-hosting-sync/)
  assert.match(await cli('doctor'), /master.key|master\.key/)
  for (const command of ['shared-hosting-sync', 'devsync']) {
    const shim = path.join(prefix, ...(process.platform === 'win32' ? [] : ['bin']), command + (process.platform === 'win32' ? '.cmd' : ''))
    const result = process.platform === 'win32'
      ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${shim}" --version"`], { windowsVerbatimArguments: true })
      : await run(shim, ['--version'])
    assert.equal(result.stdout.trim(), `${pkg.name} ${pkg.version}`)
  }

  ftp = await startFtpFixture()
  const source = path.join(temp, 'site'); fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'index.html'), 'old!')
  fs.writeFileSync(path.join(source, '.env'), `DEVSYNC_TRANSPORT=ftp\nDEVSYNC_HOST=${ftp.host}\nDEVSYNC_PORT=${ftp.port}\nDEVSYNC_USERNAME=${ftp.username}\nDEVSYNC_PASSWORD=${ftp.password}\nDEVSYNC_REMOTE_PATH=/public_html/site\n`)
  await run(process.execPath, [entry], { cwd: source })
  const remote = path.join(ftp.rootDir, 'public_html/site/index.html')
  assert.equal(fs.existsSync(remote), false, 'Onboarding only previews')
  await cli('deploy', 'site')
  assert.equal(fs.readFileSync(remote, 'utf8'), 'old!')
  fs.writeFileSync(path.join(source, 'index.html'), 'new!')
  await cli('sync', 'site')
  assert.equal(fs.readFileSync(remote, 'utf8'), 'new!')
  assert.equal(fs.existsSync(path.join(ftp.rootDir, 'public_html/site/.env')), false)

  ui = spawn(process.execPath, [entry, 'ui', '--port', '0', '--browser=false'], options)
  let output = ''
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Packaged dashboard startup timed out')), 15000)
    ui.once('error', (error) => { clearTimeout(timer); reject(error) })
    ui.once('exit', () => { clearTimeout(timer); reject(new Error('Packaged dashboard exited before startup')) })
    ui.stdout.on('data', (data) => {
      output += data
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    })
  })
  const health = await (await fetch(new URL('api/health', url))).json()
  assert.deepEqual(health, { ok: true, name: pkg.name, version: pkg.version })
  for (const asset of ['', 'ui.js', 'deployments.js', 'style.css']) assert.equal((await fetch(new URL(asset, url))).status, 200)
  const session = await (await fetch(new URL('api/session', url))).json()
  const projects = await (await fetch(new URL('api/projects', url), { headers: { 'x-devsync-session': session.token } })).json()
  assert.equal(projects.projects[0].label, 'site')
  console.log('Installed package passed both command aliases, onboarding, real FTP deploy/sync, and dashboard checks from another directory.')
  console.log(`Release candidate: ${archive}\nSHA-256: ${checksum}`)
} finally {
  if (ui && ui.exitCode === null && ui.signalCode === null) { const exited = once(ui, 'exit'); ui.kill(); await exited }
  if (ftp) await ftp.stop()
  fs.rmSync(temp, { recursive: true, force: true })
}
