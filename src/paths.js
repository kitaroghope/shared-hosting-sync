import path from 'node:path'

/** Require an explicit server destination; never infer the account root. */
export function validateRemotePath(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Set DEVSYNC_REMOTE_PATH to a server folder before deploying')
  }
  const remote = value.replace(/\\/g, '/')
  if (!remote.startsWith('/') || /[\x00-\x1f\x7f]/.test(remote) || remote.split('/').includes('..')) {
    throw new Error('Remote path must be absolute and must not contain .. or control characters')
  }
  return path.posix.normalize(remote).replace(/\/$/, '') || '/'
}

export function relativeFile(root, file) {
  const rel = path.relative(root, file)
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('Upload source must be a file inside the selected local folder')
  }
  const posix = rel.split(path.sep).join('/')
  if (/[\\\x00-\x1f\x7f]/.test(posix)) throw new Error('Unsupported characters in upload path')
  return posix
}
