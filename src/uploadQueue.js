import { setTimeout as delay } from 'node:timers/promises'
import { isTransient } from './transport/reliable.js'

const byName = (a, b) => a < b ? -1 : a > b ? 1 : 0
const byFolder = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = byName(a[i], b[i])
    if (order) return order
  }
  return a.length - b.length
}
const hierarchy = (a, b) => byFolder(a.folder, b.folder) ||
  byName(a.item.rel, b.item.rel) || a.order - b.order

/** Keep folders together, balancing bytes across connections without randomizing traversal. */
function balance(jobs, count) {
  const lanes = Array.from({ length: count }, () => ({ jobs: [], bytes: 0 }))
  const folders = new Map()
  for (const job of jobs) {
    const key = job.folder.join('/')
    if (!folders.has(key)) folders.set(key, { jobs: [], bytes: 0 })
    const group = folders.get(key)
    group.jobs.push(job)
    group.bytes += job.item.bytes
  }

  // If there aren't enough folders for the available workers, split the largest
  // folder batches until each worker has some work.
  const groups = [...folders.values()]
  if (groups.length === 1 && count > 1) {
    const ordered = [...jobs].sort((a, b) => b.item.bytes - a.item.bytes || hierarchy(a, b))
    for (const job of ordered) {
      const lane = lanes.reduce((best, next) => next.bytes < best.bytes || next.bytes === best.bytes && next.jobs.length < best.jobs.length ? next : best)
      lane.jobs.push(job)
      lane.bytes += job.item.bytes
    }
    return lanes.map(lane => lane.jobs.sort(hierarchy).reverse())
  }
  while (groups.length < count) {
    const group = groups.reduce((best, next) => next.jobs.length > best.jobs.length ? next : best)
    group.jobs.sort((a, b) => b.item.bytes - a.item.bytes || hierarchy(a, b))
    const parts = [{ jobs: [], bytes: 0 }, { jobs: [], bytes: 0 }]
    for (const job of group.jobs) {
      const part = parts[0].bytes < parts[1].bytes || parts[0].bytes === parts[1].bytes && parts[0].jobs.length <= parts[1].jobs.length ? parts[0] : parts[1]
      part.jobs.push(job)
      part.bytes += job.item.bytes
    }
    groups.splice(groups.indexOf(group), 1, ...parts)
  }
  for (const group of groups.sort((a, b) => b.bytes - a.bytes || byFolder(a.jobs[0].folder, b.jobs[0].folder))) {
    const lane = lanes.reduce((best, next) => next.bytes < best.bytes || next.bytes === best.bytes && next.jobs.length < best.jobs.length ? next : best)
    for (const job of group.jobs) lane.jobs.push(job)
    lane.bytes += group.bytes
  }
  const ordered = lanes.map(lane => lane.jobs.sort(hierarchy))
  return ordered.sort((a, b) => hierarchy(a[0], b[0])).map(lane => lane.reverse())
}

// Reply codes alone also cover outages and invalid credentials.
const isConnectionLimit = error => /too many (?:concurrent |simultaneous |active )?(?:connections|sessions|clients|users)|(?:connections?|sessions?|clients?) limit|limit (?:of|on) (?:[0-9]+ )?(?:connections|sessions|clients)|maximum (?:number of )?(?:concurrent |simultaneous )?(?:connections|sessions|clients)/i.test(error?.message || '')

