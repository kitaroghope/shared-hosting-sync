#!/usr/bin/env node
// devsync v2 CLI.
//
// Bare invocation (`devsync` with no command) is the nodemon-style flow:
//   - canonicalise cwd
//   - look up project by local_path in the DB
//   - found → run a plan+sync immediately (same as `devsync sync <label>`)
//   - not found → fail with one-liner + suggest `devsync ui`
//
// All commands use the v2 DB (core/db.js) as source of truth. v1's
// ~/.devsync/config.json + .env are imported on first open by v1Migrate.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createTransport } from './transport/index.js'
import { buildMatcher, ensureDeployignore } from './ignore.js'
import { buildPlan, runPlan } from './uploader.js'
import { ProjectWatcher } from './watcher.js'
import { openDb } from './core/db.js'
import { maybeRunV1Import } from './core/v1Migrate.js'
import {
  listProjects,
  getProjectByLabel,
  getProjectByLocalPath,
  createProject,
  deleteProject,
  updateProject,
  setStatus,
  effectiveEnv,
  hasSecrets
} from './core/projects.js'
import { resolveEnv, credsFromResolved } from './core/envResolver.js'
import { startServer } from './server/index.js'
import { HOME } from './config.js'

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`
}

const argv = process.argv.slice(2)
const cmd = argv[0]
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, v] = a.replace(/^--/, '').split('=')
      return [k, v ?? true]
    })
)
const positional = argv.slice(1).filter((a) => !a.startsWith('--'))

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'

function die(msg, code = 1) {
  console.error(C.r('✗ ') + msg)
  process.exit(code)
}
function ok(msg) { console.log(C.g('✓ ') + msg) }
function info(msg) { console.log(C.c('· ') + msg) }
function warn(msg) { console.log(C.y('! ') + msg) }

function openAndMigrate() {
  const db = openDb()
  const mig = maybeRunV1Import()
  if (mig.imported) {
    info(`imported ${mig.projects.length} project(s) from v1 ~/.devsync/config.json`)
    info(`v1 files left in place; remove them manually when ready`)
  }
  return db
}

function resolveProjectOrCwd(label) {
  if (label) {
    const p = getProjectByLabel(label)
    if (!p) die(`no project named "${label}" — run \`devsync projects\``)
    return p
  }
  // Bare invocation: try cwd
  const cwd = fs.realpathSync(process.cwd())
  const byPath = getProjectByLocalPath(cwd)
  if (byPath) return byPath
  die(
    `no project registered for ${cwd}\n` +
    `  run \`devsync ui\` to add it via the web UI\n` +
    `  or  \`devsync add <label> <localPath> <remotePath>\``
  )
}

async function credsForProject(project) {
  const transport = (effectiveEnv(project.id, 'sftp').values.DEVSYNC_TRANSPORT || 'sftp')
  const r = resolveEnv(project.id, { transport })
  if (r.warnings.length) {
    for (const w of r.warnings) warn(w)
  }
  // Required-key gate: refuse to dial if creds are missing.
  const need = ['DEVSYNC_HOST', 'DEVSYNC_USERNAME']
  const missing = need.filter((k) => !r.values[k])
  if (missing.length || !hasSecrets(project.id) && !r.values.DEVSYNC_PASSWORD) {
    die(
      `creds not set for "${project.label}" (missing ${missing.join(', ') || 'password'})\n` +
      `  run \`devsync ui\` to enter them`
    )
  }
  return credsFromResolved(r.values)
}

/* ------------------------------------------------------------------ */

