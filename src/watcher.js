import chokidar from 'chokidar'
import path from 'node:path'
import { buildPlan, runPlan } from './uploader.js'

/**
 * Watch a project and push changes.
 * chokidar v5 has no globs — the whole tree is watched and `ignored` filters it.
 * Bursts are debounced so a git checkout or a save-all is one upload, not fifty.
 */
export class ProjectWatcher {
  constructor(project, matcher, transport, opts = {}) {
    this.project = project
    this.matcher = matcher
    this.transport = transport
    this.debounceMs = opts.debounceMs ?? 400
    this.dryRun = opts.dryRun ?? false
    this.onEvent = opts.onEvent ?? (() => {})
    this.onSettle = opts.onSettle ?? (() => {})

    this.timer = null
    this.pending = new Set()
    this.dirty = false
    this.running = false
    this.stopped = false
    this.watcher = null
    this.stats = { cycles: 0, uploaded: 0, failed: 0 }
  }

  start() {
    this.stopped = false
    this.watcher = chokidar.watch(this.project.localPath, {
      ignoreInitial: true,
      persistent: true,
      ignored: (p) => !this.matcher.shouldWatch(p)
    })

    this.watcher
      .on('add', (p) => this.queue(p, 'added'))
      .on('change', (p) => this.queue(p, 'changed'))
      .on('unlink', (p) => this.queue(p, 'removed'))
      .on('error', (e) => this.onEvent({ type: 'error', message: e.message }))

    this.onEvent({ type: 'ready', message: `Watching ${this.project.localPath}` })
    return this
  }

  queue(filePath, kind) {
    if (this.stopped) return
    this.pending.add({ filePath, kind, at: Date.now() })
    this.dirty = true
    this.onEvent({ type: 'change', file: path.relative(this.project.localPath, filePath), kind })

    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
  }

  async flush() {
    if (this.stopped) return
    if (this.running) return // a cycle is in flight; it will pick this batch up
    if (!this.dirty) return

    this.running = true
    this.dirty = false
    const batch = [...this.pending]
    this.pending.clear()

    try {
      const plan = await buildPlan(this.project, this.matcher, this.transport, {})
      const result = await runPlan(plan, this.transport, {
        dryRun: this.dryRun,
        onProgress: () => {}
      })
      this.stats.cycles++
      this.stats.uploaded += result.done.length
      this.stats.failed += result.failed.length
      this.onSettle({
        type: 'settle',
        uploaded: result.done.length,
        failed: result.failed,
        bytes: result.bytes,
        considered: plan.totalFiles,
        skipped: plan.skipped.length,
        files: result.done.map((d) => d.rel)
      })
    } catch (err) {
      this.onEvent({ type: 'error', message: err.message })
    } finally {
      this.running = false
      // A change that landed mid-cycle must not be lost.
      if (this.pending.size) setTimeout(() => this.flush(), this.debounceMs)
    }
  }

  async stop() {
    this.stopped = true
    clearTimeout(this.timer)
    if (this.watcher) await this.watcher.close()
  }
}