// ui.js — single-page client for the devsync v2 UI.
//
// Bootstrap: fetch /api/health (public) + GET /api/session (loopback-only;
// returns { ok: true }) so we know the server is alive, then list projects.
// The session token in v2-mvp is read by the CLI/server at start; we don't
// embed it in the page (the UI is loopback-only, so CORS is not a worry).

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => Array.from(document.querySelectorAll(sel))

const state = {
  projects: [],
  current: null,
  schema: null,
  form: {},
  browse: { path: '/', entries: [] }
}

let _sessionToken = null
async function getSessionToken() {
  if (_sessionToken) return _sessionToken
  const r = await fetch('/api/session')
  const data = await r.json()
  if (!data.token) throw new Error('no session token returned')
  _sessionToken = data.token
  return _sessionToken
}

async function api(method, path, body) {
  const opts = { method, headers: { 'content-type': 'application/json' } }
  // All API calls require the session token.
  opts.headers['x-devsync-session'] = await getSessionToken()
  if (body !== undefined) opts.body = JSON.stringify(body)
  const r = await fetch(path, opts)
  let data
  try { data = await r.json() } catch { data = {} }
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status })
  return data
}

function status(msg, kind = 'info', el) {
  const t = el || $('#pane .status') || makeStatus()
  t.textContent = msg
  t.className = 'status ' + kind
  t.style.display = 'block'
  if (kind === 'ok') setTimeout(() => { t.style.display = 'none' }, 4000)
  return t
}

function makeStatus() {
  const div = document.createElement('div')
  div.className = 'status'
  $('#pane').prepend(div)
  return div
}

// ---------- project list ----------

async function refreshProjects() {
  const r = await api('GET', '/api/projects')
  state.projects = r.projects
  const list = $('#projectList')
  list.innerHTML = ''
  if (!state.projects.length) {
    list.innerHTML = '<div style="color:#6b7280; font-size:12px">No projects yet.</div>'
    return
  }
  for (const p of state.projects) {
    const btn = document.createElement('button')
    btn.className = 'proj-item' + (state.current && state.current.id === p.id ? ' active' : '')
    btn.onclick = () => selectProject(p.id)
    btn.innerHTML = `
      <span class="label">${escapeHtml(p.label)}</span>
      <span class="path" title="${escapeHtml(p.localPath)}">${escapeHtml(p.localPath)}</span>
      <span class="meta">
        ${p.credsSet ? '<span class="status-ok">creds ✓</span>' : '<span class="status-error">no creds</span>'}
        · ${p.lastStatus}
      </span>`
    list.appendChild(btn)
  }
}

async function selectProject(id) {
  const r = await api('GET', `/api/projects/${id}/env`)
  state.current = { id, label: r.label, localPath: r.localPath }
  state.form = {}
  for (const o of r.overrides) {
    state.form[o.key] = o
  }
  // For required-but-missing keys, seed an empty override entry
  for (const s of state.schema.keys) {
    if (!state.form[s.key]) {
      state.form[s.key] = { key: s.key, value: null, isSecret: s.secret }
    }
  }
  renderPane()
  refreshProjects()
}

// ---------- pane ----------

function renderPane() {
  const pane = $('#pane')
  if (!state.schema) {
    pane.innerHTML = '<div class="empty">Loading schema…</div>'
    return
  }
  if (!state.current) {
    pane.innerHTML = `
      <div class="empty">
        <h2>Welcome to devsync</h2>
        <p>Add a project on the left, or pick one if it already exists.</p>
        <p style="font-size:12px; color:#6b7280">
          Each project gets its own host, credentials, and remote path.
          Credentials are encrypted at rest with AES-256-GCM.
        </p>
      </div>`
    return
  }
  pane.innerHTML = `
    <div class="status" id="status"></div>
    <h2>${escapeHtml(state.current.label)}</h2>
    <div class="sub">${escapeHtml(state.current.localPath)}</div>
    <form id="envForm" class="grid"></form>
    <div class="actions">
      <button class="primary" type="submit" form="envForm">Save</button>
      <button class="secondary" type="button" id="testBtn">Test connection</button>
      <button class="secondary" type="button" id="browseBtn">Browse…</button>
      <span style="flex:1"></span>
      <button class="danger" type="button" id="deleteBtn">Delete project</button>
    </div>
    <div class="browse" id="browse" style="display:none"></div>
  `
  renderForm()
  $('#envForm').addEventListener('submit', onSave)
  $('#testBtn').onclick = onTest
  $('#browseBtn').onclick = onBrowseToggle
  $('#deleteBtn').onclick = onDelete
}

