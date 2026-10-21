import fs from 'node:fs'
import path from 'node:path'
import { validateRemotePath, relativeFile } from './paths.js'
import { hashFile } from './checksum.js'
import { isTransient } from './transport/reliable.js'

const TMP_SUFFIX = '.devsync-uploading'

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
 * Size differences upload immediately; equal sizes require a content match.
 */
export async function buildPlan(project, matcher, transport, { force = false, onProgress } = {}) {
  const { localPath, remotePath } = project
  validateRemotePath(remotePath)
  if (!fs.statSync(localPath).isDirectory()) throw new Error('Local source must be a directory')
  const excluded = []
  let excludedCount = 0
  const files = collectFiles(localPath, matcher, { onExcluded: (entry) => {
    excludedCount++
    if (excluded.length < 200) excluded.push(entry)
  } })
  const uploads = []
  const skipped = []
  let comparedBytes = 0

  for (const [index, abs] of files.entries()) {
    const rel = path.relative(localPath, abs).split(path.sep).join('/')
    const remote = toRemotePath(localPath, remotePath, abs)
    let localStat
    try {
      relativeFile(fs.realpathSync(localPath), fs.realpathSync(abs))
      localStat = fs.statSync(abs)
    } catch (err) {
      if (err.code === 'ENOENT') continue
      throw err
    }

    if (onProgress) onProgress({ phase: 'planning', item: { rel, remote, bytes: localStat.size }, index, total: files.length })

    const remoteStat = await transport.stat(remote)
    if (remoteStat?.isDir) throw new Error(`Remote file destination is a directory: ${remote}`)
    if (!force && remoteStat && remoteStat.size === localStat.size &&
        await transport.checksum(remote) === await hashFile(abs)) {
      skipped.push({ rel, bytes: localStat.size, reason: 'same content' })
      continue
    }

    uploads.push({
      abs,
      rel,
      remote,
      bytes: localStat.size,
      dirs: ancestorsOf(remote)
    })
    comparedBytes += localStat.size
  }

  return { uploads, skipped, excluded, excludedCount, totalFiles: files.length, comparedBytes }
}

/**
 * Upload one file atomically: write to <name>.devsync-uploading, then rename.
 * Without this, PHP can parse a half-written file and 500 mid-transfer.
 */
export async function uploadOne(transport, item) {
  if (transport.transaction) return transport.transaction((raw) => uploadAttempt(raw, item))
  return uploadAttempt(transport, item)
}

async function uploadAttempt(transport, item) {
  for (const dir of item.dirs) {
    await transport.ensureDir(dir)
  }
  const tmp = item.remote + TMP_SUFFIX
  try {
    await transport.delete(tmp).catch(() => {})
    await transport.put(item.abs, tmp)
    await transport.rename(tmp, item.remote)
  } catch (err) {
    await transport.delete(tmp).catch(() => {})
    throw err
  }
}

export async function runPlan(plan, transport, { dryRun = false, onProgress, onFileResult } = {}) {
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
