import { setTimeout as delay } from 'node:timers/promises'

export function isTransient(error) {
  if (['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTCONN', 'EAI_AGAIN'].includes(error?.code)) return true
  if ([421, 425, 426].includes(Number(error?.code))) return true
  return /connection (?:closed|lost|reset|ended)|not connected|no sftp connection|socket (?:closed|hang up|not writable)|timed? ?out|client is closed/i.test(error?.message || '')
}

/** Retry reads and complete atomic uploads, never an ambiguous rename alone. */
export class ReliableTransport {
  constructor(connect, { retries = 2, retryDelayMs = 250, onRetry = () => {} } = {}) {
    this.connectRaw = connect
    this.retries = retries
    this.retryDelayMs = retryDelayMs
    this.onRetry = onRetry
    this.raw = null
    this.closed = false
  }

  async connect() { await this.transaction(async () => {}); return this }

  async transaction(action) {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error('Transport has been closed')
      try {
        this.raw ||= await this.connectRaw()
        return await action(this.raw)
      } catch (error) {
        if (!isTransient(error) || attempt >= this.retries || this.closed) throw error
        this.onRetry({ attempt: attempt + 1, retries: this.retries })
        if (this.raw) await this.raw.close().catch(() => {})
        this.raw = null
        await delay(this.retryDelayMs * 2 ** attempt)
      }
    }
  }

  async close() {
    this.closed = true
    if (this.raw) await this.raw.close()
    this.raw = null
  }
}

for (const method of ['list', 'stat', 'checksum', 'exists', 'ensureDir', 'delete']) {
  ReliableTransport.prototype[method] = function (...args) { return this.transaction((raw) => raw[method](...args)) }
}
for (const method of ['put', 'rename']) {
  ReliableTransport.prototype[method] = function (...args) { return this.raw[method](...args) }
}
