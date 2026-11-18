import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { runUploadQueue } from '../src/uploadQueue.js'
import { runPlan, uploadOne } from '../src/uploader.js'
import { ReliableTransport } from '../src/transport/reliable.js'

const jobs = (sizes = [8, 7, 6, 5, 4, 3]) => sizes.map((bytes, i) => ({ rel: `file-${i}`, bytes, remote: `/site/file-${i}`, dirs: ['/site'] }))
const lost = () => Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
function factory() {
  const clients = []
  return { clients, createWorker: async ({ workerId }) => {
    const client = { id: workerId, closed: false, close: async () => { client.closed = true } }
    clients.push(client)
    return client
  } }
}

test('three independent workers balance bytes and report completed files exactly once', async () => {
  const pool = factory(), totals = new Map(), inUse = new Set(), progress = []
  let active = 0, maximum = 0
  const result = await runUploadQueue(jobs(), {
    ...pool,
    upload: async (client, item) => {
      assert.equal(inUse.has(client), false, 'one upload at a time on each connection')
      inUse.add(client); active++; maximum = Math.max(maximum, active)
      totals.set(client.id, (totals.get(client.id) || 0) + item.bytes)
      await delay(4)
      active--; inUse.delete(client)
    },
    onFileResult: event => progress.push([event.index, event.bytes])
  })
  assert.equal(maximum, 3)
  assert.deepEqual([...totals.values()], [11, 11, 11])
  assert.equal(result.done.length, 6)
  assert.equal(result.failed.length, 0)
  assert.equal(result.bytes, 33)
  assert.deepEqual(progress.map(([index]) => index), [0, 1, 2, 3, 4, 5])
  assert.ok(progress.every(([, bytes], i) => !i || bytes >= progress[i - 1][1]))
  assert.equal(pool.clients.length, 3)
  assert.ok(pool.clients.every(client => client.closed))
})

test('a disconnected lane returns its file and all remaining work to healthy lanes', async () => {
  const pool = factory(), attempts = [], retries = [], successful = []
  const result = await runUploadQueue(jobs(), {
    ...pool, retryDelayMs: 1,
    upload: async (client, item) => {
      attempts.push({ client: client.id, file: item.rel })
      if (client.id === 1) throw lost()
      await delay(3)
      successful.push(item.rel)
    },
    onRetry: event => retries.push(event)
  })
  assert.equal(result.failed.length, 0)
  assert.equal(new Set(successful).size, 6)
  assert.equal(successful.length, 6)
  const interrupted = attempts.find(item => item.client === 1)
  assert.ok(attempts.some(item => item.file === interrupted.file && item.client !== 1))
  assert.equal(retries.length, 1)
  assert.ok(pool.clients.every(client => client.closed))
})

test('a connection limit on one worker does not strand files when another can connect', async () => {
  let connections = 0
  const result = await runUploadQueue(jobs(), {
    createWorker: async ({ workerId }) => {
      connections++
      if (workerId === 3) throw Object.assign(new Error('connection limit'), { code: 530 })
      return { close: async () => {} }
    },
    upload: async () => { await delay(2) }
  })
  assert.equal(connections, 3)
  assert.equal(result.done.length, 6)
  assert.equal(result.failed.length, 0)
})

