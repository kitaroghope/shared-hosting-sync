// In-memory Transport implementation for tests.
//
// Records every method call so tests can assert what the uploader did.
// Holds a fake "remote" as a plain object tree; stat/list/put/rename/delete
// all read or mutate that tree. Does no I/O.
//
// Tests assert on:
//   - calls: every method call the uploader made, in order
//   - remoteTree: the resulting remote state after the uploader ran
//
// This is not a test double for ssh2-sftp-client or basic-ftp; those have
// their own well-tested suites. This is a test double for *our* code
// (uploader.js, watcher.js) so we can exercise it deterministically.

import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

export function createMockTransport({ remoteRoot = {} } = {}) {
  const calls = []
  const remote = JSON.parse(JSON.stringify(remoteRoot)) // deep clone
  const failures = new Map() // methodName -> Error to throw

  const t = {
    kind: 'mock',
    remote,
    calls,

    /** Configure the next call to `methodName` to throw `err`. */
    failNext(methodName, err) {
      failures.set(methodName, err)
    },

    async list(remotePath) {
      calls.push({ method: 'list', path: remotePath })
      if (failures.has('list')) throw failures.get('list')
      const dir = _resolve(remote, remotePath)
      if (!dir || typeof dir !== 'object' || Array.isArray(dir)) {
        throw new Error(`mock: not a directory: ${remotePath}`)
      }
      return Object.entries(dir)
        .filter(([name]) => name !== '_meta')
        .map(([name, node]) => ({
          name,
          type: node._meta?.type ?? (node && typeof node === 'object' ? 'dir' : 'file'),
          size: node._meta?.size ?? 0,
          mtime: node._meta?.mtime ?? null
        }))
    },

    async ensureDir(remotePath) {
      calls.push({ method: 'ensureDir', path: remotePath })
      if (failures.has('ensureDir')) throw failures.get('ensureDir')
      const parts = remotePath.split('/').filter(Boolean)
      let cur = remote
      for (const part of parts) {
        if (cur[part] == null) {
          cur[part] = { _meta: { type: 'dir' } }
        } else if (typeof cur[part] !== 'object' || Array.isArray(cur[part])) {
          throw new Error(`mock: cannot create dir over a file: ${remotePath}`)
        }
        cur = cur[part]
      }
    },

    async exists(remotePath) {
      calls.push({ method: 'exists', path: remotePath })
      if (failures.has('exists')) throw failures.get('exists')
      return _resolve(remote, remotePath) != null
    },

    async stat(remotePath) {
      calls.push({ method: 'stat', path: remotePath })
      if (failures.has('stat')) throw failures.get('stat')
      const node = _resolve(remote, remotePath)
      if (node == null) return null
      if (node._meta) return { size: node._meta.size ?? 0, mtime: node._meta.mtime ?? null, isDir: node._meta.type === 'dir' }
      return { size: 0, mtime: null, isDir: typeof node === 'object' }
    },

    async checksum(remotePath) {
      calls.push({ method: 'checksum', path: remotePath })
      if (failures.has('checksum')) throw failures.get('checksum')
      const node = _resolve(remote, remotePath)
      if (typeof node?.content !== 'string') throw new Error('mock: remote content unavailable')
      return createHash('sha256').update(node.content).digest('hex')
    },

    async put(localPath, remotePath) {
      calls.push({ method: 'put', localPath, remotePath })
      if (failures.has('put')) throw failures.get('put')
      // The uploader calls put with a localPath; in the test we don't have
      // that localPath, so we record a placeholder. The test should pre-
      // populate `remote` if it wants the put to "succeed" visibly.
      // We still create the entry to mirror a real upload landing.
      const parts = remotePath.split('/').filter(Boolean)
      const filename = parts.pop()
      const dir = parts.length ? _ensureDir(remote, parts) : remote
      const content = fs.readFileSync(localPath, 'utf8')
      dir[filename] = { content, _meta: { type: 'file', size: Buffer.byteLength(content), mtime: Date.now() } }
    },

    async rename(from, to) {
      calls.push({ method: 'rename', from, to })
      if (failures.has('rename')) throw failures.get('rename')
      const fromParts = from.split('/').filter(Boolean)
      const filename = fromParts.pop()
      const fromDir = fromParts.length ? _resolve(remote, fromParts) : remote
      if (fromDir == null || fromDir[filename] == null) {
        throw new Error(`mock: cannot rename missing file: ${from}`)
      }
      const node = fromDir[filename]
      delete fromDir[filename]
      const toParts = to.split('/').filter(Boolean)
      const toFilename = toParts.pop()
      const toDir = toParts.length ? _ensureDir(remote, toParts) : remote
      toDir[toFilename] = node
    },

    async utimes(remotePath, mtimeMs) {
      calls.push({ method: 'utimes', path: remotePath, mtime: mtimeMs })
      if (failures.has('utimes')) throw failures.get('utimes')
      const node = _resolve(remote, remotePath)
      if (node && node._meta) node._meta.mtime = mtimeMs
    },

    async delete(remotePath) {
      calls.push({ method: 'delete', path: remotePath })
      if (failures.has('delete')) throw failures.get('delete')
      const parts = remotePath.split('/').filter(Boolean)
      const name = parts.pop()
      const dir = parts.length ? _resolve(remote, parts) : remote
      if (dir) delete dir[name]
    },

    async close() {
      calls.push({ method: 'close' })
    }
  }

  return t
}

function _resolve(root, path) {
  // Accept either a string "/a/b/c" or a string array ["a","b","c"].
  const parts = Array.isArray(path)
    ? path
    : path.split('/').filter(Boolean)
  let cur = root
  for (const p of parts) {
    if (cur == null) return null
    cur = cur[p]
  }
  return cur
}

function _ensureDir(root, parts) {
  let cur = root
  for (const p of parts) {
    if (cur[p] == null) cur[p] = { _meta: { type: 'dir' } }
    if (typeof cur[p] !== 'object' || Array.isArray(cur[p])) {
      throw new Error(`mock: path component is a file: ${p}`)
    }
    cur = cur[p]
  }
  return cur
}
