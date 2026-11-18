import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runUploadQueue } from './uploadQueue.js'
import path from 'node:path'
import { validateRemotePath, relativeFile } from './paths.js'
import { hashFile } from './checksum.js'
import { fingerprint, sameFile } from './core/fileFingerprint.js'
import { isTransient } from './transport/reliable.js'

const TMP_SUFFIX = '.devsync-uploading'
const temporaryPaths = new WeakMap()

/** Local Windows path -> remote POSIX path, relative to the project root. */
export function toRemotePath(projectRoot, remoteRoot, localAbsPath) {
  const rel = relativeFile(projectRoot, localAbsPath)
  const root = validateRemotePath(remoteRoot)
  return `${root === '/' ? '' : root}/${rel}`
}

/** Ancestor directories of a remote file path, outermost first. */
export function ancestorsOf(remotePath) {
  const parts = remotePath.split('/').filter(Boolean)
  const out = []
  let acc = remotePath.startsWith('/') ? '' : '.'
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc === '' || acc === '.' ? `${acc}/${parts[i]}` : `${acc}/${parts[i]}`
    out.push(acc.startsWith('/') ? acc : `/${acc}`)
  }
  return out
}

/** Every eligible local file, as absolute paths. */
export function collectFiles(projectRoot, matcher, { includeIgnored = false, onExcluded } = {}) {
  const out = []
  const relOf = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/')
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      throw new Error(`Cannot read local folder ${dir}: ${err.message}`)
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (includeIgnored || matcher.shouldWatch(abs)) walk(abs)
        else if (onExcluded) onExcluded({ rel: relOf(abs) + '/', reason: matcher.reason(relOf(abs)) })
      } else if (e.isFile()) {
        // includeIgnored is a diagnostic mode: show everything, filter nothing.
        const reason = matcher.reason(relOf(abs))
        if (includeIgnored || reason === null) out.push(abs)
        else if (onExcluded) onExcluded({ rel: relOf(abs), reason })
      }
    }
  }
  walk(projectRoot)
  return out
}

/**
 * Build the list of uploads without touching the network for writes.
 * Saved projects compare local metadata with SQLite. Explicit scans verify remote content.
 */
export async function buildPlan(project, matcher, transport, { force = false, remoteInventory, onProgress } = {}) {
  const { localPath, remotePath } = project
  const root = validateRemotePath(remotePath)
  const realRoot = fs.realpathSync(localPath)
  if (!fs.statSync(realRoot).isDirectory()) throw new Error('Local source must be a directory')
  const excluded = []
  let excludedCount = 0
  const files = collectFiles(localPath, matcher, { onExcluded: (entry) => {
    excludedCount++
    if (excluded.length < 200) excluded.push(entry)
  } })
  const scope = project.syncScope
  const saved = scope && !remoteInventory ? (await import('./core/syncState.js')).readSyncFiles(scope) : null
  const matches = []
  const uploads = []
  const skipped = []
  let comparedBytes = 0

  for (const [index, abs] of files.entries()) {
    const rel = relativeFile(localPath, abs)
    const remote = `${root === '/' ? '' : root}/${rel}`
    let localStat
    try {
      relativeFile(realRoot, fs.realpathSync(abs))
      localStat = fs.statSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }

    if (onProgress) onProgress({ phase: 'planning', item: { rel, remote, bytes: localStat.size }, index, total: files.length })

    const localFingerprint = fingerprint(localStat)
    if (saved) {
      if (!force && sameFile(saved.get(rel), localFingerprint)) {
        skipped.push({ rel, bytes: localStat.size, reason: 'unchanged since last successful sync' })
        continue
      }
    } else {
      const remoteStat = remoteInventory ? remoteInventory.get(rel) : await transport.stat(remote)
      if (remoteStat?.isDir) throw new Error(`Remote file destination is a directory: ${remote}`)
      if (!force && remoteStat && remoteStat.size === localStat.size &&
          await transport.checksum(remote) === await hashFile(abs)) {
        skipped.push({ rel, bytes: localStat.size, reason: 'same content' })
        matches.push({ abs, rel, fingerprint: localFingerprint })
        continue
      }
    }

    uploads.push({
      abs,
      rel,
      remote,
      bytes: localStat.size,
      fingerprint: localFingerprint,
      dirs: ancestorsOf(remote)
    })
    comparedBytes += localStat.size
  }

  return { uploads, skipped, excluded, excludedCount, totalFiles: files.length, comparedBytes, syncScope: scope, matches }
}

