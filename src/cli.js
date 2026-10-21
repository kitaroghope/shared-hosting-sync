#!/usr/bin/env node
// devsync v2 CLI.
//
// Bare invocation (`devsync` with no command) is the nodemon-style flow:
//   - canonicalise cwd
//   - look up project by local_path in the DB
//   - found → preview the upload plan without uploading
//   - not found → onboard from project .env plus prompts, then preview
//
// All commands use the v2 DB (core/db.js) as source of truth. v1's
// ~/.devsync/config.json + .env are imported on first open by v1Migrate.

import fs from 'node:fs'
import path from 'node:path'
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
  setEnvOverrides,
  saveConfiguration,
  setStatus,
  recordSync,
  hasSecrets
} from './core/projects.js'
import { resolveEnv, credsFromResolved, settingError } from './core/envResolver.js'
import { ENV_SCHEMA } from './core/envSchema.js'
import { resolveDeployment } from './core/deployment.js'
import { acquireOperation, assertProjectIdle, mutateProject } from './core/operationLock.js'
import { startServer } from './server/index.js'
import { HOME } from './config.js'
import { validateRemotePath } from './paths.js'
import { prepareConfiguration, assertLocalFolder } from './onboarding.js'
import { createPrompter } from './prompt.js'
import { parseArgs } from './arguments.js'
import { name, version } from './metadata.js'

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`
}

let cmd, flags, positional
try {
  const parsed = parseArgs(process.argv.slice(2))
  cmd = parsed.command
  flags = parsed.flags
  positional = parsed.positional
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
const sessionOverrides = new Map()
const prompt = createPrompter()
const flagOverrides = () => Object.fromEntries([
  ['transport', 'DEVSYNC_TRANSPORT'], ['host', 'DEVSYNC_HOST'],
  ['username', 'DEVSYNC_USERNAME'], ['port', 'DEVSYNC_PORT'], ['remote-path', 'DEVSYNC_REMOTE_PATH']
].filter(([flag]) => flags[flag] !== undefined).map(([flag, key]) => [key, flags[flag]]))

const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'

function die(msg, code = 1) {
  console.error(C.r('✗ ') + msg)
  process.exit(code)
}
function ok(msg) { console.log(C.g('✓ ') + msg) }
function info(msg) { console.log(C.c('· ') + msg) }
function warn(msg) { console.log(C.y('! ') + msg) }
function retryNotice({ attempt, retries }) { warn(`Connection interrupted; reconnecting (${attempt}/${retries})`) }

function openAndMigrate() {
  const db = openDb()
  const mig = maybeRunV1Import()
  if (mig.imported) {
    info(`imported ${mig.projects.length} project(s) from v1 ~/.devsync/config.json`)
    info(`v1 files left in place; remove them manually when ready`)
  }
  return db
}

async function setupProject(project) {
  if (project) assertProjectIdle(project.id)
  const localPath = assertLocalFolder(project?.localPath || process.cwd())
  const resolved = resolveEnv(project?.id, { localPath, envFile: flags['env-file'], overrides: flagOverrides() })
  const prepared = await prepareConfiguration(resolved, {
    localPath,
    ask: prompt.interactive ? (question) => prompt.ask(question) : undefined,
    log: info, edit: !!flags.edit, browse: !!flags.browse
  })
  await prompt.close()
  const created = !project
  if (!project) {
    const base = flags.label || path.basename(localPath) || 'project'
    let label = base
    let suffix = 2
    while (getProjectByLabel(label)) label = `${base}-${suffix++}`
    project = createProject({ label, localPath })
  }
  try {
    mutateProject(project.id, () => saveConfiguration(project.id, prepared.values, { sources: prepared.sources }))
    ensureDeployignore(localPath)
  } catch (err) {
    if (created) deleteProject(project.id)
    throw err
  }
  sessionOverrides.set(project.id, Object.fromEntries(Object.entries(prepared.values)
    .filter(([key]) => prepared.sources[key] === 'prompt')))
  ok(`saved "${project.label}" — ${localPath} → ${prepared.values.DEVSYNC_REMOTE_PATH}`)
  return project
}

async function resolveProjectOrCwd(label) {
  if (label) {
    const project = getProjectByLabel(label)
    if (!project) throw new Error(`no project named "${label}" — run devsync projects`)
    return project
  }
  const cwd = fs.realpathSync(process.cwd())
  return getProjectByLocalPath(cwd) || setupProject(null)
}

async function credsForProject(project, { deployment = false } = {}) {
  if (deployment) {
    const context = resolveDeployment(project, {
      envFile: flags['env-file'], overrides: { ...flagOverrides(), ...sessionOverrides.get(project.id) }
    })
    project.remotePath = context.project.remotePath
    return { ...context.creds, dryRun: context.dryRun, debounceMs: context.debounceMs }
  }
  const r = resolveEnv(project.id, {
    envFile: flags['env-file'], overrides: { ...flagOverrides(), ...sessionOverrides.get(project.id) }
  })
  const errors = ENV_SCHEMA.filter((s) => s.key !== 'DEVSYNC_REMOTE_PATH')
    .map((s) => settingError(s.key, r.values[s.key], r.values)).filter(Boolean)
  if (errors.length) throw new Error(`${errors.join('; ')}. Update the project .env or run devsync setup ${project.label}.`)
  return {
    ...credsFromResolved(r.values),
    dryRun: ['true', '1', true].includes(r.values.DEVSYNC_DRY_RUN),
    debounceMs: Number(r.values.DEVSYNC_DEBOUNCE_MS)
  }
}

/* ------------------------------------------------------------------ */

const COMMANDS = {
  async init() {
    openAndMigrate()
    ok('v2 ready')
    info('next: devsync setup   (configure the current folder in the terminal)')
    info('  or: cd <project> && devsync')
  },

  async setup() {
    openAndMigrate()
    const project = positional[0] ? getProjectByLabel(positional[0]) : getProjectByLocalPath(fs.realpathSync(process.cwd()))
    if (positional[0] && !project) throw new Error(`no project named "${positional[0]}"`)
    const saved = await setupProject(project)
    await prompt.close()
    return COMMANDS.plan(saved)
  },

  async deploy() {
    return COMMANDS.sync(undefined, { force: true })
  },

  async add() {
    openAndMigrate()
    const [label, localArg, remoteArg] = positional
    if (!label || !localArg) die('usage: devsync add <label> <localPath> [remotePath]')
    const localPath = path.resolve(localArg)
    if (!fs.existsSync(localPath)) die(`local path does not exist: ${localPath}`)
    if (!fs.statSync(localPath).isDirectory()) die(`local path is not a directory: ${localPath}`)

    const remotePath = remoteArg === undefined ? null : validateRemotePath(remoteArg)
    const proj = createProject({ label, localPath: fs.realpathSync(localPath) })
    if (remotePath) setEnvOverrides(proj.id, [{ key: 'DEVSYNC_REMOTE_PATH', value: remotePath, isSecret: false }])
    ensureDeployignore(localPath)
    info(`added "${label}" — ${localPath}`)
    info(`next: devsync setup ${label} (configure hosting entirely in the terminal)`)
    if (remotePath) info(`destination: ${remotePath}`)
  },

  remove() {
    openAndMigrate()
    const [label] = positional
    if (!label) die('usage: devsync remove <label>')
    const p = getProjectByLabel(label)
    if (!p) die(`no such project: ${label}`)
    assertProjectIdle(p.id)
    mutateProject(p.id, () => deleteProject(p.id))
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
      const e = resolveEnv(p.id).values
      console.log(
        `  ${C.b(p.label.padEnd(14))} ${p.localPath}\n` +
        `  ${' '.repeat(14)} ${C.dim('→')} ${e.DEVSYNC_REMOTE_PATH || '(not configured)'}  ${C.dim('[' + (e.DEVSYNC_TRANSPORT || 'sftp') + ']')}  ${p.lastStatus === 'error' ? C.r(p.lastStatus) : C.dim(p.lastStatus)}`
      )
    }
    console.log()
    console.log(C.dim(`stored in ${path.join(HOME, 'devsync.db')}`))
  },

  async test() {
    openAndMigrate()
    const proj = await resolveProjectOrCwd(positional[0])
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
    const proj = await resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj)
    const t = await createTransport(creds, flags.transport).catch((e) => die(e.message))
    try {
      const entries = await t.list(positional[1] || '/')
      for (const e of entries) {
        console.log(`  ${e.type === 'dir' ? C.c('dir ') : '    '} ${e.name}`)
      }
    } finally {
      await t.close()
    }
  },

  async plan(project) {
    openAndMigrate()
    const proj = project || await resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj, { deployment: true })
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    const release = acquireOperation(proj.id, 'preview', { creds, remotePath: proj.remotePath })
    let t
    try {
      t = await createTransport(creds, flags.transport, { onRetry: retryNotice })
      const p = await buildPlan(proj, matcher, t, { force: !!flags.force })
      console.log()
      console.log(C.b(`Plan for "${proj.label}"`) + C.dim(`  ${proj.localPath} → ${proj.remotePath}`))
      console.log(
        C.dim(
          `  ${p.totalFiles} file(s) considered · ${p.uploads.length} to upload · ${p.skipped.length} unchanged · ${p.excludedCount} excluded entries · ${mb(p.comparedBytes)} outbound`
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
      if (p.excluded.length) {
        console.log(C.dim('\n  excluded (directories represent their contents):'))
        for (const entry of p.excluded.slice(0, 40)) console.log(C.dim(`  - ${entry.rel} (${entry.reason})`))
        if (p.excludedCount > 40) console.log(C.dim(`  … ${p.excludedCount - 40} more`))
      }
      console.log()
      console.log(C.dim(`  run:  devsync sync ${proj.label}     (apply)`))
      console.log(C.dim(`  watch: devsync watch ${proj.label}    (continuous)`))
    } finally {
      try { if (t) await t.close() } finally { release() }
    }
  },

  async sync(project, { force = !!flags.force } = {}) {
    openAndMigrate()
    const proj = project || await resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj, { deployment: true })
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    let t
    const release = acquireOperation(proj.id, force ? 'deploy' : 'sync', { creds, remotePath: proj.remotePath })
    setStatus(proj.id, 'syncing')

    const dryRun = creds.dryRun || !!flags['dry-run'] || !!flags.plan

    try {
      t = await createTransport(creds, undefined, { onRetry: retryNotice })
      const p = await buildPlan(proj, matcher, t, { force })
      console.log()
      console.log(C.b(`${cmd === 'deploy' ? 'Deploy' : 'Sync'} "${proj.label}"`) + C.dim(`  ${p.uploads.length} file(s) · ${mb(p.comparedBytes)}`))
      if (dryRun) {
        console.log(C.y('  dry run — nothing was uploaded'))
        for (const u of p.uploads.slice(0, 40)) console.log(`  ${C.g('+')} ${u.rel}`)
        setStatus(proj.id, 'idle')
        return
      }
      if (!p.uploads.length) {
        ok('nothing to upload — already up to date')
        recordSync(proj.id, 0)
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
      if (r.failed.length) {
        setStatus(proj.id, 'error', { error: r.failed.map((f) => `${f.rel}: ${f.error}`).join('; ') })
        warn(`${r.failed.length} failed`)
        for (const f of r.failed) console.log(`  ${C.r('✗')} ${f.rel} — ${f.error}`)
        process.exitCode = 1
      } else {
        if (!dryRun) recordSync(proj.id, r.bytes)
        setStatus(proj.id, 'idle', { error: null })
      }
    } catch (e) {
      setStatus(proj.id, 'error', { error: e.message })
      throw e
    } finally {
      try { if (t) await t.close() } finally { release() }
    }
  },

  async watch() {
    openAndMigrate()
    const proj = await resolveProjectOrCwd(positional[0])
    const creds = await credsForProject(proj, { deployment: true })
    const matcher = buildMatcher(proj.localPath, { useGitignore: false })
    ensureDeployignore(proj.localPath)
    const release = acquireOperation(proj.id, 'watch', { creds, remotePath: proj.remotePath })
    let t
    try { t = await createTransport(creds, flags.transport, { onRetry: retryNotice }) }
    catch (error) { release(); throw error }
    setStatus(proj.id, 'watching')

    console.log()
    console.log(C.b(`Watching "${proj.label}"`))
    console.log(C.dim(`  ${proj.localPath} → ${proj.remotePath}  (${creds.transport})`))
    console.log(C.dim('  Ctrl+C to stop\n'))

    const w = new ProjectWatcher(proj, matcher, t, {
      dryRun: creds.dryRun || !!flags['dry-run'],
      debounceMs: creds.debounceMs,
      onEvent: (e) => {
        if (e.type === 'error') {
          setStatus(proj.id, 'error', { error: e.message })
          console.log(C.r('  ✗ ') + e.message)
        }
        else if (e.type === 'change') console.log(C.dim(`  ~ ${e.kind} ${e.file}`))
        else if (e.type === 'retry') warn(e.message)
      },
      onSettle: (s) => {
        setStatus(proj.id, s.failed.length ? 'error' : 'watching', {
          error: s.failed.length ? s.failed.map((f) => `${f.rel}: ${f.error}`).join('; ') : null
        })
        if (!s.dryRun && !s.failed.length) recordSync(proj.id, s.bytes)
        if (s.uploaded || s.dryRun && s.planned) {
          console.log(C.g(`  ${s.dryRun ? 'preview' : '↑'} ${s.dryRun ? s.planned : s.uploaded} file(s), ${kb(s.bytes)}`) + C.dim(`  (${s.considered} scanned, ${s.skipped} unchanged)`))
        }
        for (const f of s.failed) console.log(C.r(`  ✗ ${f.rel} — ${f.error}`))
      }
    })
    try { w.start() } catch (error) { try { await t.close() } finally { release() }; throw error }

    let stopping = false
    const shutdown = async () => {
      if (stopping) return
      stopping = true
      console.log(C.dim('\nstopping…'))
      try {
        await w.stop()
        await t.close()
        setStatus(proj.id, 'idle')
      } finally { release() }
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
${C.b(name)} ${version} — local projects → shared hosting
Run commands as shared-hosting-sync or its shorter alias devsync.

${C.b('first-time setup')}
  devsync                             onboard the current folder and preview
  devsync setup [label]                fill missing settings and preview
  devsync ui                          open the web UI
  devsync add <label> <localPath> [remotePath]
                                      register a project; then run setup
  devsync projects                     list registered projects

${C.b('bare invocation')}
  cd <project> && devsync              preview the cwd's project

${C.b('per-project')}
  devsync test [label]                 check connectivity
  devsync ls [label] [remotePath]      browse the remote
  devsync plan [label]                 preview, no upload
  devsync deploy [label]               upload all eligible files
  devsync sync [label]                 upload changed files
  devsync watch [label]                continuous, debounced

${C.b('options')}
  --env-file <path>                    read a specific environment file
  --transport=ftp|ftps|sftp             override protocol
  --host <host> --username <user> --port <port>
  --remote-path <path>                 override server destination
  --edit                              setup: edit connection settings
  --browse                            setup: choose a different server folder
  --label <name>                       name a new project
  --dry-run --force                    preview / include unchanged files

${C.b('other')}
  devsync remove <label>
  devsync doctor                       health check
  devsync help
`)
  }
}

async function main() {
  try {
    if (flags.version || cmd === 'version') { console.log(`${name} ${version}`); return }
    if (flags.help || cmd === 'help') return COMMANDS.help()
    if (!cmd) return flags.sync ? await COMMANDS.sync() : await COMMANDS.plan()
    if (!Object.hasOwn(COMMANDS, cmd)) throw new Error(`unknown command: ${cmd}. Run devsync help`)
    return await COMMANDS[cmd]()
  } finally {
    await prompt.close()
  }
}
main().catch((err) => {
  console.error(C.r('\n✗ ') + (err?.message || String(err)))
  process.exitCode = 1
})
