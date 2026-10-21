import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { ENV_SCHEMA, defaultsFor } from '../core/envSchema.js'
import { resolveEnv, settingError, credsFromResolved } from '../core/envResolver.js'
import { getProject, getProjectByLabel, getProjectByLocalPath, createProject, deleteProject, saveConfiguration, updateProject } from '../core/projects.js'
import { assertLocalFolder } from '../onboarding.js'
import { validateRemotePath } from '../paths.js'
import { ensureDeployignore } from '../ignore.js'
import { createTransport } from '../transport/index.js'

const connectionKeys = ['DEVSYNC_TRANSPORT', 'DEVSYNC_HOST', 'DEVSYNC_PORT', 'DEVSYNC_USERNAME', 'DEVSYNC_PASSWORD', 'DEVSYNC_PRIVATE_KEY']
const secretKeys = new Set(['DEVSYNC_PASSWORD', 'DEVSYNC_PRIVATE_KEY'])
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })

export function configurationView(resolved) {
  const values = {}
  const secrets = {}
  const errors = {}
  for (const schema of ENV_SCHEMA) {
    const value = resolved.values[schema.key]
    if (secretKeys.has(schema.key)) secrets[schema.key] = !!value
    else values[schema.key] = value ?? ''
    const error = settingError(schema.key, value, resolved.values)
    if (error) errors[schema.key] = error
  }
  return { values, secrets, sources: { ...resolved.sources }, errors }
}

export function validateConnection(values) {
  const errors = connectionKeys.map((key) => settingError(key, values[key], values)).filter(Boolean)
  if (errors.length) throw fail(errors.join('; '))
}

export function safeConnectionError(error, values) {
  const password = values.DEVSYNC_PASSWORD
  return password ? error.message.split(password).join('[redacted]') : error.message
}

export class OnboardingService {
  constructor({ connect = createTransport, now = Date.now, maxAgeMs = 30 * 60 * 1000 } = {}) {
    this.connect = connect
    this.now = now
    this.maxAgeMs = maxAgeMs
    this.drafts = new Map()
  }

  clear() { this.drafts.clear() }

  get(id) {
    const draft = this.drafts.get(id)
    if (!draft || draft.expires <= this.now()) {
      this.drafts.delete(id)
      throw fail('This setup expired. Select the local folder again.', 404)
    }
    draft.expires = this.now() + this.maxAgeMs
    return draft
  }

  view(draft) {
    return {
      id: draft.id, localPath: draft.localPath, label: draft.label,
      projectId: draft.projectId, tested: draft.tested,
      ...configurationView(draft)
    }
  }

  load({ localPath, projectId } = {}) {
    for (const [id, draft] of this.drafts) if (draft.expires <= this.now()) this.drafts.delete(id)
    if (this.drafts.size >= 50) throw fail('Too many open setups. Close a setup and try again.', 429)
    let project = projectId ? getProject(Number(projectId)) : null
    if (projectId && !project) throw fail('Project not found', 404)
    const folder = assertLocalFolder(project?.localPath || localPath)
    project ||= getProjectByLocalPath(folder)
    const resolved = resolveEnv(project?.id, { localPath: folder, useEnvFileEnvironment: false })
    if (resolved.sources.DEVSYNC_TRANSPORT === 'default') {
      delete resolved.values.DEVSYNC_TRANSPORT
      if (resolved.sources.DEVSYNC_PORT === 'default') delete resolved.values.DEVSYNC_PORT
    }
    const draft = {
      ...resolved, id: crypto.randomUUID(), localPath: folder, projectId: project?.id || null,
      label: project?.label || path.basename(folder) || 'project', tested: false,
      expires: this.now() + this.maxAgeMs, busy: false
    }
    this.drafts.set(draft.id, draft)
    return this.view(draft)
  }

