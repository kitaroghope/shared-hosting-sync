import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { resolveEnv } from '../src/core/envResolver.js'
import { prepareConfiguration } from '../src/onboarding.js'
import { createPrompter } from '../src/prompt.js'
import { parseArgs } from '../src/arguments.js'

function settings(t, overrides = '') {
  const localPath = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-onboard-'))
  t.after(() => fs.rmSync(localPath, { recursive: true, force: true }))
  fs.writeFileSync(path.join(localPath, '.env'), [
    'DEVSYNC_TRANSPORT=ftp', 'DEVSYNC_HOST=ftp.example.com', 'DEVSYNC_USERNAME=tester',
    'DEVSYNC_PASSWORD="private=value"', 'DEVSYNC_REMOTE_PATH=/public_html/site', overrides
  ].join('\n'))
  return { localPath, resolved: resolveEnv(null, { localPath }) }
}

function connection() {
  const calls = []
  return {
    calls,
    async list(remote) {
      calls.push(['list', remote])
      return remote === '/' ? [{ name: 'public_html', type: 'dir' }, { name: 'file.txt', type: 'file' }] : []
    },
    async close() { calls.push(['close']) }
  }
}

test('complete .env needs no questions and performs no server writes', async (t) => {
  const { localPath, resolved } = settings(t)
  const remote = connection()
  const logs = []
  const result = await prepareConfiguration(resolved, {
    localPath, ask: async () => { throw new Error('unexpected question') },
    connect: async (creds) => { assert.equal(creds.port, 21); return remote }, log: (s) => logs.push(s)
  })
  assert.equal(result.values.DEVSYNC_REMOTE_PATH, '/public_html/site')
  assert.deepEqual(remote.calls, [['list', '/'], ['close']])
  assert.ok(logs.some((s) => s.includes('(.env)')))
  assert.equal(logs.join('\n').includes('private=value'), false)
})

test('only invalid port, missing password and destination are requested; .env stays intact', async (t) => {
  const { localPath, resolved } = settings(t, 'DEVSYNC_PORT=bad\nDEVSYNC_PASSWORD=\nDEVSYNC_REMOTE_PATH=')
  const original = fs.readFileSync(path.join(localPath, '.env'), 'utf8')
  const remote = connection()
  const asked = []
  const answers = ['21', 'password-from-prompt', '1', '.']
  const result = await prepareConfiguration(resolved, {
    localPath, connect: async () => remote, log: () => {},
    ask: async (question) => { asked.push(question); return answers.shift() }
  })
  assert.deepEqual(asked.map((q) => q.key), ['DEVSYNC_PORT', 'DEVSYNC_PASSWORD', 'DEVSYNC_REMOTE_PATH', 'DEVSYNC_REMOTE_PATH'])
  assert.equal(asked[1].secret, true)
  assert.equal(result.values.DEVSYNC_REMOTE_PATH, '/public_html')
  assert.equal(fs.readFileSync(path.join(localPath, '.env'), 'utf8'), original)
  assert.deepEqual(remote.calls, [['list', '/'], ['list', '/public_html'], ['close']])
})

test('missing settings without a terminal fail before connecting', async (t) => {
  const { localPath, resolved } = settings(t, 'DEVSYNC_HOST=\nDEVSYNC_REMOTE_PATH=')
  await assert.rejects(prepareConfiguration(resolved, {
    localPath, connect: async () => { throw new Error('should not connect') }
  }), /DEVSYNC_HOST.*DEVSYNC_REMOTE_PATH/)
})

test('missing protocol is asked once and its default port follows the answer', async (t) => {
  const { localPath, resolved } = settings(t, 'DEVSYNC_TRANSPORT=')
  const asked = []
  const result = await prepareConfiguration(resolved, {
    localPath, log: () => {}, ask: async (q) => { asked.push(q.key); return 'ftps' },
    connect: async (creds) => { assert.equal(creds.port, 21); assert.equal(creds.secure, true); return connection() }
  })
  assert.deepEqual(asked, ['DEVSYNC_TRANSPORT'])
  assert.equal(result.values.DEVSYNC_TRANSPORT, 'ftps')
})

test('cancelled server browsing closes the connection', async (t) => {
  const { localPath, resolved } = settings(t, 'DEVSYNC_REMOTE_PATH=')
  const remote = connection()
  await assert.rejects(prepareConfiguration(resolved, {
    localPath, ask: async () => 'q', connect: async () => remote, log: () => {}
  }), /cancelled/)
  assert.deepEqual(remote.calls.at(-1), ['close'])
})

test('connection errors redact the supplied password', async (t) => {
  const { localPath, resolved } = settings(t)
  await assert.rejects(prepareConfiguration(resolved, {
    localPath, log: () => {}, connect: async () => { throw new Error('rejected private=value') }
  }), (err) => !err.message.includes('private=value') && err.message.includes('[redacted]'))
})

test('password prompt suppresses terminal echo and cancels cleanly', async () => {
  const input = new PassThrough()
  input.isTTY = true
  input.setRawMode = () => {}
  let display = ''
  const output = new Writable({ write(chunk, encoding, callback) { display += chunk.toString(); setImmediate(callback) } })
  output.isTTY = true
  const prompt = createPrompter(input, output)
  try {
    const answer = prompt.ask({ key: 'DEVSYNC_PASSWORD', label: 'Password', secret: true })
    input.write('never-echo-this\r')
    assert.equal(await answer, 'never-echo-this')
    const cancelled = prompt.ask({ key: 'host' })
    input.write('\x03')
    await assert.rejects(cancelled, /cancelled/)
    await prompt.close()
    assert.match(display, /Password/)
    assert.equal(display.includes('never-echo-this'), false)
  } finally { await prompt.close(); input.destroy(); output.end() }
})

test('CLI options preserve equals signs, support both forms and reject missing values', () => {
  assert.deepEqual(parseArgs(['--env-file=./.env.production', 'deploy', 'site', '--remote-path', '/site=a', '--dry-run=false']), {
    command: 'deploy', positional: ['site'], flags: { 'env-file': './.env.production', 'remote-path': '/site=a', 'dry-run': false }
  })
  assert.equal(parseArgs(['--sync']).command, undefined)
  assert.throws(() => parseArgs(['--env-file']), /requires a value/)
  assert.throws(() => parseArgs(['--force=no']), /true or false/)
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/)
})

test('browser can go up, recover from invalid paths, and explicitly select account root', async (t) => {
  const { localPath, resolved } = settings(t, 'DEVSYNC_REMOTE_PATH=')
  const remote = connection()
  const list = remote.list.bind(remote)
  remote.list = async (folder) => {
    if (folder === '/missing') throw new Error('not found')
    return list(folder)
  }
  const answers = ['99', '/missing', '1', '..', '.']
  const result = await prepareConfiguration(resolved, {
    localPath, ask: async () => answers.shift(), connect: async () => remote, log: () => {}
  })
  assert.equal(result.values.DEVSYNC_REMOTE_PATH, '/')
  assert.equal(answers.length, 0)
})
