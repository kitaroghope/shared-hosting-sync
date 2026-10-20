// End-to-end FTP transport test against an in-process ftp-srv server.
// This proves the FtpTransport class in src/transport/ftp.js works against
// a real FTP server, not a mock.
//
// Run with: node --test test/transport-ftp.test.js

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FtpTransport } from '../src/transport/ftp.js'
import { startFtpFixture } from './fixtures/ftp.js'

test('FtpTransport: connect, upload a file, list it back, assert bytes match', async () => {
  const srv = await startFtpFixture()
  try {
    const transport = new FtpTransport({
      host: srv.host,
      port: srv.port,
      username: srv.username,
      password: srv.password,
      secure: false,
      timeoutMs: 5000
    })
    await transport.connect()

    const list0 = await transport.list('/')
    assert.equal(list0.length, 0, 'fresh remote is empty')

    // ensureDir + put + stat + list roundtrip
    await transport.ensureDir('/app')
    await transport.put(new URL('../package.json', import.meta.url).pathname.replace(/^\//, ''), '/app/package.json')
    // Note: basic-ftp wants an actual file path; we use the project's own
    // package.json as a real file to upload.

    const stat = await transport.stat('/app/package.json')
    assert.ok(stat, 'stat returns the uploaded file')
    assert.ok(stat.size > 0, 'stat.size is positive')

    const list1 = await transport.list('/app')
    assert.equal(list1.length, 1, 'one file after upload')
    assert.equal(list1[0].name, 'package.json')

    await transport.close()
  } finally {
    await srv.stop()
  }
})

test('FtpTransport: rename moves a file from one path to another', async () => {
  const srv = await startFtpFixture()
  try {
    const transport = new FtpTransport({
      host: srv.host,
      port: srv.port,
      username: srv.username,
      password: srv.password,
      secure: false,
      timeoutMs: 5000
    })
    await transport.connect()

    await transport.ensureDir('/app')
    await transport.put(new URL('../package.json', import.meta.url).pathname.replace(/^\//, ''), '/app/old-name.json')
    await transport.rename('/app/old-name.json', '/app/new-name.json')

    const list = await transport.list('/app')
    assert.equal(list.length, 1, 'still one file after rename')
    assert.equal(list[0].name, 'new-name.json', 'renamed to new-name.json')

    await transport.close()
  } finally {
    await srv.stop()
  }
})

test('FtpTransport: delete removes a file', async () => {
  const srv = await startFtpFixture()
  try {
    const transport = new FtpTransport({
      host: srv.host,
      port: srv.port,
      username: srv.username,
      password: srv.password,
      secure: false,
      timeoutMs: 5000
    })
    await transport.connect()

    await transport.ensureDir('/app')
    await transport.put(new URL('../package.json', import.meta.url).pathname.replace(/^\//, ''), '/app/temp.json')
    await transport.delete('/app/temp.json')

    const list = await transport.list('/app')
    assert.equal(list.length, 0, 'no files after delete')

    await transport.close()
  } finally {
    await srv.stop()
  }
})