import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectWatcher } from '../src/watcher.js'
import { buildMatcher } from '../src/ignore.js'
import { createMockTransport } from './fixtures/mock-transport.js'
import { setTimeout as delay } from 'node:timers/promises'

test('watch cycles preserve destination and upload subsequent same-size edits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-watch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'index.html')
  fs.writeFileSync(file, 'old!')
  const transport = createMockTransport()
  const settled = []
  const watcher = new ProjectWatcher({ localPath: root, remotePath: '/public_html/site' }, buildMatcher(root), transport, {
    debounceMs: 10000, onSettle: (s) => settled.push(s)
  })
  t.after(() => watcher.stop())
  watcher.queue(file, 'changed')
  await watcher.flush()
  fs.writeFileSync(file, 'new!')
  watcher.queue(file, 'changed')
  await watcher.flush()
  assert.equal(settled.length, 2)
  assert.equal(settled[1].uploaded, 1)
  assert.equal(transport.remote.public_html.site['index.html'].content, 'new!')
  assert.ok(transport.calls.filter((c) => c.method === 'put').every((c) => c.remotePath.startsWith('/public_html/site/')))
})

test('stop drains an in-flight cycle and drops pending changes', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-watch-stop-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'index.html')
  fs.writeFileSync(file, 'old!')
  const transport = createMockTransport()
  let release, entered
  const gate = new Promise((resolve) => { release = resolve })
  const uploading = new Promise((resolve) => { entered = resolve })
  const put = transport.put.bind(transport)
  transport.put = async (...args) => { entered(); await gate; return put(...args) }
  const watcher = new ProjectWatcher({ localPath: root, remotePath: '/site' }, buildMatcher(root), transport)
  watcher.queue(file, 'changed')
  const cycle = watcher.flush()
  await uploading
  watcher.queue(file, 'changed')
  let stopped = false
  const stopping = watcher.stop().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  release()
  await stopping
  await cycle
  assert.equal(watcher.pending.size, 0)
  assert.equal(watcher.stats.cycles, 1)
  assert.equal(transport.calls.filter((call) => call.method === 'put').length, 1)
})

test('watch retries transient outages without requiring another save and stop cancels retries', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-watch-retry-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = path.join(root, 'index.html'); fs.writeFileSync(file, 'recover')
  const transport = createMockTransport()
  const stat = transport.stat.bind(transport)
  let offline = true
  transport.stat = async (...args) => {
    if (offline) throw Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
    return stat(...args)
  }
  const events = []
  const watcher = new ProjectWatcher({ localPath: root, remotePath: '/site' }, buildMatcher(root), transport, { debounceMs: 1, retryDelayMs: 10, onEvent: (event) => events.push(event) })
  t.after(() => watcher.stop())
  watcher.queue(file, 'changed'); await watcher.flush()
  assert.ok(events.some((event) => event.type === 'retry'))
  offline = false
  for (let i = 0; i < 100 && !watcher.stats.uploaded; i++) await delay(10)
  assert.equal(watcher.stats.uploaded, 1)
  offline = true; watcher.queue(file, 'changed'); await watcher.flush(); await watcher.stop()
  const count = events.length; await delay(50); assert.equal(events.length, count)
})
