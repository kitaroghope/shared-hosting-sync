import fs from 'node:fs'
import SftpClient from 'ssh2-sftp-client'
import { hashSink } from '../checksum.js'
import { finished } from 'node:stream/promises'

/** SFTP adapter. Parallel-friendly — ftp() does not have the FTP serialisation limit. */
export class SftpTransport {
  constructor(creds) {
    this.creds = creds
    this.client = null
  }

  async connect() {
    const c = new SftpClient()
    const opts = {
      host: this.creds.host,
      port: this.creds.port || 22,
      username: this.creds.username,
      readyTimeout: this.creds.timeoutMs
    }
    if (this.creds.privateKeyPath && fs.existsSync(this.creds.privateKeyPath)) {
      opts.privateKey = fs.readFileSync(this.creds.privateKeyPath)
      if (this.creds.password) opts.passphrase = this.creds.password
    } else {
      opts.password = this.creds.password
    }
    await c.connect(opts)
    this.client = c
    return this
  }

  async list(remotePath) {
    const raw = await this.client.list(remotePath)
    return raw
      .filter((e) => e.name !== '.' && e.name !== '..')
      .map((e) => ({
        name: e.name,
        type: e.type === 'd' ? 'dir' : 'file',
        size: e.size ?? 0,
        mtime: e.modifyTime ? new Date(e.modifyTime) : null
      }))
  }

  async ensureDir(remotePath) {
    if (!remotePath) return
    const type = await this.client.exists(remotePath)
    if (type && type !== 'd') throw new Error(`Remote directory path is occupied by a file: ${remotePath}`)
    if (!type) await this.client.mkdir(remotePath, true)
  }

  async exists(remotePath) {
    return this.client.exists(remotePath)
  }

  /** Returns a stats object when present, else null. */
  async stat(remotePath) {
    try {
      const s = await this.client.stat(remotePath)
      return { size: s.size, isDir: s.isDirectory }
    } catch (err) {
      if (err.code === 2 || err.code === 'ENOENT') return null
      throw err
    }
  }

  async checksum(remotePath) {
    const sink = hashSink()
    await this.client.get(remotePath, sink.stream)
    await finished(sink.stream)
    return sink.digest()
  }

  async put(localPath, remotePath) {
    await this.client.fastPut(localPath, remotePath, {
      concurrency: 4,
      chunkSize: 32768
    })
  }

  async rename(from, to) {
    await this.client.rename(from, to)
  }

  async delete(remotePath) {
    await this.client.delete(remotePath, true)
  }

  async close() {
    if (this.client) {
      await this.client.end().catch(() => {})
      this.client = null
    }
  }
}
