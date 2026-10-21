import crypto from 'node:crypto'
import { getProject, setStatus, recordSync } from '../core/projects.js'
import { resolveDeployment } from '../core/deployment.js'
import { createTransport } from '../transport/index.js'
import { buildPlan, runPlan } from '../uploader.js'
import { ProjectWatcher } from '../watcher.js'
import { acquireOperation, assertProjectIdle, projectOperation } from '../core/operationLock.js'

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const stamp = () => new Date().toISOString()

/** One active dashboard operation per project. Network work outlives HTTP requests. */
export class DeploymentService {
  constructor({ connect = createTransport, watcherFactory = (...args) => new ProjectWatcher(...args) } = {}) {
    this.connect = connect
    this.watcherFactory = watcherFactory
    this.records = new Map()
    this.closing = false
  }

  isBusy(id) {
    const record = this.records.get(Number(id))
    return !!(record?.task || record?.watcher || record?.stopping)
  }

  ensureEditable(id) {
    if (id && this.isBusy(id)) throw fail('Finish the current operation or stop watching before changing this project', 409)
    if (id) assertProjectIdle(id)
  }

  activity(id) {
    const project = getProject(Number(id))
    if (!project) throw fail('Project not found', 404)
    const record = this.records.get(project.id)
    const view = record?.view || {
      projectId: project.id, kind: null, state: 'idle', phase: 'idle', logs: [], plan: null,
      result: null, progress: null, lastError: project.lastStatus === 'error' ? project.lastError : null
    }
    return structuredClone({
      ...view, active: this.isBusy(project.id), externalOperation: !this.isBusy(project.id) ? projectOperation(project.id) : null,
      watching: !!(record?.watcher || record?.view.kind === 'watch' && record?.task),
      stopping: !!record?.stopping, lastSyncAt: project.lastSyncAt, lastUploadBytes: project.lastUploadBytes
    })
  }

