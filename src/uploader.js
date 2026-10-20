import fs from 'node:fs'
import path from 'node:path'

const TMP_SUFFIX = '.devsync-uploading'

/** Local Windows path -> remote POSIX path, relative to the project root. */
export function toRemotePath(projectRoot, remoteRoot, localAbsPath) {
  const rel = path.relative(projectRoot, localAbsPath).split(path.sep).join('/')
  const root = (remoteRoot || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return root ? `${root}/${rel}` : `/${rel}`
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
export function collectFiles(projectRoot, matcher, { includeIgnored = false } = {}) {
  const out = []
  const relOf = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/')
  const walk = (dir) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (includeIgnored || matcher.shouldWatch(abs)) walk(abs)
      } else if (e.isFile()) {
        // includeIgnored is a diagnostic mode: show everything, filter nothing.
        if (includeIgnored || matcher.reason(relOf(abs)) === null) out.push(abs)
      }
    }
  }
  walk(projectRoot)
  return out
}

/**
 * Build the list of uploads without touching the network for writes.
 * Compares against remote size, skipping identical files.
 */
export async function buildPlan(project, matcher, transport, { force = false } = {}) {
  const { localPath, remotePath } = project
  const files = collectFiles(localPath, matcher)
  const uploads = []
  const skipped = []
  let comparedBytes = 0

  for (const abs of files) {
    const rel = path.relative(localPath, abs).split(path.sep).join('/')
    const remote = toRemotePath(localPath, remotePath, abs)
    let localStat
    try {
      localStat = fs.statSync(abs)
    } catch {
      continue
    }

    if (!force) {
      const remoteStat = await transport.stat(remote).catch(() => null)
      if (remoteStat && remoteStat.size === localStat.size && !remoteStat.isDir) {
        skipped.push({ rel, bytes: localStat.size, reason: 'same size' })
        continue
      }
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

  return { uploads, skipped, totalFiles: files.length, comparedBytes }
}

/**
 * Upload one file atomically: write to <name>.devsync-uploading, then rename.
 * Without this, PHP can parse a half-written file and 500 mid-transfer.
 */
export async function uploadOne(transport, item) {
  for (const dir of item.dirs) {
    await transport.ensureDir(dir).catch(() => {})
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

export async function runPlan(plan, transport, { dryRun = false, onProgress } = {}) {
  const done = []
  const failed = []
  let bytes = 0

  for (let i = 0; i < plan.uploads.length; i++) {
    const item = plan.uploads[i]
    if (onProgress) onProgress({ phase: 'upload', item, index: i, total: plan.uploads.length })
    if (dryRun) {
      done.push({ rel: item.rel, bytes: item.bytes })
      bytes += item.bytes
      continue
    }
    try {
      await uploadOne(transport, item)
      done.push({ rel: item.rel, bytes: item.bytes })
      bytes += item.bytes
    } catch (err) {
      failed.push({ rel: item.rel, error: err.message })
    }
  }

  return { done, failed, bytes }
}