// Local test-only SFTP server backed by a disposable directory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
const { Server, utils } = ssh2

export async function startSftpFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-sftp-'))
  const clients = new Set()
  const key = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [key] }, (client) => {
    clients.add(client)
    client.on('error', () => {})
    client.on('close', () => clients.delete(client))
    client.on('authentication', (ctx) => ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'test-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => {
      const sftp = acceptSftp(), handles = new Map()
      let counter = 0
      const local = (remote) => {
        const file = path.resolve(root, '.' + path.posix.normalize('/' + remote))
        if (file !== root && !file.startsWith(root + path.sep)) throw new Error('Outside fixture')
        return file
      }
      const attrs = (stat) => ({ mode: stat.mode, size: stat.size, uid: 0, gid: 0, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) })
      const respond = (id, action) => {
        try { action() } catch (error) { sftp.status(id, error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4, error.message) }
      }
      const handle = (id, entry) => { const token = Buffer.from(String(++counter)); handles.set(token.toString(), entry); sftp.handle(id, token) }
      sftp.on('REALPATH', (id, remote) => respond(id, () => sftp.name(id, [{ filename: path.posix.resolve('/', remote), longname: '', attrs: attrs(fs.statSync(local(remote))) }])))
      for (const operation of ['STAT', 'LSTAT']) sftp.on(operation, (id, remote) => respond(id, () => sftp.attrs(id, attrs(fs.statSync(local(remote))))))
      sftp.on('FSTAT', (id, token) => respond(id, () => sftp.attrs(id, attrs(fs.fstatSync(handles.get(token.toString()).fd)))))
      sftp.on('OPEN', (id, remote, flags) => respond(id, () => {
        const write = !!(flags & 2)
        const mode = write ? flags & 16 ? 'w' : 'r+' : 'r'
        handle(id, { fd: fs.openSync(local(remote), mode) })
      }))
      sftp.on('READ', (id, token, offset, length) => respond(id, () => {
        const buffer = Buffer.alloc(Math.min(length, 65536))
        const count = fs.readSync(handles.get(token.toString()).fd, buffer, 0, buffer.length, offset)
        if (count) sftp.data(id, buffer.subarray(0, count)); else sftp.status(id, 1)
      }))
      sftp.on('WRITE', (id, token, offset, data) => respond(id, () => {
        fs.writeSync(handles.get(token.toString()).fd, data, 0, data.length, offset); sftp.status(id, 0)
      }))
      sftp.on('OPENDIR', (id, remote) => respond(id, () => handle(id, { dir: local(remote), entries: fs.readdirSync(local(remote)) })))
      sftp.on('READDIR', (id, token) => respond(id, () => {
        const entry = handles.get(token.toString())
        if (!entry.entries.length) return sftp.status(id, 1)
        const names = entry.entries.splice(0).map((name) => ({ filename: name, longname: name, attrs: attrs(fs.statSync(path.join(entry.dir, name))) }))
        sftp.name(id, names)
      }))
      sftp.on('CLOSE', (id, token) => respond(id, () => {
        const entry = handles.get(token.toString()); if (entry.fd !== undefined) fs.closeSync(entry.fd)
        handles.delete(token.toString()); sftp.status(id, 0)
      }))
      sftp.on('MKDIR', (id, remote) => respond(id, () => { fs.mkdirSync(local(remote)); sftp.status(id, 0) }))
      sftp.on('REMOVE', (id, remote) => respond(id, () => { fs.unlinkSync(local(remote)); sftp.status(id, 0) }))
      sftp.on('RENAME', (id, from, to) => respond(id, () => { fs.renameSync(local(from), local(to)); sftp.status(id, 0) }))
      sftp.on('end', () => { for (const entry of handles.values()) if (entry.fd !== undefined) { try { fs.closeSync(entry.fd) } catch {} }; handles.clear() })
    })))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    rootDir: root, creds: { transport: 'sftp', host: '127.0.0.1', port: server.address().port, username: 'tester', password: 'test-only', timeoutMs: 3000 },
    async stop() {
      for (const client of clients) client.destroy()
      await new Promise((resolve) => server.close(resolve))
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
}