  update(id, entries) {
    const draft = this.get(id)
    if (draft.busy) throw fail('Wait for the current setup operation to finish', 409)
    if (!Array.isArray(entries)) throw fail('Settings entries are required')
    const values = { ...draft.values }
    const sources = { ...draft.sources }
    for (const entry of entries) {
      if (!entry || !ENV_SCHEMA.some((schema) => schema.key === entry.key)) throw fail('Unknown setting')
      if (entry.value !== null && !['string', 'number', 'boolean'].includes(typeof entry.value)) throw fail('Invalid setting value')
      let value = entry.value == null ? '' : String(entry.value)
      if (value.length > 16384) throw fail('Setting value is too long')
      if (!secretKeys.has(entry.key)) value = value.trim()
      if (entry.key === 'DEVSYNC_PRIVATE_KEY' && value) {
        value = value.startsWith('~/') || value.startsWith('~\\')
          ? path.join(os.homedir(), value.slice(2)) : path.resolve(draft.localPath, value)
      }
      if (!value) delete values[entry.key]
      else values[entry.key] = value
      sources[entry.key] = entry.key === 'DEVSYNC_PORT' && !value ? 'default' : 'ui'
    }
    if (sources.DEVSYNC_PORT === 'default') values.DEVSYNC_PORT = defaultsFor(values.DEVSYNC_TRANSPORT).DEVSYNC_PORT
    if (connectionKeys.some((key) => draft.values[key] !== values[key])) draft.tested = false
    draft.values = values
    draft.sources = sources
    return this.view(draft)
  }

  async inspect(draft, remotePath) {
    validateConnection(draft.values)
    let transport
    try {
      transport = await this.connect(credsFromResolved(draft.values))
      const entries = await transport.list(remotePath)
      return entries.filter((entry) => entry.type === 'dir' && entry.name && !['.', '..'].includes(entry.name) && !/[\\/\x00-\x1f\x7f]/.test(entry.name))
        .map((entry) => ({ name: entry.name, path: path.posix.join(remotePath, entry.name) }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch (error) {
      throw fail(safeConnectionError(error, draft.values), 502)
    } finally {
      if (transport) await transport.close()
    }
  }

  async operation(id, action) {
    const draft = this.get(id)
    if (draft.busy) throw fail('Wait for the current setup operation to finish', 409)
    draft.busy = true
    try { return await action(draft) }
    finally { draft.busy = false }
  }

  async test(id) {
    return this.operation(id, async (draft) => {
      draft.tested = false
      await this.inspect(draft, '/')
      draft.tested = true
      return this.view(draft)
    })
  }

  async browse(id, remotePath) {
    return this.operation(id, async (draft) => {
      if (!draft.tested) throw fail('Test the connection before choosing a server folder', 409)
      const current = validateRemotePath(remotePath)
      return { path: current, parent: current === '/' ? null : path.posix.dirname(current), entries: await this.inspect(draft, current) }
    })
  }

  async save(id, label) {
    return this.operation(id, async (draft) => {
      if (typeof label !== 'string' || !label.trim() || label.trim().length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw fail('Enter a project name of 1–80 characters')
      label = label.trim()
      const duplicate = getProjectByLabel(label)
      if (duplicate && duplicate.id !== draft.projectId) throw fail('That project name is already in use', 409)
      const errors = ENV_SCHEMA.map((schema) => settingError(schema.key, draft.values[schema.key], draft.values)).filter(Boolean)
      if (errors.length) throw fail(errors.join('; '))
      if (!draft.tested) throw fail('Test the connection before saving', 409)
      const remotePath = validateRemotePath(draft.values.DEVSYNC_REMOTE_PATH)
      await this.inspect(draft, remotePath)
      assertLocalFolder(draft.localPath)
      ensureDeployignore(draft.localPath)
      let project = draft.projectId ? getProject(draft.projectId) : null
      if (draft.projectId && !project) throw fail('Project was removed. Start setup again.', 404)
      const created = !project
      try {
        project ||= createProject({ label, localPath: draft.localPath })
        saveConfiguration(project.id, draft.values, { sources: draft.sources })
        if (project.label !== label) updateProject(project.id, { label })
      } catch (error) {
        if (created && project) deleteProject(project.id)
        throw error
      }
      this.drafts.delete(id)
      return { id: project.id, label, localPath: draft.localPath, remotePath }
    })
  }

  remove(id) {
    const draft = this.get(id)
    if (draft.busy) throw fail('Wait for the current setup operation to finish', 409)
    this.drafts.delete(id)
  }
}
