import { Client } from 'basic-ftp'

/**
 * FTP/FTPS adapter.
 * Note: the FTP protocol does not allow multiple requests in parallel, so
 * transfers on a single control connection are inherently serial.
 */
export class FtpTransport {
  constructor(creds) {
    this.creds = creds
    this.client = null
  }

  async connect() {
    const c = new Client(this.creds.timeoutMs)
    await c.access({
      host: this.creds.host,
      port: this.creds.port || 21,
      user: this.creds.username,
      password: this.creds.password,
      secure: this.creds.secure,
      secureOptions: { rejectUnauthorized: false }
    })
    this.client = c
    return this
  }

  async list(remotePath) {
    const items = await this.client.list(remotePath || '/')
    return items.map((e) => ({
      name: e.name,
      type: e.isDirectory ? 'dir' : 'file',
      size: e.size ?? 0,
      mtime: e.modifyTime ? new Date(e.modifyTime) : null
    }))
  }

  async ensureDir(remotePath) {
    if (!remotePath) return
    // cd() creates nothing; uploadToDir() does not create intermediate dirs.
    // Walk up so each level exists before the next.
    const parts = remotePath.split('/').filter(Boolean)
    let acc = remotePath.startsWith('/') ? '' : '.'
    for (const part of parts) {
      acc = acc === '' || acc === '.' ? `${acc}/${part}` : `${acc}/${part}`
      const current = acc.startsWith('/') ? acc : `/${acc}`
      try {
        await this.client.ensureDir(current)
      } catch {
        // ensureDir throws when the dir already exists on some servers — fine.
      }
    }
  }

  async exists(remotePath) {
    try {
      const size = await this.client.size(remotePath)
      return size !== -1
    } catch {
      return false
    }
  }

  async stat(remotePath) {
    try {
      const size = await this.client.size(remotePath)
      return size === -1 ? null : { size, isDir: false }
    } catch {
      return null
    }
  }

  async put(localPath, remotePath) {
    await this.client.uploadFrom(localPath, remotePath)
  }

  async rename(from, to) {
    await this.client.rename(from, to)
  }

  async delete(remotePath) {
    await this.client.remove(remotePath)
  }

  async close() {
    if (this.client) {
      this.client.close()
      this.client = null
    }
  }
}