function renderForm() {
  const form = $('#envForm')
  form.innerHTML = ''
  // Group keys: transport, host/port, auth, remote path, behaviour
  const groups = [
    { title: 'Connection', keys: ['DEVSYNC_TRANSPORT', 'DEVSYNC_HOST', 'DEVSYNC_PORT'] },
    { title: 'Credentials', keys: ['DEVSYNC_USERNAME', 'DEVSYNC_PASSWORD', 'DEVSYNC_PRIVATE_KEY'] },
    { title: 'Remote', keys: ['DEVSYNC_REMOTE_PATH'] },
    { title: 'Behaviour', keys: ['DEVSYNC_IGNORE_DELETES', 'DEVSYNC_DRY_RUN', 'DEVSYNC_DEBOUNCE_MS'] }
  ]
  for (const g of groups) {
    const fields = state.schema.keys.filter((s) => g.keys.includes(s.key))
    if (!fields.length) continue
    const wrap = document.createElement('div')
    wrap.innerHTML = `<h3 style="margin:14px 0 6px; font-size:11px; color:#93c5fd; text-transform:uppercase; letter-spacing:.8px">${g.title}</h3>`
    const grid = document.createElement('div')
    grid.className = 'grid cols-2'
    for (const s of fields) grid.appendChild(fieldEl(s))
    wrap.appendChild(grid)
    form.appendChild(wrap)
  }
}

function fieldEl(s) {
  const cur = state.form[s.key] || { value: null, isSecret: false }
  const isSecret = s.secret || cur.isSecret
  const presentSecret = isSecret && cur.present
  const value = presentSecret ? '' : (cur.value ?? '')
  const div = document.createElement('div')
  div.className = 'field' + (isSecret ? ' secret' : '')
  div.innerHTML = `
    <label>${escapeHtml(s.label)}${s.required ? ' <span style="color:#fca5a5">*</span>' : ''}</label>
    ${renderInput(s, value, isSecret)}
    <div class="help">${escapeHtml(s.help || '')}${presentSecret ? ' <span class="badge ok">stored</span>' : ''}</div>
  `
  return div
}

function renderInput(s, value, isSecret) {
  if (s.type === 'enum') {
    const opts = s.values.map((v) => `<option value="${v}"${v === value ? ' selected' : ''}>${v}</option>`).join('')
    return `<select name="${s.key}">${opts}</select>`
  }
  const type = isSecret ? 'password' : (s.type === 'int' ? 'number' : 'text')
  return `<input type="${type}" name="${s.key}" value="${escapeAttr(value)}" placeholder="${s.default !== undefined ? 'default: ' + s.default : ''}">`
}

// ---------- save ----------

async function onSave(e) {
  e.preventDefault()
  const entries = []
  for (const s of state.schema.keys) {
    const cur = state.form[s.key]
    const el = document.querySelector(`[name="${s.key}"]`)
    if (!el) continue
    let v = el.value
    if (cur.present && (s.secret || cur.isSecret) && v === '') v = '***' // mark "keep current"
    entries.push({ key: s.key, value: v, isSecret: s.secret || cur.isSecret })
  }
  try {
    await api('PUT', `/api/projects/${state.current.id}/env`, { entries })
    status('Saved.', 'ok')
    await selectProject(state.current.id)
  } catch (e) {
    status('Save failed: ' + e.message, 'err')
  }
}