test('outages have bounded reconnects and leave every file pending as a failure', async () => {
  let connections = 0, results = 0
  const result = await runUploadQueue(jobs([1, 1, 1, 1, 1, 1, 1]), {
    createWorker: async () => { connections++; throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' }) },
    upload: async () => { throw new Error('unreachable') }, retryDelayMs: 1,
    onFileResult: () => results++
  })
  assert.equal(connections, 3)
  assert.equal(result.failed.length, 7)
  assert.equal(results, 7)
  assert.equal(result.done.length, 0)
  assert.ok(result.failed.every(file => file.retryable))
})

test('permanent file errors are final; interrupted files get at most three upload attempts', async () => {
  const attempts = new Map(), pool = factory()
  const result = await runUploadQueue(jobs(), {
    ...pool, retryDelayMs: 1,
    upload: async (client, item) => {
      attempts.set(item.rel, (attempts.get(item.rel) || 0) + 1)
      if (item.rel === 'file-0') throw new Error('permission denied')
      if (item.rel === 'file-1') throw lost()
      await delay(2)
    }
  })
  assert.equal(attempts.get('file-0'), 1)
  assert.equal(attempts.get('file-1'), 3)
  assert.equal(result.done.length, 4)
  assert.equal(result.failed.length, 2)
  assert.equal(result.failed[0].retryable, false)
  assert.equal(result.failed[1].retryable, true)
  assert.ok(pool.clients.every(client => client.closed))
})

test('an uncertain rename retries the whole file on a replacement connection', async () => {
  let connections = 0, puts = 0, renames = 0
  const files = new Map()
  const result = await runUploadQueue(jobs([4]), {
    createWorker: async () => {
      connections++
      return new ReliableTransport(async () => ({
        ensureDir: async () => {}, delete: async file => files.delete(file), close: async () => {},
        put: async (local, file) => { puts++; files.set(file, 'data') },
        rename: async (from, to) => {
          files.set(to, files.get(from)); files.delete(from)
          if (++renames === 1) throw lost()
        }
      }), { retries: 2, retryDelayMs: 1 }).connect()
    },
    upload: (client, item) => uploadOne(client, item, { retries: 0 }), retryDelayMs: 1
  })
  assert.equal(connections, 2)
  assert.equal(puts, 2)
  assert.equal(result.done.length, 1)
  assert.deepEqual([...files], [['/site/file-0', 'data']])
})

test('preview and empty batches open no connections; concurrency can be limited to one', async () => {
  const createWorker = async () => { throw new Error('Must not connect') }
  const preview = await runPlan({ uploads: jobs([1, 1]) }, null, { dryRun: true, createWorker })
  assert.equal(preview.done.length, 2)
  assert.equal((await runPlan({ uploads: [] }, null, { createWorker })).done.length, 0)
  const pool = factory()
  let active = 0, maximum = 0
  await runUploadQueue(jobs(), { ...pool, concurrency: 1, upload: async () => { active++; maximum = Math.max(maximum, active); await delay(1); active-- } })
  assert.equal(maximum, 1)
  assert.equal(pool.clients.length, 1)
  await assert.rejects(runUploadQueue([], { concurrency: 0 }), /Parallel uploads/)
})

test('successful borrowed watcher connection stays open and extra connections are released', async () => {
  const pool = factory(), borrowed = { closed: false, close: async () => { borrowed.closed = true } }
  await runUploadQueue(jobs(), { ...pool, transport: borrowed, upload: async () => delay(2) })
  assert.equal(borrowed.closed, false)
  assert.equal(pool.clients.length, 2)
  assert.ok(pool.clients.every(client => client.closed))
})

test('an unexpected progress callback error drains other connections before rejecting', async () => {
  const pool = factory()
  let finished = 0
  await assert.rejects(runUploadQueue(jobs([3, 2, 1]), {
    ...pool,
    upload: async () => { await delay(10); finished++ },
    onProgress: event => { if (event.workerId === 1) throw new Error('progress callback failed') }
  }), /progress callback failed/)
  assert.equal(finished, 2)
  assert.ok(pool.clients.every(client => client.closed))
})

test('a sync-record error does not retry a completed remote upload', async () => {
  const pool = factory()
  let uploads = 0
  const result = await runUploadQueue(jobs([1]), {
    ...pool,
    upload: async () => { uploads++ },
    succeeded: async () => { throw lost() }
  })
  assert.equal(uploads, 1)
  assert.equal(result.failed.length, 1)
})

for (const limit of [1, 2]) {
  test(`an explicit ${limit}-connection cap stops further probes and healthy workers drain the batch`, async () => {
    let attempts = 0, active = 0, simultaneousLogins = 0
    const { promise: limitReached, resolve: releaseUploads } = Promise.withResolvers()
    const result = await runUploadQueue(jobs(), {
      concurrency: 8,
      createWorker: async () => {
        assert.equal(++simultaneousLogins, 1)
        attempts++
        await delay(1)
        simultaneousLogins--
        if (active >= limit) {
          releaseUploads()
          throw Object.assign(new Error('Too many simultaneous connections'), { code: 421 })
        }
        active++
        return { close: async () => { active-- } }
      },
      upload: async () => { await limitReached; await delay(1) }
    })
    assert.equal(attempts, limit + 1)
    assert.equal(result.connectionLimit, limit)
    assert.equal(result.done.length, 6)
    assert.deepEqual(result.failed, [])
    assert.equal(active, 0)
  })
}

test('invalid credentials stop after one login rather than probing other workers', async () => {
  let attempts = 0
  const result = await runUploadQueue(jobs(), {
    createWorker: async () => { attempts++; throw Object.assign(new Error('Login incorrect'), { code: 530 }) },
    upload: async () => assert.fail('cannot upload without a login')
  })
  assert.equal(attempts, 1)
  assert.equal(result.connectionLimit, undefined)
  assert.equal(result.failed.length, 6)
  assert.ok(result.failed.every(file => !file.retryable))
})

test('one queue follows the full folder hierarchy before moving to the next sibling', async () => {
  const files = ['beta/a.txt', 'alpha/nested/a.txt', 'z-root.txt', 'alpha/z.txt', 'alpha/a.txt', 'alpha-2/a.txt', 'a-root.txt']
  const pool = factory(), seen = []
  const result = await runUploadQueue(files.map((rel, i) => ({ rel, bytes: i + 1 })), {
    ...pool, concurrency: 1, upload: async (_, item) => seen.push(item.rel)
  })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(seen, ['a-root.txt', 'z-root.txt', 'alpha/a.txt', 'alpha/z.txt', 'alpha/nested/a.txt', 'alpha-2/a.txt', 'beta/a.txt'])
})

test('parallel queues keep balanced folders together and order their filenames', async () => {
  const files = ['b/z.txt', 'c/z.txt', 'a/z.txt', 'b/a.txt', 'a/a.txt', 'c/a.txt']
  const pool = factory(), seen = new Map()
  const result = await runUploadQueue(files.map(rel => ({ rel, bytes: 1 })), {
    ...pool, upload: async (client, item) => {
      if (!seen.has(client.id)) seen.set(client.id, [])
      seen.get(client.id).push(item.rel)
      await delay(5)
    }
  })
  assert.deepEqual(result.failed, [])
  assert.deepEqual([...seen.values()], [['a/a.txt', 'a/z.txt'], ['b/a.txt', 'b/z.txt'], ['c/a.txt', 'c/z.txt']])
})

test('retry rounds reuse the idle watch connection instead of opening an extra session', async () => {
  const borrowed = { id: 1, close: async () => assert.fail('watch owns this connection') }
  let opened = 0
  const attempts = []
  const result = await runUploadQueue(jobs([2, 1]), {
    transport: borrowed,
    concurrency: 2,
    retryDelayMs: 1,
    createWorker: async () => {
      assert.equal(++opened, 1, 'retry must reuse the already-open watch session')
      return { id: 2, close: async () => {} }
    },
    upload: async (client, item) => {
      attempts.push([client.id, item.rel])
      if (client.id === 2) { await delay(5); throw lost() }
    }
  })
  assert.deepEqual(result.failed, [])
  assert.deepEqual(attempts, [[1, 'file-0'], [2, 'file-1'], [1, 'file-1']])
})