/** Each worker owns a connection. A failed connection never strands its files. */
export async function runUploadQueue(items, {
  createWorker, transport, upload, succeeded = async () => {}, concurrency = 3,
  retries = 2, retryDelayMs = 250, onProgress, onFileResult, onRetry, onWorkerState
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Parallel uploads must be an integer from 1 to 8')
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error('Upload retries must be an integer from 0 to 5')
  const total = items.length
  let pending = items.map((item, order) => ({ item, order, attempts: 0, folder: item.rel.split('/').slice(0, -1) }))
  const done = new Map(), failed = new Map()
  let bytes = 0
  let ceiling = concurrency, connectionLimit
  let reusable = transport
  let lastError = new Error('No upload connection is available')
  const finish = (job, error, workerId) => {
    if (error) failed.set(job.order, { rel: job.item.rel, error: error.message, retryable: !isConnectionLimit(error) && isTransient(error) })
    else { done.set(job.order, { rel: job.item.rel, bytes: job.item.bytes }); bytes += job.item.bytes }
    onFileResult?.({ item: job.item, index: done.size + failed.size - 1, total, workerId,
      success: !error, ...(error ? { error: error.message } : {}), dryRun: false, bytes })
  }
  // Replacement rounds are bounded too: an outage cannot reconnect forever.
  for (let round = 0; pending.length && round <= retries; round++) {
    if (round) await delay(retryDelayMs * 2 ** (round - 1))
    const count = Math.min(ceiling, pending.length)
    const lanes = balance(pending, count)
    const returned = []
    let retryCursor = 0
    let recoverable = false
    let opening = Promise.resolve()
    let activeConnections = 0
    let stopOpening, loginFallback, transferFallback
    const lowerLimit = limit => {
      ceiling = Math.min(ceiling, limit)
      connectionLimit = ceiling
    }
    // Ramp up one login at a time. Stop expanding after the first refused login.
    const open = (id, borrowed) => {
      const attempt = opening.then(async () => {
        if (borrowed) { activeConnections++; return borrowed }
        if (stopOpening) return null
        const activeAtLogin = activeConnections
        try {
          const client = await createWorker({ workerId: id + 1 })
          activeConnections++
          return client
        } catch (error) {
          stopOpening = error
          if (isConnectionLimit(error) && activeAtLogin > 0) {
            lowerLimit(activeAtLogin)
            loginFallback = connectionLimit
          }
          throw error
        }
      })
      opening = attempt.catch(() => {})
      return attempt
    }
    const take = (id) => {
      if (lanes[id].length) return lanes[id].pop()
      const donor = lanes.reduce((best, lane) => lane.length > best.length ? lane : best, [])
      if (donor.length) return donor.pop()
      return retryCursor < returned.length ? returned[retryCursor++] : undefined
    }
    const requeue = (job, error, workerId, connectionFailure = false, fallbackLimit) => {
      lastError = error
      recoverable ||= isConnectionLimit(error) ? fallbackLimit !== undefined : isTransient(error)
      job.error = error
      returned.push(job)
      onRetry?.({ item: job.item, error: error.message, workerId,
        attempt: connectionFailure ? round + 1 : job.attempts, retries, connectionFailure, connectionLimit: fallbackLimit })
    }
    const workers = await Promise.allSettled(lanes.map(async (_, id) => {
      let client = id === 0 && reusable && !reusable.closed ? reusable : null
      const borrowed = !!client
      if (borrowed) await open(id, client)
      let retired = false
      try {
        for (let job; (job = take(id));) {
          if (!client) {
            onWorkerState?.({ workerId: id + 1, state: 'connecting', file: job.item.rel })
            try { client = await open(id, null) }
            catch (error) {
              retired = true
              onWorkerState?.({ workerId: id + 1, state: 'failed', file: job.item.rel })
              requeue(job, error, id + 1, true, loginFallback)
              return
            }
            if (!client) {
              retired = true
              lanes[id].push(job)
              onWorkerState?.({ workerId: id + 1, state: 'complete', file: null })
              return
            }
          }
          onWorkerState?.({ workerId: id + 1, state: 'uploading', file: job.item.rel })
          job.attempts++
          onProgress?.({ phase: 'upload', item: job.item, index: done.size + failed.size, total, workerId: id + 1, workers: count, attempt: job.attempts })
          try {
            await upload(client, job.item)
          } catch (error) {
            const limited = isConnectionLimit(error)
            if (limited || isTransient(error)) {
              if (limited && transferFallback === undefined) {
                stopOpening = error
                lowerLimit(Math.max(1, activeConnections - 1))
                transferFallback = connectionLimit
              }
              retired = true
              onWorkerState?.({ workerId: id + 1, state: 'failed', file: job.item.rel })
              recoverable ||= !limited || count > 1
              lastError = error
              if (job.attempts <= retries && (!limited || count > 1)) requeue(job, error, id + 1, false, limited ? transferFallback : undefined)
              else finish(job, error, id + 1)
              return
            }
            finish(job, error, id + 1)
            continue
          }
          try { await succeeded(job.item) }
          catch (error) { finish(job, error, id + 1); continue }
          finish(job, null, id + 1)
        }
      } finally {
        if (client && (!borrowed || retired)) {
          if (borrowed) reusable = null
          try { await client.close() } catch {}
          finally { activeConnections-- }
        }
        if (!retired) onWorkerState?.({ workerId: id + 1, state: 'complete', file: null })
      }
    }))
    const crashed = workers.find(worker => worker.status === 'rejected')
    if (crashed) throw crashed.reason
    pending = [...lanes.flat(), ...returned.slice(retryCursor)]
    if (!recoverable) break
  }
  for (const job of pending) finish(job, job.error || lastError)
  const ordered = map => [...map].sort(([a], [b]) => a - b).map(([, value]) => value)
  return { done: ordered(done), failed: ordered(failed), bytes, ...(connectionLimit === undefined ? {} : { connectionLimit }) }
}