// ---------- test ----------

async function onTest() {
  status('Connecting…', 'info')
  try {
    const r = await api('POST', '/api/test', { projectId: state.current.id })
    status(`Connected via ${r.transport} to ${r.host}.`, 'ok')
  } catch (e) {
    status('Connection failed: ' + e.message, 'err')
  }
}

// ---------- browse ----------

async function onBrowseToggle() {
  const el = $('#browse')
  if (el.style.display === 'block') { el.style.display = 'none'; return }
  el.style.display = 'block'
  await loadBrowse('/')
}

async function loadBrowse(path) {
  const browse = $('#browse')
  browse.innerHTML = '<div class="empty">Loading…</div>'
  try {
    const r = await api('GET', `/api/browse?projectId=${state.current.id}&path=${encodeURIComponent(path)}`)
    state.browse = r
    browse.innerHTML = `
      <h3 style="margin:12px 0 6px; font-size:12px; color:#93c5fd">Browse: ${escapeHtml(r.path)}</h3>
      <div class="browse-list">
        ${r.path !== '/' ? '<div class="browse-up" data-path="..">↑ ..</div>' : ''}
        ${r.entries.map((e) => `
          <div class="browse-item" data-path="${escapeAttr(e.path)}" data-type="${e.type}">
            <span class="icon">${e.type === 'dir' ? '📁' : '📄'}</span>
            ${escapeHtml(e.name)}
          </div>
        `).join('') || '<div style="color:#6b7280; padding:8px">Empty directory.</div>'}
      </div>
      <div class="actions" style="margin-top:8px">
        <button class="secondary" type="button" id="useThisBtn">Use this folder</button>
      </div>
    `
    $$('.browse-up, .browse-item').forEach((el) => {
      el.onclick = () => {
        const t = el.dataset.type
        if (t === 'file') return // can't cd into a file
        loadBrowse(el.dataset.path === '..' ? parentPath(r.path) : el.dataset.path)
      }
    })
    $('#useThisBtn').onclick = () => {
      const el = document.querySelector(`[name="DEVSYNC_REMOTE_PATH"]`)
      if (el) el.value = r.path
      browse.style.display = 'none'
      status('Remote path set. Save to apply.', 'ok')
    }
  } catch (e) {
    browse.innerHTML = `<div class="status err">${escapeHtml(e.message)}</div>`
  }
}

function parentPath(p) {
  const norm = p.replace(/\\/g, '/')
  const parts = norm.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

// ---------- delete ----------

async function onDelete() {
  if (!confirm(`Delete project "${state.current.label}"?`)) return
  try {
    await api('DELETE', `/api/projects/${state.current.id}`)
    state.current = null
    await refreshProjects()
    renderPane()
  } catch (e) {
    status('Delete failed: ' + e.message, 'err')
  }
}

// ---------- helpers ----------

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s) }

// ---------- add project ----------

$('#addProject').onclick = async () => {
  const label = prompt('Project label (short, no spaces):')
  if (!label) return
  const localPath = prompt('Local path (absolute):')
  if (!localPath) return
  try {
    const r = await api('POST', '/api/projects', { label, localPath })
    await refreshProjects()
    selectProject(r.id)
  } catch (e) {
    alert('Could not add: ' + e.message)
  }
}

// ---------- boot ----------

;(async function boot() {
  try {
    await api('GET', '/api/health')
    $('#serverStatus').textContent = 'loopback'
    $('#serverStatus').style.color = '#86efac'
  } catch (e) {
    $('#serverStatus').textContent = 'server unreachable'
    $('#serverStatus').style.color = '#fca5a5'
  }
  const s = await api('GET', '/api/schema')
  state.schema = s
  await refreshProjects()
  if (state.projects.length === 1) selectProject(state.projects[0].id)
  else renderPane()
})()