const COMMANDS = {
  async init() {
    openAndMigrate()
    ok('v2 ready')
    info('next: devsync ui   (open the web UI to add your first project)')
    info('  or: devsync add <label> <localPath> <remotePath>')
  },

  async add() {
    openAndMigrate()
    const [label, localArg, remoteArg] = positional
    if (!label || !localArg) die('usage: devsync add <label> <localPath> [remotePath]')
    const localPath = path.resolve(localArg)
    if (!fs.existsSync(localPath)) die(`local path does not exist: ${localPath}`)
    if (!fs.statSync(localPath).isDirectory()) die(`local path is not a directory: ${localPath}`)

    const proj = createProject({ label, localPath })
    ensureDeployignore(localPath)
    info(`added "${label}" — ${localPath}`)
    info(`next: open \`devsync ui\` to set host/credentials/remote path`)
    if (remoteArg) info(`(you can also pass remotePath via the UI)`)
    void proj
  },

  remove() {
    openAndMigrate()
    const [label] = positional
    if (!label) die('usage: devsync remove <label>')
    const p = getProjectByLabel(label)
    if (!p) die(`no such project: ${label}`)
    deleteProject(p.id)
    ok(`removed "${label}"`)
  },

  projects() {
    openAndMigrate()
    const all = listProjects()
    if (!all.length) {
      info('No projects yet. Add one:')
      console.log(`  ${C.c('devsync add myapp C:\\path\\to\\app /public_html/myapp')}`)
      console.log(`  ${C.c('devsync ui')}     (web form — recommended)`)
      return
    }
    console.log(C.b('Projects') + C.dim(`  (${all.length})`))
    for (const p of all) {
      const e = effectiveEnv(p.id, 'sftp').values
      console.log(
        `  ${C.b(p.label.padEnd(14))} ${p.localPath}\n` +
        `  ${' '.repeat(14)} ${C.dim('→')} ${e.DEVSYNC_REMOTE_PATH || '/'}  ${C.dim('[' + (e.DEVSYNC_TRANSPORT || 'sftp') + ']')}  ${p.lastStatus === 'error' ? C.r(p.lastStatus) : C.dim(p.lastStatus)}`
      )
    }
    console.log()
    console.log(C.dim(`stored in ${path.join(process.env.DEVSYNC_HOME || os.homedir(), '.devsync', 'devsync.db')}`))
  },

  async test() {
    openAndMigrate()
    const proj = resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    info(`connecting ${creds.transport}://${creds.username}@${creds.host}:${creds.port}`)
    let t
    try {
      t = await createTransport(creds, flags.transport)
    } catch (e) {
      die(`connection failed: ${e.message}`)
    }
    ok('connected')
    try {
      const entries = await t.list(flags.path || '/')
      info(`${entries.length} entries in ${flags.path || '/'}`)
      for (const e of entries.slice(0, 20)) {
        console.log(`    ${e.type === 'dir' ? C.c('dir ') : '    '} ${e.name}`)
      }
      if (entries.length > 20) console.log(C.dim(`    … ${entries.length - 20} more`))
    } finally {
      await t.close()
    }
  },

  async ls() {
    openAndMigrate()
    const proj = resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    const t = await createTransport(creds, flags.transport).catch((e) => die(e.message))
    const entries = await t.list(positional[1] || '/')
    for (const e of entries) {
      console.log(`  ${e.type === 'dir' ? C.c('dir ') : '    '} ${e.name}`)
    }
    await t.close()
  },

  async plan() {
    openAndMigrate()
    const proj = resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    const t = await createTransport(creds, flags.transport).catch((e) => die(e.message))
    try {
      const p = await buildPlan(proj, matcher, t, { force: !!flags.force })
      console.log()
      console.log(C.b(`Plan for "${proj.label}"`) + C.dim(`  ${proj.localPath} → ${effectiveEnv(proj.id, creds.transport).values.DEVSYNC_REMOTE_PATH || '/'}`))
      console.log(
        C.dim(
          `  ${p.totalFiles} file(s) considered · ${p.uploads.length} to upload · ${p.skipped.length} unchanged · ${mb(p.comparedBytes)} outbound`
        )
      )
      const blocked = matcher.blockedSample()
      if (blocked.length) {
        console.log()
        warn(`blocked by hard policy (never uploadable): ${blocked.join(', ')}${blocked.length >= 20 ? ' …' : ''}`)
      }
      if (p.uploads.length) {
        console.log()
        for (const u of p.uploads.slice(0, 40)) {
          console.log(`  ${C.g('+')} ${u.rel} ${C.dim('(' + kb(u.bytes) + ' → ' + u.remote + ')')}`)
        }
        if (p.uploads.length > 40) console.log(C.dim(`  … ${p.uploads.length - 40} more`))
      }
      console.log()
      console.log(C.dim(`  run:  devsync sync ${proj.label}     (apply)`))
      console.log(C.dim(`  watch: devsync watch ${proj.label}    (continuous)`))
    } finally {
      await t.close()
    }
  },

  async sync() {
    openAndMigrate()
    const proj = resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    const t = await createTransport(creds, flags.transport).catch((e) => die(e.message))
    setStatus(proj.id, 'syncing')

    let dryRun = !!flags['dry-run'] || !!flags.plan

    try {
      const p = await buildPlan(proj, matcher, t, { force: !!flags.force })
      console.log()
      console.log(C.b(`Sync "${proj.label}"`) + C.dim(`  ${p.uploads.length} file(s) · ${mb(p.comparedBytes)}`))
      if (dryRun) {
        console.log(C.y('  dry run — nothing was uploaded'))
        for (const u of p.uploads.slice(0, 40)) console.log(`  ${C.g('+')} ${u.rel}`)
        setStatus(proj.id, 'idle')
        return
      }
      if (!p.uploads.length) {
        ok('nothing to upload — already up to date')
        setStatus(proj.id, 'idle')
        return
      }
      let lastPct = -1
      const r = await runPlan(p, t, {
        dryRun,
        onProgress: ({ index, total, item }) => {
          const pct = Math.floor(((index + 1) / total) * 100)
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct
            process.stdout.write(C.dim(`  ${pct}%  ${item.rel}\n`))
          }
        }
      })
      ok(`uploaded ${r.done.length} file(s), ${mb(r.bytes)}`)
      setStatus(proj.id, 'idle', { error: null })
      if (r.failed.length) {
        warn(`${r.failed.length} failed`)
        for (const f of r.failed) console.log(`  ${C.r('✗')} ${f.rel} — ${f.error}`)
        process.exitCode = 1
      }
    } catch (e) {
      setStatus(proj.id, 'error', { error: e.message })
      throw e
    } finally {
      await t.close()
    }
  },

  async watch() {
    openAndMigrate()
    const proj = resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    ensureDeployignore(proj.localPath)
    const t = await createTransport(creds, flags.transport).catch((e) => die(e.message))
    setStatus(proj.id, 'watching')

    console.log()
    console.log(C.b(`Watching "${proj.label}"`))
    console.log(C.dim(`  ${proj.localPath} → ${effectiveEnv(proj.id, creds.transport).values.DEVSYNC_REMOTE_PATH || '/'}  (${creds.transport})`))
    console.log(C.dim('  Ctrl+C to stop\n'))

    const w = new ProjectWatcher(proj, matcher, t, {
      dryRun: !!flags['dry-run'],
      onEvent: (e) => {
        if (e.type === 'error') console.log(C.r('  ✗ ') + e.message)
        else if (e.type === 'change') console.log(C.dim(`  ~ ${e.kind} ${e.file}`))
      },
      onSettle: (s) => {
        if (s.uploaded) {
          console.log(C.g(`  ↑ ${s.uploaded} file(s), ${kb(s.bytes)}`) + C.dim(`  (${s.considered} scanned, ${s.skipped} unchanged)`))
        }
        for (const f of s.failed) console.log(C.r(`  ✗ ${f.rel} — ${f.error}`))
      }
    })
    w.start()

    const shutdown = async () => {
      console.log(C.dim('\nstopping…'))
      await w.stop()
      await t.close()
      setStatus(proj.id, 'idle')
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  },

  async ui() {
    openAndMigrate()
    const port = flags.port || 5180
    const { url } = await startServer({ port: Number(port), openBrowser: flags.browser !== false })
    console.log()
    console.log(C.b('devsync UI'))
    console.log(`  ${C.c(url)}`)
    console.log()
    console.log(C.dim('  loopback only — session token required for mutations'))
    console.log(C.dim('  Ctrl+C to stop'))
  },

  doctor() {
    openAndMigrate()
    const all = listProjects()
    console.log(C.b('devsync doctor') + '\n')
    console.log(`  node            ${process.version}`)
    console.log(`  home            ${HOME}`)
    console.log(`  db              ${fs.existsSync(path.join(HOME, 'devsync.db')) ? C.g('present') : C.y('missing')}  ${path.join(HOME, 'devsync.db')}`)
    console.log(`  master.key      ${fs.existsSync(path.join(HOME, 'master.key')) ? C.g('present') : C.y('missing')}`)
    console.log(`  projects        ${all.length}`)
    console.log()
    console.log(C.b('projects:'))
    for (const p of all) {
      const exists = fs.existsSync(p.localPath)
      const ig = fs.existsSync(path.join(p.localPath, '.deployignore'))
      const hasS = hasSecrets(p.id)
      console.log(
        `  ${exists ? C.g('✓') : C.r('✗')} ${p.label.padEnd(14)} local=${exists ? 'ok' : C.r('missing')}  deployignore=${ig ? 'ok' : C.y('none')}  creds=${hasS ? C.g('set') : C.y('none')}`
      )
    }
  },

  help() {
    console.log(`
${C.b('devsync')} — global local-dev → hosting sync (v2)

${C.b('first-time setup')}
  devsync ui                          open the web UI (recommended)
  devsync add <label> <localPath>      register a project (creds via UI)
  devsync projects                     list registered projects

${C.b('bare invocation')}
  cd <project> && devsync              plan + sync the cwd's project

${C.b('per-project')}
  devsync test [label]                 check connectivity
  devsync ls [label] [remotePath]      browse the remote
  devsync plan [label]                 preview, no upload
  devsync sync [label]                 one-shot upload
  devsync watch [label]                continuous, debounced

${C.b('other')}
  devsync remove <label>
  devsync doctor                       health check
  devsync help
`)
  }
}

// Bare invocation: try to resolve the cwd's project; if none, fail with a
// one-liner pointing at `devsync ui`. Otherwise behave like `devsync plan`
// (dry-run by default; pass --sync to actually upload).
if (!cmd) {
  Promise.resolve()
    .then(async () => {
      openAndMigrate()
      const proj = resolveProjectOrCwd()
      if (flags.sync) {
        return COMMANDS.sync()
      }
      return COMMANDS.plan()
    })
    .catch((e) => {
      console.error(C.r('\n✗ ') + (e && e.message ? e.message : String(e)))
      process.exit(1)
    })
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
  COMMANDS.help()
} else if (COMMANDS[cmd]) {
  Promise.resolve()
    .then(() => COMMANDS[cmd]())
    .catch((e) => {
      console.error(C.r('\n✗ ') + (e && e.message ? e.message : String(e)))
      process.exit(1)
    })
} else {
  die(`unknown command: ${cmd}\n  run \`devsync help\``)
}