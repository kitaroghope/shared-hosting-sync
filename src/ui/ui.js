const $ = (selector) => document.querySelector(selector)
const $$ = (selector) => [...document.querySelectorAll(selector)]
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const state = { projects: [], current: null, draft: null, step: 0, busy: false, local: null, remote: null, verifiedPath: null, fileOverrides: false }
let session
let renderedStep = 0

async function api(method, url, body) {
  if (!session) {
    const response = await fetch('/api/session')
    const data = await response.json()
    if (!response.ok || !data.token) throw new Error(data.error || 'Could not start a local session')
    session = data.token
  }
  const response = await fetch(url, {
    method, headers: { 'content-type': 'application/json', 'x-devsync-session': session },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Could not complete that operation')
  return data
}

function message(text, kind = 'info') {
  const box = $('#message')
  if (!box) return
  box.textContent = text
  box.className = `notice ${kind}`
  box.setAttribute('role', kind === 'error' ? 'alert' : 'status')
}

function setBusy(busy) {
  $('#pane').setAttribute('aria-busy', String(busy))
  $$('button,input,select').forEach((element) => {
    if (busy) {
      if (element.dataset.beforeBusy === undefined) element.dataset.beforeBusy = String(element.disabled)
      element.disabled = true
    } else if (element.dataset.beforeBusy !== undefined) {
      element.disabled = element.dataset.beforeBusy === 'true'
      delete element.dataset.beforeBusy
    }
  })
}

async function act(action, text = '') {
  if (state.busy) return
  state.busy = true
  setBusy(true)
  if (text) message(text)
  try { await action() }
  catch (error) { message(error.message, 'error') }
  finally { state.busy = false; setBusy(false) }
}

async function refreshProjects() {
  state.projects = (await api('GET', '/api/projects')).projects
  $('#projectCount').textContent = state.projects.length
  $('#projectList').innerHTML = state.projects.map((project) => `<button class="project ${state.current?.id === project.id ? 'active' : ''}" data-project="${project.id}"><strong>${esc(project.label)}</strong><small title="${esc(project.localPath)}">${esc(project.localPath)}</small></button>`).join('')
  $$('[data-project]').forEach((button) => { button.onclick = () => act(async () => { await discardDraft(); await openProject(Number(button.dataset.project)) }) })
  setBusy(state.busy)
}

async function discardDraft() {
  if (state.draft) {
    try { await api('DELETE', `/api/onboarding/${state.draft.id}`) } catch {}
  }
  state.draft = null
  state.step = 0
  state.local = null
  state.remote = null
  state.verifiedPath = null
  state.fileOverrides = false
}

function welcome() {
  $('#pane').innerHTML = `<div id="message" class="notice"></div><div class="welcome"><p class="eyebrow">FROM YOUR FOLDER TO YOUR HOSTING</p><h1>A simpler way to get your project online.</h1><p class="sub">Choose a local folder, connect your hosting account, and pick where your files belong.</p><button class="primary" id="welcomeAdd">${state.projects.length ? 'Add another project' : 'Add your first project'}</button><div class="cards"><article class="card"><div class="number">01 / LOCAL</div><h3>Start with your files</h3><p>Choose your project or build folder. We’ll pick up hosting settings from its .env.</p></article><article class="card"><div class="number">02 / CONNECT</div><h3>Bring your hosting</h3><p>Use FTP, FTPS, or SFTP details from your hosting provider.</p></article><article class="card"><div class="number">03 / DESTINATION</div><h3>Choose the right folder</h3><p>Browse your server folders and save the destination for this project.</p></article></div></div>`
  $('#welcomeAdd').onclick = () => act(startNew)
  setBusy(state.busy)
}

async function startNew() {
  await discardDraft()
  state.current = null
  state.step = 1
  await refreshProjects()
  renderWizard()
}

function source(key) {
  const value = state.draft?.sources[key]
  const supplied = state.draft?.secrets[key] || state.draft?.values[key] !== '' && state.draft?.values[key] !== undefined
  if (value === 'default' && !supplied && key !== 'DEVSYNC_PORT') {
    return ['DEVSYNC_HOST', 'DEVSYNC_USERNAME', 'DEVSYNC_TRANSPORT'].includes(key) ? '<span class="source">Needed</span>' : ''
  }
  const names = { default: 'Automatic', ui: 'Entered here', override: 'Saved', secret: 'Saved' }
  return value ? `<span class="source">${esc(names[value] || value)}</span>` : ''
}

function input(key, label, { secret = false, type = 'text', optional = false } = {}) {
  const draft = state.draft
  const automaticPort = key === 'DEVSYNC_PORT' && draft.sources[key] === 'default'
  const value = secret || automaticPort ? '' : draft.values[key]
  const present = draft.secrets[key]
  const placeholder = present ? 'Already supplied — leave blank to keep' : automaticPort ? `Automatic (${draft.values.DEVSYNC_TRANSPORT === 'sftp' ? 22 : 21})` : ''
  return `<div class="field"><label for="${key}">${esc(label)}${optional ? ' <span class="muted">(optional)</span>' : ''}${source(key)}</label><input id="${key}" name="${key}" type="${secret ? 'password' : type}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">${present ? `<label class="check"><input type="checkbox" data-clear="${key}">Remove supplied ${key === 'DEVSYNC_PASSWORD' ? 'password' : 'key'}</label>` : ''}</div>`
}

function renderWizard() {
  const draft = state.draft
  const steps = ['Local folder', 'Hosting', 'Destination', 'Review']
  const step = state.step
  const changedStep = renderedStep !== step
  renderedStep = step
  let content = ''
  if (step === 1) {
    content = `<h2>Where are your project files?</h2><p>Choose the folder you want to deploy. For a built frontend, choose its dist or build folder.</p><form id="localForm"><div class="field"><label for="localPath">Local project folder</label><div class="path-row"><input id="localPath" value="${esc(draft?.localPath || '')}" placeholder="Absolute path to a project folder" ${draft?.projectId ? 'readonly' : ''}><button class="secondary" type="button" id="openLocal" ${draft?.projectId ? 'disabled' : ''}>Browse folders</button></div><span class="help">Only hosting settings named DEVSYNC_* are read from this folder’s .env.</span></div><div id="localPicker"></div><div class="actions"><button class="secondary" type="button" id="cancelSetup">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Continue to hosting</button></div></form>`
  } else if (step === 2) {
    const transport = draft.values.DEVSYNC_TRANSPORT
    const loaded = Object.entries(draft.sources).filter(([, value]) => value === '.env' || value === '.devsync.env').length
    content = `<h2>Connect your hosting account</h2><p>${loaded ? `Loaded ${loaded} hosting settings from this folder’s environment files. Fill in anything missing.` : 'Enter the connection details from your hosting provider.'} Imported passwords stay on this computer and are not sent to the browser.</p><form id="hostingForm" autocomplete="off"><div class="form-grid"><div class="field"><label for="DEVSYNC_TRANSPORT">Protocol${source('DEVSYNC_TRANSPORT')}</label><select id="DEVSYNC_TRANSPORT" name="DEVSYNC_TRANSPORT"><option value="">Choose a protocol</option>${['ftps', 'sftp', 'ftp'].map((value) => `<option value="${value}" ${transport === value ? 'selected' : ''}>${value === 'ftps' ? 'FTPS — encrypted FTP' : value === 'sftp' ? 'SFTP — SSH file transfer' : 'FTP — unencrypted'}</option>`).join('')}</select></div>${input('DEVSYNC_HOST', 'Host')}${input('DEVSYNC_PORT', 'Port', { type: 'number', optional: true })}${input('DEVSYNC_USERNAME', 'Username')}${input('DEVSYNC_PASSWORD', 'Password / key passphrase', { secret: true })}</div><details><summary>SSH key and advanced settings</summary><div class="form-grid">${input('DEVSYNC_PRIVATE_KEY', 'SSH private key path', { secret: true, optional: true })}<div class="field"><label for="DEVSYNC_DRY_RUN">Default operation</label><select id="DEVSYNC_DRY_RUN" name="DEVSYNC_DRY_RUN"><option value="false" ${String(draft.values.DEVSYNC_DRY_RUN) === 'false' ? 'selected' : ''}>Allow uploads when requested</option><option value="true" ${String(draft.values.DEVSYNC_DRY_RUN) === 'true' ? 'selected' : ''}>Preview only</option></select></div>${input('DEVSYNC_DEBOUNCE_MS', 'Watch delay (milliseconds)', { type: 'number', optional: true })}</div><p class="help">An SSH key is optional and applies to SFTP only. With a key, the password field is an optional passphrase. Local deletions are never mirrored.</p></details><div class="actions"><button class="secondary" type="button" id="backSetup">Back</button><button class="secondary" type="button" id="cancelSetup">Cancel</button><span class="spacer"></span><button class="primary" type="submit">Test connection & continue</button></div></form>`
  } else if (step === 3) {
    const selected = draft.values.DEVSYNC_REMOTE_PATH
    content = `<h2>Choose the folder on your server</h2><p>Open a folder, then select “Use server folder”. Your local files will be placed inside this destination.</p><div class="notice success">Connection verified with ${esc(draft.values.DEVSYNC_HOST)}.</div><div class="selection"><small>Selected destination ${source('DEVSYNC_REMOTE_PATH')}</small><strong id="selectedRemote">${esc(selected || 'Choose a server folder below')}</strong></div><div id="remotePicker"></div><div class="actions"><button class="secondary" type="button" id="backSetup">Back</button><button class="secondary" type="button" id="cancelSetup">Cancel</button><span class="spacer"></span><button class="primary" id="reviewSetup" ${selected && state.verifiedPath === selected ? '' : 'disabled'}>Continue to review</button></div>`
  } else {
    const values = draft.values
    content = `<h2>Ready to save your project</h2><p>Check the source and destination. Saving will not upload or delete server files.</p><div class="field"><label for="projectName">Project name</label><input id="projectName" value="${esc(draft.label)}" maxlength="80"></div><dl class="review"><dt>Local folder</dt><dd>${esc(draft.localPath)}</dd><dt>Hosting</dt><dd>${esc(values.DEVSYNC_HOST)}:${esc(values.DEVSYNC_PORT)} · ${esc(values.DEVSYNC_TRANSPORT?.toUpperCase())}</dd><dt>Username</dt><dd>${esc(values.DEVSYNC_USERNAME)}</dd><dt>Credentials</dt><dd>${draft.secrets.DEVSYNC_PASSWORD ? 'Password supplied' : 'SSH key supplied'} · stored encrypted</dd><dt>Server folder</dt><dd>${esc(values.DEVSYNC_REMOTE_PATH)}</dd></dl>${state.fileOverrides ? '<div class="notice warning">You changed settings loaded from an environment file. The file stays unchanged and will take priority on future runs. Update that file to keep those changes.</div>' : ''}<p class="snapshot-note">The CLI and dashboard will share this saved project. Your application’s .env is never rewritten or uploaded.</p><div class="actions"><button class="secondary" id="backSetup">Back</button><button class="secondary" id="cancelSetup">Cancel</button><span class="spacer"></span><button class="primary" id="saveSetup">Save project</button></div>`
  }
  $('#pane').innerHTML = `<p class="eyebrow">${draft?.projectId ? 'PROJECT SETTINGS' : 'ADD A PROJECT'}</p><h1>A home for your next deployment.</h1><ol class="steps">${steps.map((name, i) => `<li class="${step === i + 1 ? 'active' : step > i + 1 ? 'done' : ''}" ${step === i + 1 ? 'aria-current="step"' : ''}><span class="step-number">0${i + 1}</span>${name}</li>`).join('')}</ol><div id="message" class="notice"></div><section class="setup-card">${content}</section>`
  $('#cancelSetup').onclick = () => act(async () => { const current = state.current; await discardDraft(); if (current) await openProject(current.id); else welcome() })
  if ($('#backSetup')) $('#backSetup').onclick = () => act(async () => { if (step === 2) await pushHosting(); state.step--; renderWizard() })
  if (step === 1) {
    $('#openLocal').onclick = () => act(() => loadLocal($('#localPath').value || undefined))
    $('#localForm').onsubmit = (event) => { event.preventDefault(); act(async () => {
      const localPath = $('#localPath').value.trim()
      if (!localPath) throw new Error('Choose a local project folder first')
      if (!draft || localPath !== draft.localPath) {
        const loaded = await api('POST', '/api/onboarding', { localPath })
        if (draft) try { await api('DELETE', `/api/onboarding/${draft.id}`) } catch {}
        state.draft = loaded
        state.fileOverrides = false
        state.remote = null
        state.verifiedPath = null
      }
      state.step = 2
      renderWizard()
    }, 'Reading hosting settings from the selected folder…') }
    if (state.local) renderLocal()
  }
  if (step === 2) {
    $$('[name],[data-clear]').forEach((element) => element.addEventListener('input', () => { element.dataset.dirty = 'true' }))
    $('#DEVSYNC_TRANSPORT').addEventListener('change', () => {
      if (!$('#DEVSYNC_PORT').value) $('#DEVSYNC_PORT').placeholder = `Automatic (${$('#DEVSYNC_TRANSPORT').value === 'sftp' ? 22 : 21})`
    })
    $('#hostingForm').onsubmit = (event) => { event.preventDefault(); act(async () => {
      await pushHosting()
      state.draft = await api('POST', `/api/onboarding/${state.draft.id}/test`, {})
      state.step = 3
      state.remote = null
      state.verifiedPath = null
      renderWizard()
      await loadRemote(state.draft.values.DEVSYNC_REMOTE_PATH || '/')
    }, 'Testing your hosting connection…') }
  }
  if (step === 3) {
    if (state.remote) renderRemote()
    else renderRemoteAddress()
    $('#reviewSetup').onclick = () => { state.step = 4; renderWizard() }
  }
  if (step === 4) $('#saveSetup').onclick = () => act(async () => {
    const label = $('#projectName').value.trim()
    const saved = await api('POST', `/api/onboarding/${state.draft.id}/save`, { label })
    const overridden = state.fileOverrides
    await discardDraft()
    await refreshProjects()
    await openProject(saved.id)
    message(overridden ? 'Project saved. Its environment file still takes priority over the settings snapshot.' : 'Project saved. Your source and server destination are ready.', overridden ? 'warning' : 'success')
  }, 'Checking the destination and saving your project…')
  setBusy(state.busy)
  if (changedStep) {
    const heading = $('#pane h1')
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }
}

async function pushHosting() {
  const entries = []
  $$('[name][data-dirty="true"]').forEach((element) => {
    if (element.type === 'password' && !element.value) return
    entries.push({ key: element.name, value: element.value })
  })
  $$('[data-clear]:checked').forEach((element) => entries.push({ key: element.dataset.clear, value: null }))
  if (!entries.length) return
  noteFileOverrides(entries)
  state.draft = await api('PUT', `/api/onboarding/${state.draft.id}`, { entries })
}

function noteFileOverrides(entries) {
  if (entries.some((entry) => ['.env', '.devsync.env'].includes(state.draft.sources[entry.key]))) state.fileOverrides = true
}

async function loadLocal(path) {
  state.local = await api('GET', '/api/local' + (path ? `?path=${encodeURIComponent(path)}` : ''))
  renderLocal()
}
function renderLocal() {
  const current = state.local
  $('#localPicker').innerHTML = `<div class="picker"><label class="help" for="localAddress">Browse local folders</label><div class="path-row"><input id="localAddress" value="${esc(current.path)}" aria-label="Local browser path"><button class="secondary" type="button" id="goLocal">Open local path</button></div><div class="picker-toolbar"><button class="secondary" type="button" data-local="${esc(current.home)}">Home</button>${current.parent ? `<button class="secondary" type="button" data-local="${esc(current.parent)}">Up one local folder</button>` : ''}${current.roots.map((root) => `<button class="secondary" type="button" data-local="${esc(root)}">${esc(root)}</button>`).join('')}</div><div class="folder-list">${current.entries.map((entry) => `<button class="folder" type="button" data-local="${esc(entry.path)}">${esc(entry.name)}</button>`).join('') || '<div class="empty">No subfolders here.</div>'}</div><button class="primary" type="button" id="useLocal">Use local folder</button></div>`
  $$('[data-local]').forEach((button) => { button.onclick = () => act(() => loadLocal(button.dataset.local)) })
  $('#goLocal').onclick = () => act(() => loadLocal($('#localAddress').value.trim()))
  $('#localAddress').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#goLocal').click() } }
  $('#useLocal').onclick = () => { $('#localPath').value = current.path; $('#localPicker').innerHTML = '' }
  setBusy(state.busy)
}

function renderRemoteAddress() {
  $('#remotePicker').innerHTML = '<div class="picker"><label class="help" for="remoteAddress">Open an existing server folder</label><div class="path-row"><input id="remoteAddress" value="/" aria-label="Server browser path"><button class="secondary" id="goRemote">Open server path</button></div><div id="remoteContents"></div></div>'
  $('#goRemote').onclick = () => act(() => loadRemote($('#remoteAddress').value.trim()))
  $('#remoteAddress').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); $('#goRemote').click() } }
}
async function loadRemote(path) {
  state.remote = await api('POST', `/api/onboarding/${state.draft.id}/browse`, { path })
  if (state.remote.path === state.draft.values.DEVSYNC_REMOTE_PATH) state.verifiedPath = state.remote.path
  renderWizard()
}
function renderRemote() {
  const current = state.remote
  renderRemoteAddress()
  $('#remoteAddress').value = current.path
  $('#remoteContents').innerHTML = `<div class="picker-toolbar"><button class="secondary" data-remote="/">Account root</button>${current.parent ? `<button class="secondary" data-remote="${esc(current.parent)}">Up one server folder</button>` : ''}</div><div class="folder-list">${current.entries.map((entry) => `<button class="folder" data-remote="${esc(entry.path)}">${esc(entry.name)}</button>`).join('') || '<div class="empty">No subfolders here. You can still use this folder.</div>'}</div><button class="primary" id="useRemote">Use server folder</button>`
  $$('[data-remote]').forEach((button) => { button.onclick = () => act(() => loadRemote(button.dataset.remote)) })
  $('#useRemote').onclick = () => act(async () => {
    const entries = [{ key: 'DEVSYNC_REMOTE_PATH', value: current.path }]
    noteFileOverrides(entries)
    state.draft = await api('PUT', `/api/onboarding/${state.draft.id}`, { entries })
    state.verifiedPath = current.path
    renderWizard()
    message(`Destination selected: ${current.path}`, 'success')
  })
  setBusy(state.busy)
}

