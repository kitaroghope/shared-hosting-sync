// Resolve only documented devsync settings; application secrets stay untouched.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import dotenv from 'dotenv'
import { ENV_SCHEMA, defaultsFor, validate } from './envSchema.js'
import { effectiveEnv, getProject } from './projects.js'
import { validateRemotePath } from '../paths.js'

const recognized = new Set(ENV_SCHEMA.map((s) => s.key))
const present = (value) => value !== undefined && value !== null && value !== ''

export function resolveEnv(projectId, { transport = 'sftp', envFile, localPath, overrides = {} } = {}) {
  const project = projectId == null ? null : getProject(projectId)
  localPath = project?.localPath || localPath
  if (!localPath) throw new Error('A local project folder is required')
  const values = { ...defaultsFor(transport) }
  const sources = Object.fromEntries(ENV_SCHEMA.map((s) => [s.key, 'default']))
  if (project) {
    const saved = effectiveEnv(projectId, transport)
    for (const [key, value] of Object.entries(saved.values)) {
      if (recognized.has(key) && present(value)) {
        values[key] = value
        sources[key] = saved.sources[key]
      }
    }
  }
  const explicitFile = envFile || process.env.DEVSYNC_ENV_FILE
  if (explicitFile && typeof explicitFile !== 'string') throw new Error('--env-file requires a file path')
  const layers = explicitFile
    ? [{ file: path.resolve(explicitFile), source: envFile ? '--env-file' : 'DEVSYNC_ENV_FILE', required: true }]
    : ['.devsync.env', '.env'].map((name) => ({ file: path.join(localPath, name), source: name }))
  for (const layer of layers) {
    if (!fs.existsSync(layer.file)) {
      if (layer.required) throw new Error('The selected environment file does not exist')
      continue
    }
    const relative = path.relative(localPath, layer.file)
    const name = path.basename(layer.file)
    const insideProject = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)
    if (insideProject && name !== '.env' && !name.startsWith('.env.') && name !== '.devsync.env') {
      throw new Error('An environment file inside the project must be named .env, .env.*, or .devsync.env so it stays excluded from deployment')
    }
    const parsed = dotenv.parse(fs.readFileSync(layer.file, 'utf8'))
    for (const [key, value] of Object.entries(parsed)) {
      if (recognized.has(key) && present(value)) {
        values[key] = value
        sources[key] = layer.source
      }
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (recognized.has(key) && present(value)) {
      values[key] = value
      sources[key] = 'cli'
    }
  }
  if (sources.DEVSYNC_PORT === 'default') values.DEVSYNC_PORT = defaultsFor(values.DEVSYNC_TRANSPORT).DEVSYNC_PORT
  if (values.DEVSYNC_PRIVATE_KEY) {
    const keyPath = values.DEVSYNC_PRIVATE_KEY
    values.DEVSYNC_PRIVATE_KEY = keyPath.startsWith('~/') || keyPath.startsWith('~\\')
      ? path.join(os.homedir(), keyPath.slice(2)) : path.resolve(localPath, keyPath)
  }
  const warnings = ENV_SCHEMA.map((s) => settingError(s.key, values[s.key], values)).filter(Boolean)
  return { values, sources, warnings }
}

export function settingError(key, value, values = {}) {
  if (key === 'DEVSYNC_PASSWORD' && values.DEVSYNC_TRANSPORT === 'sftp' && values.DEVSYNC_PRIVATE_KEY && !value) return null
  const result = validate(key, value)
  if (!result.ok) return result.message
  if (key === 'DEVSYNC_HOST' && value && (/\s|\/|\\/.test(value))) return 'DEVSYNC_HOST must be a hostname or IP without a URL scheme'
  if (key === 'DEVSYNC_USERNAME' && value && !String(value).trim()) return 'DEVSYNC_USERNAME is required'
  if (key === 'DEVSYNC_REMOTE_PATH') {
    try { validateRemotePath(value) } catch (err) { return err.message }
  }
  if (key === 'DEVSYNC_PRIVATE_KEY' && value && values.DEVSYNC_TRANSPORT === 'sftp') {
    try {
      if (!fs.statSync(value).isFile()) return 'DEVSYNC_PRIVATE_KEY must point to a file'
      fs.accessSync(value, fs.constants.R_OK)
    } catch { return 'DEVSYNC_PRIVATE_KEY must point to a readable local file' }
  }
  return null
}

export function credsFromResolved(values) {
  const transport = values.DEVSYNC_TRANSPORT
  return {
    transport,
    host: values.DEVSYNC_HOST,
    port: Number(values.DEVSYNC_PORT || (transport === 'sftp' ? 22 : 21)),
    username: values.DEVSYNC_USERNAME,
    password: values.DEVSYNC_PASSWORD || undefined,
    privateKeyPath: transport === 'sftp' ? values.DEVSYNC_PRIVATE_KEY || undefined : undefined,
    secure: transport === 'ftps',
    timeoutMs: 20000
  }
}
