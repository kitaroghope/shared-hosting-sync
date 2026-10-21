import crypto from 'node:crypto'
import { openDb } from './db.js'

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

function rows(db) {
  const locks = db.prepare('SELECT * FROM operation_locks').all()
  for (const lock of locks) {
    if (!alive(lock.pid)) db.prepare('DELETE FROM operation_locks WHERE token = ?').run(lock.token)
  }
  return locks.filter((lock) => alive(lock.pid))
}

const overlaps = (a, b) => a === '/' || b === '/' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/')
const conflict = () => Object.assign(new Error('This project or server destination has an operation running in another CLI or dashboard. Stop watching or wait for it to finish.'), { statusCode: 409 })

/** Local-machine coordination for processes sharing DEVSYNC_HOME. No credentials stored. */
export function acquireOperation(projectId, kind, { creds, remotePath } = {}) {
  const db = openDb()
  const endpoint = creds ? crypto.createHash('sha256').update(JSON.stringify([
    creds.transport, String(creds.host).toLowerCase(), Number(creds.port), creds.username
  ])).digest('hex') : null
  const token = crypto.randomUUID()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (rows(db).some((lock) => lock.project_id === projectId || endpoint && lock.endpoint === endpoint && overlaps(remotePath, lock.remote_path))) throw conflict()
    db.prepare('INSERT INTO operation_locks (token, project_id, pid, kind, endpoint, remote_path, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(token, projectId, process.pid, kind, endpoint, remotePath || null, new Date().toISOString())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  let released = false
  return () => {
    if (released) return
    db.prepare('DELETE FROM operation_locks WHERE token = ?').run(token)
    released = true
  }
}

export function assertProjectIdle(projectId) {
  if (rows(openDb()).some((lock) => lock.project_id === Number(projectId))) throw conflict()
}

export function mutateProject(projectId, action) {
  const release = acquireOperation(Number(projectId), 'settings')
  try { return action() } finally { release() }
}

export function projectOperation(projectId) {
  const lock = rows(openDb()).find((row) => row.project_id === Number(projectId))
  return lock ? { kind: lock.kind, startedAt: lock.started_at } : null
}