async function openProject(id) {
  const data = await api('GET', `/api/projects/${id}/env`)
  state.current = { id, ...data }
  state.step = 0
  const config = data.configuration
  const values = config.values
  $('#pane').innerHTML = `<p class="eyebrow">SAVED PROJECT</p><div class="summary-head"><div><h1>${esc(data.label)}</h1><p class="sub">${esc(data.localPath)}</p></div><span class="ready">● ${Object.keys(config.errors).length ? 'Setup needed' : 'Project configured'}</span></div><div id="message" class="notice"></div><section class="summary-card"><h2>Source → destination</h2><dl class="review"><dt>Local source</dt><dd>${esc(data.localPath)}</dd><dt>Server folder</dt><dd>${esc(values.DEVSYNC_REMOTE_PATH || 'Not configured')}</dd><dt>Connection</dt><dd>${esc(values.DEVSYNC_TRANSPORT?.toUpperCase())} · ${esc(values.DEVSYNC_HOST || 'Not configured')}:${esc(values.DEVSYNC_PORT)}</dd><dt>Username</dt><dd>${esc(values.DEVSYNC_USERNAME || 'Not configured')}</dd><dt>Credentials</dt><dd>${config.secrets.DEVSYNC_PASSWORD || config.secrets.DEVSYNC_PRIVATE_KEY ? 'Supplied · never shown in this browser' : 'Not configured'}</dd></dl><div class="actions"><button class="primary" id="editProject">Edit setup</button><button class="secondary" id="testProject">Test connection</button><span class="spacer"></span><button class="danger" id="deleteProject">Remove project</button></div></section>`
  if (Object.keys(config.errors).length) message(Object.values(config.errors).join('; '), 'warning')
  $('#editProject').onclick = () => act(async () => { state.draft = await api('POST', '/api/onboarding', { projectId: id }); state.fileOverrides = false; state.step = 2; renderWizard() })
  $('#testProject').onclick = () => act(async () => { await api('POST', '/api/test', { projectId: id }); message('Connection test passed.', 'success') }, 'Testing your hosting connection…')
  $('#deleteProject').onclick = () => act(async () => {
    if (!confirm(`Remove "${data.label}" from devsync? Local and server files stay in place.`)) return
    await api('DELETE', `/api/projects/${id}`)
    state.current = null
    await refreshProjects()
    welcome()
  })
  await refreshProjects()
  window.scrollTo(0, 0)
  setBusy(state.busy)
}

$('#addProject').onclick = () => act(startNew)
;(async () => {
  try {
    await refreshProjects()
    $('#serverStatus').textContent = '● Running locally'
    if (state.projects.length === 1) await openProject(state.projects[0].id)
    else welcome()
  } catch (error) {
    $('#pane').innerHTML = '<h1>Could not load your projects</h1><div id="message" class="notice"></div>'
    message(error.message, 'error')
    $('#serverStatus').textContent = 'Connection unavailable'
  }
})()
