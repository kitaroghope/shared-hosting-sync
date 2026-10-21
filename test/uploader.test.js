// End-to-end uploader tests against a MockTransport.
//
// The mock records every method call and holds an in-memory remote tree.
// These tests exercise *our* code (uploader.js, ignore.js) — not the third-
// party transport libraries, which have their own well-tested suites.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { buildPlan, runPlan, toRemotePath } from '../src/uploader.js'
import { buildMatcher } from '../src/ignore.js'
import { createMockTransport } from './fixtures/mock-transport.js'

function freshProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devsync-uploader-'))
  const w = (rel, content = 'x') => {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { root, w }
}

test('same-size changes upload, then the next plan skips identical content', async (t) => {
  const { root, w } = freshProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  w('index.php', 'new!')
  const transport = createMockTransport({ remoteRoot: {
    site: { 'index.php': { content: 'old!', _meta: { type: 'file', size: 4 } } }
  } })
  const project = { localPath: root, remotePath: '/site' }
  const matcher = buildMatcher(root)
  const plan = await buildPlan(project, matcher, transport)
  assert.equal(plan.uploads.length, 1)
  assert.equal(plan.uploads[0].remote, '/site/index.php')
  assert.equal((await runPlan(plan, transport)).failed.length, 0)
  assert.equal((await buildPlan(project, matcher, transport)).skipped.length, 1)
  const forced = await buildPlan(project, matcher, transport, { force: true })
  assert.equal(forced.uploads.length, 1)
})

test('invalid destinations and escaped local files fail before any remote writes', async (t) => {
  const { root, w } = freshProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  w('index.php')
  const transport = createMockTransport()
  const matcher = buildMatcher(root)
  for (const remotePath of [undefined, '', 'public_html', '/site/../other', '/site\nQUIT']) {
    await assert.rejects(buildPlan({ localPath: root, remotePath }, matcher, transport))
  }
  assert.throws(() => toRemotePath(root, '/site', path.join(root, '..', 'outside.php')), /inside/)
  assert.equal(transport.calls.length, 0)
  assert.equal(toRemotePath(root, '/', path.join(root, 'index.php')), '/index.php')
})

test('inspection and directory failures are surfaced without uploading', async (t) => {
  const { root, w } = freshProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  w('index.php', 'new!')
  const matcher = buildMatcher(root)
  const project = { localPath: root, remotePath: '/site' }
  for (const method of ['stat', 'checksum']) {
    const transport = createMockTransport({ remoteRoot: {
      site: { 'index.php': { content: 'old!', _meta: { type: 'file', size: 4 } } }
    } })
    transport.failNext(method, new Error('connection lost'))
    await assert.rejects(buildPlan(project, matcher, transport), /connection lost/)
    assert.equal(transport.calls.some((c) => c.method === 'put'), false)
  }
  const transport = createMockTransport()
  const plan = await buildPlan(project, matcher, transport)
  transport.failNext('ensureDir', new Error('permission denied'))
  const result = await runPlan(plan, transport)
  assert.equal(result.done.length, 0)
  assert.match(result.failed[0].error, /permission denied/)
  assert.equal(transport.calls.some((c) => c.method === 'put'), false)
})

test('a directory at a file destination is rejected even with force', async (t) => {
  const { root, w } = freshProject()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  w('index.php')
  const transport = createMockTransport({ remoteRoot: {
    site: { 'index.php': { _meta: { type: 'dir' } } }
  } })
  await assert.rejects(buildPlan({ localPath: root, remotePath: '/site' }, buildMatcher(root), transport, { force: true }), /directory/)
})

