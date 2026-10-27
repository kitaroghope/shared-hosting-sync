import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentPanel } from '../src/ui/deployments.js'

function harness(t) {
  const previousDocument = globalThis.document
  const previousConfirm = globalThis.confirm
  const elements = new Map()
  const requests = []
  let pending = Promise.resolve()
  globalThis.document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', textContent: '', dataset: {}, checked: false, value: 'sync', scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
    return elements.get(selector)
  } }
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument
    if (previousConfirm === undefined) delete globalThis.confirm; else globalThis.confirm = previousConfirm
  })
  const idle = { projectId: 7, active: false, kind: null, phase: 'idle', state: 'idle', logs: [], baseline: { ready: false, trackedFiles: 0, scannedAt: null }, plan: null, result: null }
  const panel = new DeploymentPanel({
    api: async (...args) => { requests.push(args); return idle },
    run: action => { pending = action(); return pending },
    isBusy: () => false, message: () => {}
  })
  panel.poll = async () => {}
  panel.schedule = () => {}
  return { panel, elements, requests, idle, wait: () => pending }
}

test('server scan cancellation makes no request; acceptance includes explicit confirmation', async t => {
  const ctx = harness(t)
  await ctx.panel.open(7, { values: {}, errors: {} })
  let prompt
  globalThis.confirm = text => { prompt = text; return false }
  ctx.elements.get('#scanServer').onclick()
  await ctx.wait()
  assert.match(prompt, /Are you sure/)
  assert.match(prompt, /only if you are syncing for the first time/)
  assert.equal(ctx.requests.length, 0)
  globalThis.confirm = () => true
  ctx.elements.get('#scanServer').onclick()
  await ctx.wait()
  assert.deepEqual(ctx.requests[0], ['POST', '/api/projects/7/scan', { dryRun: false, confirmed: true }])
})

test('everyday sync does not prompt or request a server scan', async t => {
  const ctx = harness(t)
  await ctx.panel.open(7, { values: {}, errors: {} })
  globalThis.confirm = () => { throw new Error('Sync must not prompt') }
  ctx.elements.get('#syncFiles').onclick()
  await ctx.wait()
  assert.deepEqual(ctx.requests[0], ['POST', '/api/projects/7/sync', { dryRun: false }])
  assert.match(ctx.elements.get('#syncBaseline').textContent, /No sync records yet/)
})

test('dashboard shows saved baseline and up-to-date status and disables scanning during active operations', async t => {
  const ctx = harness(t)
  await ctx.panel.open(7, { values: {}, errors: {} })
  ctx.panel.render({ ...ctx.idle, baseline: { ready: true, trackedFiles: 12 }, kind: 'sync', phase: 'complete', state: 'success', result: { uploaded: 0, planned: 0, failed: [], bytes: 0, dryRun: false } })
  assert.match(ctx.elements.get('#syncBaseline').textContent, /12 files tracked/)
  assert.equal(ctx.elements.get('#operationStatus').textContent, 'Up to date. No uploads needed.')
  ctx.panel.render({ ...ctx.idle, active: true, kind: 'watch', phase: 'watching' })
  assert.equal(ctx.elements.get('#scanServer').disabled, true)
  ctx.panel.render({ ...ctx.idle, externalOperation: { kind: 'sync' } })
  assert.equal(ctx.elements.get('#scanServer').disabled, true)
})
