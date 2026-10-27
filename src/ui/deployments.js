const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const bytes = (value = 0) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(2)} MB`

export class DeploymentPanel {
  constructor({ api, run, isBusy, message }) {
    this.api = api
    this.run = run
    this.isBusy = isBusy
    this.message = message
    this.generation = 0
  }

  close() {
    clearTimeout(this.timer)
    this.generation++
    this.projectId = null
  }

  async open(projectId, configuration) {
    this.close()
    this.projectId = projectId
    this.lastPlan = null
    this.lastLogs = null
    this.settingsDryRun = ['true', '1', true].includes(configuration.values.DEVSYNC_DRY_RUN)
    this.configured = !Object.keys(configuration.errors).length
    const element = document.querySelector('#deploymentPanel')
    element.innerHTML = `<h2>Deploy your project</h2><p class="muted">Sync checks local file sizes and timestamps against your saved sync records. Deploy uploads all eligible files. Server files are never deleted.</p><div class="operation-options"><div class="field"><label for="previewMode">Preview mode</label><select id="previewMode"><option value="sync">Changed files (sync)</option><option value="deploy">All eligible files (deploy)</option></select></div><label class="check"><input id="operationDryRun" type="checkbox" ${this.settingsDryRun ? 'checked disabled' : ''}>Preview only for deploy, sync and watch</label></div>${this.settingsDryRun ? '<p class="help">Preview-only mode is enabled in this project’s settings.</p>' : ''}<div class="operation-actions"><button class="secondary" id="previewUploads">Preview uploads</button><button class="secondary" id="deployFiles">Deploy all files</button><button class="primary" id="syncFiles">Sync changes</button><button class="secondary" id="startWatching">Start watching</button><button class="danger" id="stopWatching" hidden>Stop watching</button></div><div class="sync-baseline"><p id="syncBaseline" class="help"></p><button class="secondary" id="scanServer">Scan server / Initial sync</button><p class="help">Use this button only if you are syncing for the first time. It reads server files and saves matches without uploading. After that, use Sync changes.</p></div><p class="help">Watch syncs current files first, then follows saves while devsync is running. Stop waits for the current batch to finish.</p><div id="operationStatus" class="notice" role="status"></div><div class="operation-progress"><progress id="uploadProgress" max="1" value="0" aria-label="Operation progress"></progress><span id="progressText" class="help"></span></div><div id="operationResult"></div><div id="operationPlan"></div><details id="activityDetails"><summary>Activity log</summary><ol class="operation-log" id="operationLogs"><li>No operations yet.</li></ol></details><p id="lastSync" class="help"></p>`
    document.querySelector('#previewUploads').onclick = () => this.start('preview')
    document.querySelector('#deployFiles').onclick = () => this.start('deploy')
    document.querySelector('#syncFiles').onclick = () => this.start('sync')
    document.querySelector('#scanServer').onclick = () => this.start('scan')
    document.querySelector('#startWatching').onclick = () => this.start('watch')
    document.querySelector('#stopWatching').onclick = () => this.run(async () => {
      this.message('')
      this.render(await this.api('POST', `/api/projects/${this.projectId}/watch/stop`, {}))
      this.schedule(250)
    })
    await this.poll(this.generation)
  }

  start(kind) {
    if (kind === 'scan' && !confirm('Are you sure?\n\nUse this button only if you are syncing for the first time.\n\nThis reads server files to rebuild your sync records. No files are uploaded or deleted. Use Sync changes for everyday uploads.')) return
    this.run(async () => {
      this.message('')
      const options = {
        dryRun: document.querySelector('#operationDryRun').checked,
        ...(kind === 'scan' ? { confirmed: true } : {}),
        ...(kind === 'preview' ? { mode: document.querySelector('#previewMode').value } : {})
      }
      const result = await this.api('POST', `/api/projects/${this.projectId}/${kind}`, options)
      document.querySelector('#activityDetails').open = true
      this.render(result)
      this.schedule(250)
    })
  }

  schedule(delay) {
    clearTimeout(this.timer)
    const generation = this.generation
    this.timer = setTimeout(() => this.poll(generation), delay)
  }

  async poll(generation) {
    if (!this.projectId || generation !== this.generation) return
    try {
      const result = await this.api('GET', `/api/projects/${this.projectId}/activity`)
      if (generation !== this.generation || !document.querySelector('#deploymentPanel')) return
      this.render(result)
      this.schedule(result.active ? 700 : 2500)
    } catch (error) {
      if (generation !== this.generation) return
      const status = document.querySelector('#operationStatus')
      if (status) { status.textContent = `Could not refresh activity: ${error.message}`; status.className = 'notice error' }
      this.schedule(2500)
    }
  }

  disable(id, disabled) {
    const element = document.querySelector(`#${id}`)
    if (!element) return
    if (this.isBusy()) { element.dataset.beforeBusy = String(disabled); element.disabled = true }
    else element.disabled = disabled
  }

  render(activity) {
    if (!this.projectId || activity.projectId !== this.projectId) return
    const busy = activity.active || !!activity.externalOperation
    for (const id of ['previewUploads', 'deployFiles', 'syncFiles', 'startWatching', 'scanServer', 'previewMode']) this.disable(id, busy || !this.configured)
    this.disable('operationDryRun', busy || this.settingsDryRun || !this.configured)
    for (const id of ['editProject', 'testProject', 'deleteProject']) this.disable(id, busy)
    const startingWatch = activity.kind === 'watch' && busy
    document.querySelector('#startWatching').hidden = startingWatch
    document.querySelector('#stopWatching').hidden = !startingWatch
    this.disable('stopWatching', !startingWatch || activity.stopping)
    const status = document.querySelector('#operationStatus')
    const phases = { connecting: 'Connecting to hosting…', planning: activity.kind === 'scan' ? 'Scanning server files to build sync records…' : 'Checking local files against saved sync records…', uploading: activity.dryRun ? 'Building the preview…' : 'Uploading files…', watching: 'Watching for local saves.', stopping: 'Stopping watching — finishing the current batch…', complete: 'Operation complete.', error: 'Operation needs attention.', idle: 'Preview uploads before deploying, or start a sync when you are ready.' }
    let text = activity.stopping ? phases.stopping : phases[activity.phase] || phases.idle
    if (activity.state === 'success') text = activity.dryRun ? 'Preview complete. No files were uploaded.' : activity.result?.uploaded === 0 ? 'Up to date. No uploads needed.' : 'Upload complete.'
    if (activity.kind === 'scan' && activity.state === 'success') text = `Server scan complete. ${activity.result?.matched || 0} files matched; ${activity.plan?.uploadCount || 0} new or changed. Use Sync changes to upload them.`
    if (activity.state === 'stopped') text = 'Watching stopped. No further saves will be uploaded.'
    if (activity.externalOperation) text = 'An operation is running in another CLI or dashboard. Stop it there or wait for it to finish.'
    if (activity.lastError) text = `${activity.watching && !activity.stopping ? 'Watching is still active; the last sync failed. ' : ''}${activity.lastError} Check the connection and server folder permissions, then retry.`
    if (!this.configured && !busy) text = 'Complete project setup before previewing or uploading.'
    if (status.textContent !== text) status.textContent = text
    status.className = `notice ${activity.lastError ? 'error' : activity.state === 'success' || activity.state === 'watching' || activity.state === 'stopped' ? 'success' : 'info'}`
    const progress = activity.progress
    const meter = document.querySelector('#uploadProgress')
    meter.max = Math.max(1, progress?.total || 0)
    meter.value = progress?.current || 0
    document.querySelector('#progressText').textContent = progress ? `${progress.current} / ${progress.total} files${progress.file ? ' · ' + progress.file : ''}${progress.bytes ? ' · ' + bytes(progress.bytes) : ''}` : ''
    const baseline = activity.baseline
    document.querySelector('#syncBaseline').textContent = baseline?.ready
      ? `${baseline.trackedFiles} files tracked for this source and destination. Sync changes uses these records.${baseline.scannedAt ? ' Last server scan: ' + new Date(baseline.scannedAt).toLocaleString() + '.' : ''}`
      : 'No sync records yet for this source and destination. If files are already on your server, scan once to avoid re-uploading matches. Otherwise, Sync changes uploads all eligible files and starts tracking them.'
    const result = activity.result
    document.querySelector('#operationResult').innerHTML = result?.scanned !== undefined ? `<div class="operation-metrics"><div><strong>${result.scanned}</strong><span>files scanned</span></div><div><strong>${result.matched}</strong><span>matching files</span></div><div><strong>${result.planned}</strong><span>pending upload</span></div></div>` : result ? `<div class="operation-metrics"><div><strong>${result.dryRun ? result.planned : result.uploaded}</strong><span>${result.dryRun ? 'would upload' : 'uploaded'}</span></div><div><strong>${result.failedCount ?? result.failed.length}</strong><span>failed</span></div><div><strong>${bytes(result.bytes)}</strong><span>uploaded</span></div></div>${result.failed.length ? `<details open><summary>Files needing attention</summary><ul class="errors">${result.failed.map((file) => `<li>${esc(file.rel)} — ${esc(file.error)}</li>`).join('')}</ul></details>` : ''}` : ''
    this.renderPlan(activity.plan)
    const logSignature = JSON.stringify(activity.logs)
    if (logSignature !== this.lastLogs) {
      const log = document.querySelector('#operationLogs')
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30
      log.innerHTML = activity.logs.length ? activity.logs.map((entry) => `<li class="log-${esc(entry.level)}"><time>${esc(new Date(entry.at).toLocaleTimeString())}</time> ${esc(entry.message)}</li>`).join('') : '<li>No operations yet.</li>'
      if (atBottom) log.scrollTop = log.scrollHeight
      this.lastLogs = logSignature
    }
    document.querySelector('#lastSync').textContent = activity.lastSyncAt ? `Last successful sync: ${new Date(activity.lastSyncAt).toLocaleString()} · ${bytes(activity.lastUploadBytes)}` : 'No successful sync recorded yet.'
  }

  renderPlan(plan) {
    const signature = JSON.stringify(plan)
    if (signature === this.lastPlan) return
    this.lastPlan = signature
    const element = document.querySelector('#operationPlan')
    if (!plan) { element.innerHTML = ''; return }
    element.innerHTML = `<div class="operation-metrics"><div><strong>${plan.considered}</strong><span>eligible files</span></div><div><strong>${plan.uploadCount}</strong><span>selected to upload</span></div><div><strong>${plan.skippedCount}</strong><span>unchanged</span></div><div><strong>${bytes(plan.bytes)}</strong><span>selected size</span></div></div><details open><summary>Selected files (${plan.uploadCount})</summary>${plan.uploads.length ? `<div class="plan-table-wrap"><table class="plan-table"><thead><tr><th>File</th><th>Server destination</th><th>Size</th></tr></thead><tbody>${plan.uploads.map((file) => `<tr><td>${esc(file.rel)}</td><td>${esc(file.remote)}</td><td>${bytes(file.bytes)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="help">No files need uploading.</p>'}${plan.uploadCount > plan.uploads.length ? '<p class="help">Showing the first 200 selected files.</p>' : ''}</details><details><summary>Unchanged files (${plan.skippedCount})</summary><ul class="file-list">${plan.skipped.map((file) => `<li>${esc(file.rel)} <span class="muted">· ${esc(file.reason)}</span></li>`).join('') || '<li>No unchanged files.</li>'}</ul>${plan.skippedCount > plan.skipped.length ? '<p class="help">Showing the first 200 unchanged files.</p>' : ''}</details><details><summary>Excluded entries (${plan.excludedCount})</summary><ul class="file-list">${plan.excluded.map((file) => `<li>${esc(file.rel)} <span class="muted">· ${esc(file.reason)}</span></li>`).join('') || '<li>No excluded entries.</li>'}</ul><p class="help">Excluded directories represent their entire contents.${plan.excludedCount > plan.excluded.length ? ' Showing the first 200 entries.' : ''}</p></details><p class="help">Sync checks current local metadata against saved records; it does not check for changes made directly on the server. A preview never changes sync records or uploads files.</p>`
  }
}
