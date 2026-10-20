import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Everything lives under ~/.devsync so no project directory is ever touched.
 * Override via DEVSYNC_HOME (used by tests, and by anyone who wants to keep
 * devsync state on a separate drive).
 */
export const HOME = process.env.DEVSYNC_HOME || path.join(os.homedir(), '.devsync')
export const CONFIG_FILE = path.join(HOME, 'config.json')
export const ENV_FILE = path.join(HOME, '.env')

const DEFAULT_CONFIG = {
  transport: 'sftp',
  defaults: {
    port: null,
    username: '',
    remotePath: '',
    ignoreDeletes: true,
    dryRunByDefault: true
  },
  projects: []
}

export function ensureHome() {
  if (!fs.existsSync(HOME)) fs.mkdirSync(HOME, { recursive: true })
  return HOME
}

export function loadConfig() {
  ensureHome()
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2))
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    return {
      transport: parsed.transport ?? 'sftp',
      defaults: { ...DEFAULT_CONFIG.defaults, ...(parsed.defaults ?? {}) },
      projects: Array.isArray(parsed.projects) ? parsed.projects : []
    }
  } catch (err) {
    throw new Error(`Config file is not valid JSON: ${CONFIG_FILE}\n  ${err.message}`)
  }
}

export function saveConfig(config) {
  ensureHome()
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2))
}

/** Credentials come from ~/.devsync/.env, never from config.json or a project .env. */
export function loadCredentials() {
  ensureHome()
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(path.join(HERE, '..', '.env.example'), ENV_FILE)
    throw new Error(
      `Created ${ENV_FILE} from the template.\n` +
      `Edit it with your host details, then re-run the same command.`
    )
  }
  const parsed = dotenv.parse(fs.readFileSync(ENV_FILE))
  const missing = ['PROTO', 'HOST', 'USERNAME', 'PASSWORD'].filter((k) => !parsed[k])
  if (missing.length) {
    throw new Error(`${ENV_FILE} is missing: ${missing.join(', ')}`)
  }
  const proto = (parsed.PROTO || 'sftp').toLowerCase()
  const defaultPort = proto === 'sftp' ? 22 : 21
  return {
    transport: proto,
    host: parsed.HOST,
    port: Number(parsed.PORT || defaultPort),
    username: parsed.USERNAME,
    password: parsed.PASSWORD || undefined,
    privateKeyPath: parsed.PRIVATE_KEY_PATH || undefined,
    secure: proto === 'ftps',
    timeoutMs: Number(parsed.TIMEOUT_MS || 20000)
  }
}

export function upsertProject(config, project) {
  const idx = config.projects.findIndex((p) => p.id === project.id)
  if (idx >= 0) config.projects[idx] = { ...config.projects[idx], ...project }
  else config.projects.push(project)
  saveConfig(config)
  return project
}

export function removeProject(config, id) {
  const before = config.projects.length
  config.projects = config.projects.filter((p) => p.id !== id)
  saveConfig(config)
  return before !== config.projects.length
}