import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ProjectWatcher } from '../src/watcher.js'
import { buildMatcher } from '../src/ignore.js'
import { createMockTransport } from './fixtures/mock-transport.js'

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
