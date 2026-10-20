// Offline test: exercises the ignore matcher and plan building without a server.
// The blocklist is the control that stops secrets reaching a host, so it gets checked directly.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildMatcher } from '../src/ignore.js'
import { buildPlan, collectFiles, toRemotePath } from '../src/uploader.js'

let pass = 0
let fail = 0
const check = (name, actual, expected) => {
  const okk = actual === expected
  if (okk) pass++
  else fail++
  console.log(`  ${okk ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${name}` + (okk ? '' : `  (got ${actual}, want ${expected})`))
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-test-'))
const w = (rel, content = 'x') => {
  const p = path.join(root, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

w('index.php', '<?php echo 1;')
w('api/vouchers_api.php', '<?php')
w('admin/index.php', '<?php')
w('.env', 'SECRET=hunter2')
w('.env.production', 'SECRET=prod')
w('server.pem', '-----BEGIN PRIVATE KEY-----')
w('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----')
w('node_modules/express/index.js', 'module.exports={}')
w('.git/config', '[core]')
w('backup.sql', 'DROP TABLE users;')
w('debug.log', 'noise')
w('.editorconfig', 'root=true')

const m = buildMatcher(root, { useGitignore: false })

console.log('\nHARD BLOCKLIST — must all be refused')
check('.env blocked', m.reason('.env'), 'blocklist')
check('.env.production blocked', m.reason('.env.production'), 'blocklist')
check('server.pem blocked', m.reason('server.pem'), 'blocklist')
check('id_rsa blocked', m.reason('id_rsa'), 'blocklist')
check('.git/config blocked', m.reason('.git/config'), 'blocklist')
check('node_modules/... blocked', m.reason('node_modules/express/index.js'), 'blocklist')

console.log('\nDEPLOYIGNORE — must be honoured')
check('backup.sql skipped', m.reason('backup.sql'), '.deployignore')
check('debug.log skipped', m.reason('debug.log'), '.deployignore')

console.log('\nREAL APP FILES — must all pass through')
check('index.php allowed', m.reason('index.php'), null)
check('api/vouchers_api.php allowed', m.reason('api/vouchers_api.php'), null)
check('admin/index.php allowed', m.reason('admin/index.php'), null)
check('.editorconfig allowed', m.reason('.editorconfig'), null)

console.log('\nWATCHER GATING — chokidar must not descend into excluded dirs')
check('watch node_modules', m.shouldWatch(path.join(root, 'node_modules')), false)
check('watch .git', m.shouldWatch(path.join(root, '.git')), false)
check('watch api', m.shouldWatch(path.join(root, 'api')), true)
check('watch root', m.shouldWatch(root), true)

const files = collectFiles(root, m)
const rels = files.map((f) => path.relative(root, f).split(path.sep).join('/')).sort()
console.log('\nUPLOAD SET')
console.log('  ' + rels.join('\n  '))
check('exactly 4 files eligible', rels.length, 4)
check('no .env in set', rels.includes('.env'), false)
check('no node_modules in set', rels.some((r) => r.includes('node_modules')), false)

console.log('\nPATH MAPPING')
check(
  'windows -> remote',
  toRemotePath(root, '/public_html/app', path.join(root, 'api', 'vouchers_api.php')),
  '/public_html/app/api/vouchers_api.php'
)
check(
  'no remote root',
  toRemotePath(root, '', path.join(root, 'index.php')),
  '/index.php'
)
check('trailing slash trimmed', toRemotePath(root, '/a/b/', path.join(root, 'index.php')), '/a/b/index.php')

console.log('\nPLAN vs remote — unchanged files should be skipped')
const indexSize = fs.statSync(path.join(root, 'index.php')).size
const fakeTransport = {
  stat: async (p) => (p.endsWith('index.php') ? { size: indexSize, isDir: false } : null)
}
const project = { localPath: root, remotePath: '/public_html/app' }
const plan = await buildPlan(project, m, fakeTransport, {})
check('3 files planned', plan.uploads.length, 3)
check('1 skipped as unchanged', plan.skipped.length, 1)

fs.rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)