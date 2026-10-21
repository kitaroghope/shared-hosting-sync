import chokidar from 'chokidar'
import path from 'node:path'
import { buildPlan, runPlan } from './uploader.js'

/** Debounced serial cycles shared by the CLI and dashboard. */
export class ProjectWatcher {
  constructor(project, matcher, transport, opts = {}) {
    this.project = project
    this.matcher = matcher
    this.transport = transport
    this.debounceMs = opts.debounceMs ?? 400
    this.dryRun = opts.dryRun ?? false
    this.onEvent = opts.onEvent ?? (() => {})
    this.onSettle = opts.onSettle ?? (() => {})
    this.onPlan = opts.onPlan ?? (() => {})
    this.onProgress = opts.onProgress ?? (() => {})
    this.onFileResult = opts.onFileResult ?? (() => {})
    this.timer = null
    this.pending = new Set()
    this.dirty = false
    this.running = false
    this.stopped = false
    this.watcher = null
    this.cycle = Promise.resolve()
    this.ready = Promise.resolve()
    this.cancelReady = () => {}
    this.stats = { cycles: 0, uploaded: 0, failed: 0 }
  }

  start() {
    this.stopped = false
    let resolveReady, rejectReady
    this.ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    this.cancelReady = resolveReady
    this.ready.catch(() => {}) // CLI callers may use events rather than awaiting readiness.
    this.watcher = chokidar.watch(this.project.localPath, {
      ignoreInitial: true, persistent: true,
      ignored: (file) => !this.matcher.shouldWatch(file)
    })
    this.watcher
      .on('add', (file) => this.queue(file, 'added'))
      .on('change', (file) => this.queue(file, 'changed'))
      .on('unlink', (file) => this.queue(file, 'removed'))
      .on('error', (error) => { rejectReady(error); this.onEvent({ type: 'error', message: error.message }) })
      .on('ready', () => {
        resolveReady()
        this.onEvent({ type: 'ready', message: `Watching ${this.project.localPath}` })
      })
    return this
  }

  queue(filePath, kind) {
    if (this.stopped) return
    this.pending.add(filePath)
    this.dirty = true
    this.onEvent({ type: 'change', file: path.relative(this.project.localPath, filePath), kind })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  flush() {
    if (this.stopped || !this.dirty) return this.cycle
    if (this.running) return this.cycle
    clearTimeout(this.timer)
    this.running = true
    this.dirty = false
    this.pending.clear()
    this.cycle = this.runCycle().finally(() => {
      this.running = false
      if (!this.stopped && this.pending.size) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => this.flush(), this.debounceMs)
      }
    })
    return this.cycle
  }

  async runCycle() {
    try {
      const plan = await buildPlan(this.project, this.matcher, this.transport, { onProgress: this.onProgress })
      this.onPlan(plan)
      const result = await runPlan(plan, this.transport, {
        dryRun: this.dryRun, onProgress: this.onProgress, onFileResult: this.onFileResult
      })
      this.stats.cycles++
      if (!this.dryRun) this.stats.uploaded += result.done.length
      this.stats.failed += result.failed.length
      this.onSettle({
        type: 'settle', dryRun: this.dryRun, uploaded: this.dryRun ? 0 : result.done.length,
        planned: result.done.length, failed: result.failed, bytes: result.bytes,
        considered: plan.totalFiles, skipped: plan.skipped.length,
        files: result.done.map((file) => file.rel)
      })
    } catch (error) {
      this.onEvent({ type: 'error', message: error.message })
    }
  }

  async stop() {
    this.stopped = true
    this.cancelReady()
    clearTimeout(this.timer)
    this.pending.clear()
    this.dirty = false
    if (this.watcher) await this.watcher.close()
    await this.cycle
  }
}