/** Scan server content without uploading; only confirmed matches become the baseline. */
export async function scanServer(project, matcher, transport, options = {}) {
  if (!project.syncScope) throw new Error('A saved project is required for a server scan')
  const root = validateRemotePath(project.remotePath)
  const remoteInventory = new Map()
  const folders = ['']
  for (let index = 0; index < folders.length; index++) {
    const folder = folders[index]
    const remote = path.posix.join(root, folder)
    options.onProgress?.({ phase: 'inventory', item: { rel: remote }, index, total: folders.length })
    for (const entry of await transport.list(remote)) {
      if (!entry.name || entry.name === '.' || entry.name === '..' || /[\\/\x00-\x1f\x7f]/.test(entry.name)) continue
      const rel = folder ? folder + '/' + entry.name : entry.name
      const isDir = entry.type === 'dir'
      if (entry.type !== 'file' && !isDir) continue
      remoteInventory.set(rel, { isDir, size: entry.size })
      if (isDir && matcher.shouldWatch(path.join(project.localPath, ...rel.split('/')))) folders.push(rel)
    }
  }
  const plan = await buildPlan(project, matcher, transport, { ...options, force: false, remoteInventory })
  const { replaceScannedFiles } = await import('./core/syncState.js')
  replaceScannedFiles(project.syncScope, plan.matches)
  return plan
}

/**
 * Upload one file atomically: write to a unique temporary file, then rename.
 * Without this, PHP can parse a half-written file and 500 mid-transfer.
 */
export async function uploadOne(transport, item, options) {
  if (transport.transaction) return transport.transaction((raw) => uploadAttempt(raw, item), options)
  return uploadAttempt(transport, item)
}

async function uploadAttempt(transport, item) {
  const parent = item.dirs.at(-1)
  if (parent) await transport.ensureDir(parent)
  // Reuse this file’s temporary name on retry so a leftover partial file is replaced.
  let tmp = temporaryPaths.get(item)
  if (!tmp) {
    tmp = path.posix.join(path.posix.dirname(item.remote), randomUUID() + TMP_SUFFIX)
    temporaryPaths.set(item, tmp)
  }
  try {
    await transport.put(item.abs, tmp)
    await transport.rename(tmp, item.remote)
  } catch (err) {
    await transport.delete(tmp).catch(() => {})
    throw err
  }
}

export async function runPlan(plan, transport, { dryRun = false, onProgress, onFileResult, createWorker, concurrency = 3, retries = 2, retryDelayMs = 250, onRetry, onWorkerState } = {}) {
  const record = !dryRun && plan.syncScope && plan.uploads.length
    ? (await import('./core/syncState.js')).recordUploadedFile : null
  if (!dryRun && createWorker) {
    return runUploadQueue(plan.uploads, {
      transport, createWorker, concurrency, retries, retryDelayMs, onProgress, onFileResult, onRetry, onWorkerState,
      upload: (client, item) => uploadOne(client, item, { retries: 0 }),
      succeeded: item => record?.(plan.syncScope, item)
    })
  }
  const done = []
  const failed = []
  let bytes = 0

  for (let i = 0; i < plan.uploads.length; i++) {
    const item = plan.uploads[i]
    if (onProgress) onProgress({ phase: 'upload', item, index: i, total: plan.uploads.length })
    if (dryRun) {
      done.push({ rel: item.rel, bytes: item.bytes })
      bytes += item.bytes
      if (onFileResult) onFileResult({ item, index: i, total: plan.uploads.length, success: true, dryRun: true, bytes })
      continue
    }
    try {
      await uploadOne(transport, item)
      record?.(plan.syncScope, item)
      done.push({ rel: item.rel, bytes: item.bytes })
      bytes += item.bytes
      if (onFileResult) onFileResult({ item, index: i, total: plan.uploads.length, success: true, dryRun: false, bytes })
    } catch (err) {
      failed.push({ rel: item.rel, error: err.message, retryable: isTransient(err) })
      if (onFileResult) onFileResult({ item, index: i, total: plan.uploads.length, success: false, error: err.message, dryRun: false, bytes })
    }
  }

  return { done, failed, bytes }
}
