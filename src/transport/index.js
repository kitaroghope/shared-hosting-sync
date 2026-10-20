import { SftpTransport } from './sftp.js'
import { FtpTransport } from './ftp.js'

export async function createTransport(creds, override) {
  const kind = (override || creds.transport || 'sftp').toLowerCase()
  if (kind === 'sftp') return new SftpTransport(creds).connect()
  if (kind === 'ftp' || kind === 'ftps') return new FtpTransport(creds).connect()
  throw new Error(`Unknown transport "${kind}". Use sftp, ftp or ftps.`)
}

export { SftpTransport, FtpTransport }