  clean(record, text) {
    const password = record.context.values.DEVSYNC_PASSWORD
    const value = String(text)
    return (password ? value.split(password).join('[redacted]') : value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  }

  log(record, message, level = 'info') {
    record.view.updatedAt = stamp()
    record.view.logs.push({ at: stamp(), level, message: this.clean(record, message) })
    if (record.view.logs.length > 100) record.view.logs.splice(0, record.view.logs.length - 100)
  }

  progress(record, event) {
    if (!record.stopRequested) record.view.phase = event.phase === 'planning' ? 'planning' : 'uploading'
    record.view.progress = {
      current: event.index, total: event.total, file: this.clean(record, event.item.rel),
      bytes: record.view.progress?.bytes || 0
    }
    record.view.updatedAt = stamp()
  }

  plan(record, plan) {
    record.view.plan = {
      considered: plan.totalFiles, uploadCount: plan.uploads.length, skippedCount: plan.skipped.length,
      bytes: plan.comparedBytes,
      uploads: plan.uploads.slice(0, 200).map(({ rel, remote, bytes }) => ({ rel: this.clean(record, rel), remote: this.clean(record, remote), bytes })),
      skipped: plan.skipped.slice(0, 200).map(({ rel, reason, bytes }) => ({ rel: this.clean(record, rel), reason, bytes })),
      excludedCount: plan.excludedCount || 0,
      excluded: (plan.excluded || []).map(({ rel, reason }) => ({ rel: this.clean(record, rel), reason })),
      blocked: record.context.matcher.blockedSample().map((name) => this.clean(record, name))
    }
    record.view.progress = { current: 0, total: plan.uploads.length, file: null, bytes: 0 }
    this.log(record, `Compared ${plan.totalFiles} files: ${plan.uploads.length} to upload, ${plan.skipped.length} unchanged`)
  }

  fileResult(record, event) {
    record.view.progress = { current: event.index + 1, total: event.total, file: this.clean(record, event.item.rel), bytes: event.bytes }
    this.log(record, event.success ? `${event.dryRun ? 'Would upload' : 'Uploaded'} ${event.item.rel}` : `Failed ${event.item.rel}: ${event.error}`, event.success ? 'info' : 'error')
  }

  complete(record, { done, failed, bytes, dryRun }, watching = false) {
    const failures = failed.slice(0, 200).map((file) => ({ rel: this.clean(record, file.rel), error: this.clean(record, file.error) }))
    record.view.result = { uploaded: dryRun ? 0 : done, planned: done, failed: failures, failedCount: failed.length, bytes: dryRun ? 0 : bytes, dryRun }
    record.view.lastError = failures.length ? failures.slice(0, 5).map((file) => `${file.rel}: ${file.error}`).join('; ') : null
    record.view.state = failures.length ? 'error' : watching ? 'watching' : 'success'
    if (!record.stopRequested) record.view.phase = watching ? 'watching' : 'complete'
    setStatus(record.view.projectId, failures.length ? 'error' : watching ? 'watching' : 'idle', { error: record.view.lastError })
    if (!dryRun && !failures.length) recordSync(record.view.projectId, bytes)
    this.log(record, failures.length ? `${failed.length} file(s) failed; review the errors and retry` : dryRun ? `Preview complete: ${done} file(s), no uploads made` : `Completed: ${done} file(s) uploaded`, failures.length ? 'error' : 'success')
  }

  error(record, error) {
    record.view.lastError = this.clean(record, error.message || error)
    record.view.state = 'error'
    record.view.phase = 'error'
    setStatus(record.view.projectId, 'error', { error: record.view.lastError })
    this.log(record, record.view.lastError, 'error')
  }

  start(id, kind, options = {}) {
    if (this.closing) throw fail('The dashboard is shutting down', 503)
    if (!['preview', 'deploy', 'sync', 'watch'].includes(kind)) throw fail('Unknown deployment operation')
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw fail('Operation options must be an object')
    if (options.dryRun !== undefined && typeof options.dryRun !== 'boolean') throw fail('dryRun must be a boolean')
    if (options.mode !== undefined && !['sync', 'deploy'].includes(options.mode)) throw fail('Preview mode must be sync or deploy')
    const project = getProject(Number(id))
    if (!project) throw fail('Project not found', 404)
    if (this.isBusy(project.id)) throw fail('This project already has an operation running. Stop watching or wait for it to finish.', 409)
    const context = resolveDeployment(project, { useEnvFileEnvironment: false })
    const dryRun = kind === 'preview' || context.dryRun || !!options.dryRun
    const release = acquireOperation(project.id, kind, { creds: context.creds, remotePath: context.project.remotePath })
    const record = {
      context, release, task: null, watcher: null, transport: null, stopping: null, stopRequested: false,
      view: {
        projectId: project.id, operationId: crypto.randomUUID(), kind,
        mode: kind === 'preview' ? options.mode || 'sync' : kind === 'deploy' ? 'deploy' : 'sync',
        state: 'running', phase: 'connecting', dryRun, plan: null, result: null, progress: null,
        logs: [], lastError: null, startedAt: stamp(), updatedAt: stamp(), remotePath: context.project.remotePath
      }
    }
    this.records.set(project.id, record)
    setStatus(project.id, kind === 'preview' ? 'planning' : kind === 'watch' ? 'watching' : 'syncing')
    this.log(record, `Starting ${kind}${dryRun ? ' (preview only)' : ''} → ${context.project.remotePath}`)
    record.task = this.execute(record).catch((error) => this.error(record, error)).finally(async () => {
      if (!record.watcher && record.transport) {
        try { await record.transport.close() } catch (error) { this.error(record, error) }
        record.transport = null
      }
      record.task = null
      if (!record.watcher) record.release()
    })
    return this.activity(project.id)
  }

  async execute(record) {
    record.transport = await this.connect(record.context.creds, undefined, {
      onRetry: ({ attempt, retries }) => this.log(record, `Connection interrupted; reconnecting (${attempt}/${retries})`, 'warning')
    })
    if (record.stopRequested || this.closing) return
    const context = record.context
    if (record.view.kind === 'watch') {
      const watcher = this.watcherFactory(context.project, context.matcher, record.transport, {
        dryRun: record.view.dryRun, debounceMs: context.debounceMs,
        onProgress: (event) => this.progress(record, event),
        onPlan: (plan) => this.plan(record, plan),
        onFileResult: (event) => this.fileResult(record, event),
        onEvent: (event) => {
          if (event.type === 'error') this.error(record, new Error(event.message))
          else if (event.type === 'retry') this.log(record, event.message, 'warning')
          else if (event.type === 'change') this.log(record, event.kind === 'initial' ? 'Initial sync requested' : `${event.kind}: ${event.file}`)
        },
        onSettle: (result) => this.complete(record, {
          done: result.planned, failed: result.failed, bytes: result.bytes, dryRun: result.dryRun
        }, true)
      })
      record.watcher = watcher
      try { watcher.start(); await watcher.ready }
      catch (error) { await watcher.stop(); record.watcher = null; throw error }
      if (record.stopRequested || this.closing) return
      this.log(record, 'Watching started. Syncing current files, then following saves.')
      watcher.queue(context.project.localPath, 'initial')
      await watcher.flush()
      return
    }
    const plan = await buildPlan(context.project, context.matcher, record.transport, {
      force: record.view.mode === 'deploy', onProgress: (event) => this.progress(record, event)
    })
    this.plan(record, plan)
    const result = await runPlan(plan, record.transport, {
      dryRun: record.view.dryRun,
      onProgress: (event) => this.progress(record, event), onFileResult: (event) => this.fileResult(record, event)
    })
    this.complete(record, { done: result.done.length, failed: result.failed, bytes: result.bytes, dryRun: record.view.dryRun })
  }

  stop(id) {
    const record = this.records.get(Number(id))
    if (!record || record.view.kind !== 'watch' || !this.isBusy(id)) throw fail('This project is not being watched', 409)
    if (record.stopping) return this.activity(id)
    record.stopRequested = true
    record.view.state = 'stopping'
    record.view.phase = 'stopping'
    this.log(record, 'Stopping watching; finishing the current batch first')
    record.stopping = (async () => {
      if (record.watcher) await record.watcher.stop()
      if (record.task) await record.task
      if (record.watcher) { await record.watcher.stop(); record.watcher = null }
      if (record.transport) { await record.transport.close(); record.transport = null }
      record.view.state = record.view.lastError ? 'error' : 'stopped'
      record.view.phase = record.view.lastError ? 'error' : 'complete'
      setStatus(record.view.projectId, record.view.lastError ? 'error' : 'idle', { error: record.view.lastError })
      this.log(record, 'Watching stopped', 'success')
    })().catch((error) => this.error(record, error)).finally(() => { record.release(); record.stopping = null })
    return this.activity(id)
  }

  async close() {
    this.closing = true
    for (const [id, record] of this.records) {
      if (record.view.kind === 'watch' && this.isBusy(id)) this.stop(id)
    }
    await Promise.all([...this.records.values()].map((record) => record.stopping || record.task))
  }
}
