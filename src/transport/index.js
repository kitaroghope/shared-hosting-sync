import { SftpTransport } from './sftp.js'
import { FtpTransport } from './ftp.js'
import { ReliableTransport } from './reliable.js'

export async function createTransport(creds, override, options = {}) {
  const kind = (override || creds.transport || 'sftp').toLowerCase()
  const Adapter = kind === 'sftp' ? SftpTransport : ['ftp', 'ftps'].includes(kind) ? FtpTransport : null
  if (!Adapter) throw new Error(`Unknown transport "${kind}". Use sftp, ftp or ftps.`)
  return new ReliableTransport(() => new Adapter(creds).connect(), options).connect()
}

export { SftpTransport, FtpTransport }
