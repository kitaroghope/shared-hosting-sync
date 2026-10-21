import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { SftpTransport } from '../src/transport/sftp.js'

test('SFTP adapter uses library stat booleans, missing-file codes and stream downloads', async () => {
  const transport = new SftpTransport({})
  transport.client = {
    stat: async () => ({ size: 4, isDirectory: false }),
    get: async (remote, stream) => { stream.end('same') }
  }
  assert.deepEqual(await transport.stat('/site/index.html'), { size: 4, isDir: false })
  assert.equal(await transport.checksum('/site/index.html'), createHash('sha256').update('same').digest('hex'))
  transport.client.stat = async () => { throw Object.assign(new Error('missing'), { code: 2 }) }
  assert.equal(await transport.stat('/missing'), null)
  transport.client.stat = async () => { throw Object.assign(new Error('denied'), { code: 3 }) }
  await assert.rejects(transport.stat('/denied'), /denied/)
})

test('SFTP adapter checks directory existence and uses file delete', async () => {
  const transport = new SftpTransport({})
  const calls = []
  transport.client = {
    exists: async () => false,
    mkdir: async (...args) => calls.push(['mkdir', ...args]),
    delete: async (...args) => calls.push(['delete', ...args])
  }
  await transport.ensureDir('/site')
  await transport.delete('/site/temp')
  assert.deepEqual(calls, [['mkdir', '/site', true], ['delete', '/site/temp', true]])
  transport.client.exists = async () => '-'
  await assert.rejects(transport.ensureDir('/file'), /occupied/)
})
