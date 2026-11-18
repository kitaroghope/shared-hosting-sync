import { setTimeout as delay } from 'node:timers/promises'
import { isTransient } from './transport/reliable.js'

/** Balance by bytes, then let idle workers steal pending work from other lanes. */
function balance(jobs, count) {
  const lanes = Array.from({ length: count }, () => ({ jobs: [], bytes: 0 }))
  for (const job of [...jobs].sort((a, b) => b.item.bytes - a.item.bytes || a.order - b.order)) {
    const lane = lanes.reduce((best, next) => next.bytes < best.bytes || next.bytes === best.bytes && next.jobs.length < best.jobs.length ? next : best)
    lane.jobs.push(job)
    lane.bytes += job.item.bytes
  }
  return lanes.map(lane => lane.jobs.reverse())
}

/** Each worker owns a connection. A failed connection never strands its files. */
export async function runUploadQueue(items, {
  createWorker, transport, upload, succeeded = async () => {}, concurrency = 3,
  retries = 2, retryDelayMs = 250, onProgress, onFileResult, onRetry, onWorkerState
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Parallel uploads must be an integer from 1 to 8')
  if (!Number.isInteger(retries) || retries < 0 || retries > 5) throw new Error('Upload retries must be an integer from 0 to 5')
  const total = items.length
  let pending = items.map((item, order) => ({ item, order, attempts: 0 }))
  const done = new Map(), failed = new Map()
  let bytes = 0
  let lastError = new Error('No upload connection is available')
  const finish = (job, error, workerId) => {
    if (error) failed.set(job.order, { rel: job.item.rel, error: error.message, retryable: isTransient(error) })
    else { done.set(job.order, { rel: job.item.rel, bytes: job.item.bytes }); bytes += job.item.bytes }
    onFileResult?.({ item: job.item, index: done.size + failed.size - 1, total, workerId,
      success: !error, ...(error ? { error: error.message } : {}), dryRun: false, bytes })
  }
  // Replacement rounds are bounded too: an outage cannot reconnect forever.
  for (let round = 0; pending.length && round <= retries; round++) {
    if (round) await delay(retryDelayMs * 2 ** (round - 1))
    const count = Math.min(concurrency, pending.length)
    const lanes = balance(pending, count)
    const returned = []
    let retryCursor = 0
    let recoverable = false
    const take = (id) => {
      if (lanes[id].length) return lanes[id].pop()
      const donor = lanes.reduce((best, lane) => lane.length > best.length ? lane : best, [])
      if (donor.length) return donor.pop()
      return retryCursor < returned.length ? returned[retryCursor++] : undefined
    }
    const requeue = (job, error, workerId, connectionFailure = false) => {
      lastError = error
      recoverable ||= isTransient(error)
      job.error = error
      returned.push(job)
      onRetry?.({ item: job.item, error: error.message, workerId,
        attempt: connectionFailure ? round + 1 : job.attempts, retries, connectionFailure })
    }
    const workers = await Promise.allSettled(lanes.map(async (_, id) => {
      let client = round === 0 && id === 0 && transport && !transport.closed ? transport : null
      const borrowed = !!client
      let retired = false
      try {
        for (let job; (job = take(id));) {
          if (!client) {
            onWorkerState?.({ workerId: id + 1, state: 'connecting', file: job.item.rel })
            try { client = await createWorker({ workerId: id + 1 }) }
            catch (error) {
              retired = true
              onWorkerState?.({ workerId: id + 1, state: 'failed', file: job.item.rel })
              requeue(job, error, id + 1, true)
              return
            }
          }
          onWorkerState?.({ workerId: id + 1, state: 'uploading', file: job.item.rel })
          job.attempts++
          onProgress?.({ phase: 'upload', item: job.item, index: done.size + failed.size, total, workerId: id + 1, workers: count, attempt: job.attempts })
          try {
            await upload(client, job.item)
          } catch (error) {
            if (isTransient(error)) {
              retired = true
              onWorkerState?.({ workerId: id + 1, state: 'failed', file: job.item.rel })
              recoverable = true
              lastError = error
              if (job.attempts <= retries) requeue(job, error, id + 1)
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
        if (client && (!borrowed || retired)) await client.close().catch(() => {})
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
  return { done: ordered(done), failed: ordered(failed), bytes }
}