test('buildPlan: identical remote content is skipped', async () => {
  const { root, w } = freshProject()
  try {
    w('index.php', '<?php echo 1;')
    w('api/vouchers.php', '<?php // vouchers')

    const matcher = buildMatcher(root)
    // Use the real local size so the mock's reported size matches.
    const indexSize = fs.statSync(path.join(root, 'index.php')).size
    const transport = createMockTransport({
      remoteRoot: {
        app: {
          _meta: { type: 'dir' },
          // File keys must include the full name with extension.
          'index.php': { content: '<?php echo 1;', _meta: { type: 'file', size: indexSize, mtime: 0 } },
          api: {
            _meta: { type: 'dir' }
            // vouchers.php intentionally missing
          }
        }
      }
    })

    const plan = await buildPlan(
      { localPath: root, remotePath: '/app' },
      matcher,
      transport
    )

    assert.equal(plan.uploads.length, 1, 'one file to upload')
    assert.equal(plan.uploads[0].rel, 'api/vouchers.php')
    assert.equal(plan.skipped.length, 1, 'one file skipped (size match)')
    assert.equal(plan.skipped[0].rel, 'index.php')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('buildPlan: hard blocklist excludes .env and id_rsa from the plan', async () => {
  const { root, w } = freshProject()
  try {
    w('index.php', '<?php echo 1;')
    w('.env', 'DB_PASS=hunter2')
    w('.env.production', 'PROD=1')
    w('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----')
    w('server.pem', '-----BEGIN PRIVATE KEY-----')

    const matcher = buildMatcher(root)
    const transport = createMockTransport({ remoteRoot: {} })

    const plan = await buildPlan(
      { localPath: root, remotePath: '/app' },
      matcher,
      transport
    )

    const rels = plan.uploads.map((u) => u.rel)
    assert.ok(rels.includes('index.php'), 'index.php is in the plan')
    assert.ok(!rels.includes('.env'), '.env is blocked')
    assert.ok(!rels.includes('.env.production'), '.env.production is blocked')
    assert.ok(!rels.includes('id_rsa'), 'id_rsa is blocked')
    assert.ok(!rels.includes('server.pem'), 'server.pem is blocked')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runPlan: atomic write — every upload is put to .tmp then renamed', async () => {
  const { root, w } = freshProject()
  try {
    w('a.txt', 'alpha')
    w('b.txt', 'bravo')

    const matcher = buildMatcher(root)
    const transport = createMockTransport({ remoteRoot: {} })

    const plan = await buildPlan(
      { localPath: root, remotePath: '/app' },
      matcher,
      transport
    )
    const result = await runPlan(plan, transport, { dryRun: false })

    // Every file in the plan should be uploaded.
    assert.equal(result.failed.length, 0, 'no failed uploads')
    assert.equal(result.done.length, 2, 'two uploads succeeded')

    // For each file, we expect: delete(tmp).catch, put(abs, tmp), rename(tmp, real).
    // Verify the order and that no half-file path is observed.
    for (const fileName of ['a.txt', 'b.txt']) {
      const puts = transport.calls.filter(
        (c) => c.method === 'put' && c.localPath.endsWith(fileName)
      )
      const renames = transport.calls.filter(
        (c) => c.method === 'rename' && c.to.endsWith('/' + fileName)
      )
      assert.equal(puts.length, 1, `one put for ${fileName}`)
      assert.equal(renames.length, 1, `one rename for ${fileName}`)
      // The put went to a .tmp path
      assert.match(puts[0].remotePath, /\.devsync-uploading$/, 'put goes to .tmp')
      // The rename came from the same .tmp path
      assert.match(renames[0].from, /\.devsync-uploading$/, 'rename from .tmp')
      assert.equal(renames[0].from, puts[0].remotePath, 'rename source == put destination')
    }

    // No orphan .tmp paths: every put to .tmp must have a matching rename.
    const puts = transport.calls.filter((c) => c.method === 'put')
    const renames = transport.calls.filter((c) => c.method === 'rename')
    const tmpPutPaths = puts
      .map((p) => p.remotePath)
      .filter((p) => p.endsWith('.devsync-uploading'))
    const renamedFrom = new Set(
      renames
        .map((r) => r.from)
        .filter((p) => p.endsWith('.devsync-uploading'))
    )
    for (const tmpPath of tmpPutPaths) {
      assert.ok(renamedFrom.has(tmpPath), `${tmpPath} was put but never renamed`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runPlan: when rename fails, the .tmp file is cleaned up', async () => {
  const { root, w } = freshProject()
  try {
    w('only.txt', 'content')

    const matcher = buildMatcher(root)
    const transport = createMockTransport({ remoteRoot: {} })
    // Fail every rename — the uploader should delete the .tmp it created.
    transport.failNext('rename', new Error('rename failed'))
    transport.failNext('rename', new Error('rename failed'))
    transport.failNext('rename', new Error('rename failed'))
    transport.failNext('rename', new Error('rename failed'))
    transport.failNext('rename', new Error('rename failed'))

    const plan = await buildPlan(
      { localPath: root, remotePath: '/app' },
      matcher,
      transport
    )
    const result = await runPlan(plan, transport, { dryRun: false })

    assert.equal(result.failed.length, 1, 'one failure recorded')
    assert.match(result.failed[0].rel, /only\.txt/)

    // A delete(.tmp) was attempted to clean up.
    const deleteCalls = transport.calls.filter(
      (c) => c.method === 'delete' && c.path.endsWith('.devsync-uploading')
    )
    assert.ok(deleteCalls.length >= 1, 'cleanup delete was attempted')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('runPlan: dry-run never calls put or rename', async () => {
  const { root, w } = freshProject()
  try {
    w('only.txt', 'content')

    const matcher = buildMatcher(root)
    const transport = createMockTransport({ remoteRoot: {} })

    const plan = await buildPlan(
      { localPath: root, remotePath: '/app' },
      matcher,
      transport
    )
    const result = await runPlan(plan, transport, { dryRun: true })

    assert.equal(result.done.length, 1)
    assert.equal(result.failed.length, 0)

    const sideEffects = transport.calls.filter(
      (c) => c.method === 'put' || c.method === 'rename' || c.method === 'delete'
    )
    assert.equal(sideEffects.length, 0, 'dry-run has no side effects')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
