import { Client } from 'basic-ftp'
import { hashSink } from '../checksum.js'

/**
 * FTP/FTPS adapter.
 * Note: the FTP protocol does not allow multiple requests in parallel, so
 * transfers on a single control connection are inherently serial.
 */
export class FtpTransport {
  constructor(creds) {
    this.creds = creds
    this.preparedDirs = new Set()
    this.client = null
  }

  async connect() {
    const c = new Client(this.creds.timeoutMs)
    try {
      await c.access({
        host: this.creds.host,
        port: this.creds.port || 21,
        user: this.creds.username,
        password: this.creds.password,
        secure: this.creds.secure,
        secureOptions: this.creds.secureOptions
      })
    } catch (err) {
      c.close()
      throw err
    }
    this.preparedDirs.clear()
    this.client = c
    return this
  }

  async list(remotePath) {
    const items = await this.client.list(remotePath || '/')
    return items.map((e) => ({
      name: e.name,
      type: e.isDirectory ? 'dir' : e.isFile ? 'file' : 'other',
      size: e.size ?? 0,
      mtime: e.modifyTime ? new Date(e.modifyTime) : null
    }))
  }

  async ensureDir(remotePath) {
    if (!remotePath || this.preparedDirs.has(remotePath)) return
    // basic-ftp creates intermediate directories itself. Uploads use absolute paths.
    await this.client.ensureDir(remotePath)
    this.preparedDirs.add(remotePath)
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
    } catch (err) {
      if (err.code === 550) return null
      throw err
    }
  }

  async checksum(remotePath) {
    const sink = hashSink()
    await this.client.downloadTo(sink.stream, remotePath)
    return sink.digest()
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
