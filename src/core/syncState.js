import crypto from 'node:crypto'
import { sameFile, currentFingerprint } from './fileFingerprint.js'
import { openDb } from './db.js'

/** Credentials are deliberately excluded; changes to source or destination get a new baseline. */
export function syncScope(project, creds) {
  return {
    projectId: project.id,
    targetKey: crypto.createHash('sha256').update(JSON.stringify([
      project.localPath, creds.transport, String(creds.host).toLowerCase(),
      Number(creds.port), creds.username, project.remotePath
    ])).digest('hex')
  }
}


export function readSyncFiles(scope) {
  return new Map(openDb().prepare(`SELECT relative_path, size, mtime_ms, ctime_ms FROM sync_files
    WHERE project_id = ? AND target_key = ?`).all(scope.projectId, scope.targetKey)
    .map(row => [row.relative_path, { size: row.size, mtimeMs: row.mtime_ms, ctimeMs: row.ctime_ms }]))
}

export function syncStatus(scope) {
  const db = openDb()
  const target = db.prepare('SELECT scanned_at FROM sync_targets WHERE project_id = ? AND target_key = ?').get(scope.projectId, scope.targetKey)
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM sync_files WHERE project_id = ? AND target_key = ?').get(scope.projectId, scope.targetKey)
  return { trackedFiles: count, scannedAt: target?.scanned_at || null, ready: !!target }
}

function ensureTarget(db, scope) {
  db.prepare('INSERT OR IGNORE INTO sync_targets (project_id, target_key) VALUES (?, ?)').run(scope.projectId, scope.targetKey)
}
function writeFile(db, scope, rel, value) {
  db.prepare(`INSERT INTO sync_files (project_id, target_key, relative_path, size, mtime_ms, ctime_ms, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, target_key, relative_path) DO UPDATE SET
    size=excluded.size, mtime_ms=excluded.mtime_ms, ctime_ms=excluded.ctime_ms, synced_at=excluded.synced_at`)
    .run(scope.projectId, scope.targetKey, rel, value.size, value.mtimeMs, value.ctimeMs, new Date().toISOString())
}

/** Save only the exact local version that was uploaded successfully. */
export function recordUploadedFile(scope, item) {
  const db = openDb()
  if (!sameFile(item.fingerprint, currentFingerprint(item.abs))) {
    db.prepare('DELETE FROM sync_files WHERE project_id = ? AND target_key = ? AND relative_path = ?').run(scope.projectId, scope.targetKey, item.rel)
    return
  }
  ensureTarget(db, scope)
  writeFile(db, scope, item.rel, item.fingerprint)
}

/** Commit a completed read-only server scan atomically; failed scans leave the previous baseline intact. */
export function replaceScannedFiles(scope, matches) {
  const db = openDb()
  db.exec('BEGIN IMMEDIATE')
  try {
    ensureTarget(db, scope)
    db.prepare('DELETE FROM sync_files WHERE project_id = ? AND target_key = ?').run(scope.projectId, scope.targetKey)
    for (const item of matches) {
      if (sameFile(item.fingerprint, currentFingerprint(item.abs))) writeFile(db, scope, item.rel, item.fingerprint)
    }
    db.prepare('UPDATE sync_targets SET scanned_at = ? WHERE project_id = ? AND target_key = ?')
      .run(new Date().toISOString(), scope.projectId, scope.targetKey)
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
