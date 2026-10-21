import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ENV_SCHEMA, defaultsFor } from './core/envSchema.js'
import { credsFromResolved, settingError } from './core/envResolver.js'
import { createTransport } from './transport/index.js'
import { validateRemotePath } from './paths.js'

const clean = (text) => String(text).replace(/[\x00-\x1f\x7f]/g, '')

/** Browse existing server directories without creating or uploading anything. */
export async function selectRemoteFolder(transport, ask, log = console.log, initialEntries) {
  let current = '/'
  let entries = initialEntries
  while (true) {
    if (!entries) entries = await transport.list(current)
    const folders = entries.filter((entry) => entry.type === 'dir' && !['.', '..'].includes(entry.name))
    log(`Server folder: ${clean(current)}`)
    folders.forEach((entry, i) => log(`  ${i + 1}. ${clean(entry.name)}/`))
    const selection = (await ask({ key: 'DEVSYNC_REMOTE_PATH', label: 'Folder number, .., /absolute/path, . to select, or q to cancel' })).trim()
    if (selection === 'q') throw new Error('Setup cancelled')
    if (selection === '.') return current
    let next
    if (selection === '..') next = path.posix.dirname(current)
    else if (/^[1-9]\d*$/.test(selection) && folders[Number(selection) - 1]) {
      const name = folders[Number(selection) - 1].name
      if (/[\\/\x00-\x1f\x7f]/.test(name)) { log('Unsupported server folder name'); continue }
      next = path.posix.join(current, name)
    } else {
      try { next = validateRemotePath(selection) }
      catch { log('Choose a listed folder, an absolute path, or . to select this folder'); continue }
    }
    try {
      const nextEntries = await transport.list(next)
      current = next
      entries = nextEntries
    } catch { log('Cannot open that server folder. Choose another folder or q to cancel.') }
  }
}

/** Resolve missing/invalid settings and test a connection before saving a project. */
export async function prepareConfiguration(resolved, {
  localPath, ask, log = console.log, connect = createTransport, edit = false, browse = false
} = {}) {
  const values = { ...resolved.values }
  const sources = { ...resolved.sources }
  if (!ask && (edit || browse)) throw new Error('--edit and --browse require an interactive terminal')
  const problems = ENV_SCHEMA.filter((s) => settingError(s.key, values[s.key], values)).map((s) => s.key)
  if (sources.DEVSYNC_TRANSPORT === 'default') problems.unshift('DEVSYNC_TRANSPORT')
  if (!ask && problems.length) {
    throw new Error(`Missing or invalid ${[...new Set(problems)].join(', ') || 'setup choices'}. Set DEVSYNC_* values in the project .env, or run devsync setup in an interactive terminal.`)
  }

  async function fill(key, { requiredChoice = false, defaultValue } = {}) {
    const schema = ENV_SCHEMA.find((s) => s.key === key)
    let error = settingError(key, values[key], values)
    while (requiredChoice || error) {
      if (error) log(error)
      const previousSource = sources[key]
      let answer = await ask({ key, label: schema.label, secret: schema.type === 'secret', defaultValue })
      if (key !== 'DEVSYNC_PASSWORD') answer = answer.trim()
      if (key === 'DEVSYNC_PRIVATE_KEY' && answer) {
        answer = answer.startsWith('~/') || answer.startsWith('~\\')
          ? path.join(os.homedir(), answer.slice(2)) : path.resolve(localPath, answer)
      }
      values[key] = answer
      sources[key] = 'prompt'
      if (previousSource?.includes('env')) log(`Using entered ${key} for this run; update its environment file to keep this correction.`)
      requiredChoice = false
      error = settingError(key, values[key], values)
    }
  }

  await fill('DEVSYNC_TRANSPORT', { requiredChoice: edit || sources.DEVSYNC_TRANSPORT === 'default', defaultValue: edit ? values.DEVSYNC_TRANSPORT : 'ftps' })
  if (sources.DEVSYNC_PORT === 'default') values.DEVSYNC_PORT = defaultsFor(values.DEVSYNC_TRANSPORT).DEVSYNC_PORT
  for (const key of ['DEVSYNC_HOST', 'DEVSYNC_PORT', 'DEVSYNC_USERNAME']) {
    await fill(key, { requiredChoice: edit, defaultValue: edit ? values[key] : key === 'DEVSYNC_PORT' ? defaultsFor(values.DEVSYNC_TRANSPORT).DEVSYNC_PORT : undefined })
  }
  if (values.DEVSYNC_TRANSPORT === 'sftp') {
    await fill('DEVSYNC_PRIVATE_KEY', { requiredChoice: edit, defaultValue: edit ? values.DEVSYNC_PRIVATE_KEY || '' : '' })
  }
  await fill('DEVSYNC_PASSWORD', {
    requiredChoice: edit,
    defaultValue: edit ? values.DEVSYNC_PASSWORD || (values.DEVSYNC_TRANSPORT === 'sftp' && values.DEVSYNC_PRIVATE_KEY ? '' : undefined) : undefined
  })
  for (const s of ENV_SCHEMA.filter((s) => !['DEVSYNC_TRANSPORT', 'DEVSYNC_HOST', 'DEVSYNC_PORT', 'DEVSYNC_USERNAME', 'DEVSYNC_PRIVATE_KEY', 'DEVSYNC_PASSWORD', 'DEVSYNC_REMOTE_PATH'].includes(s.key))) await fill(s.key)

  let transport
  try {
    transport = await connect(credsFromResolved(values))
    const entries = await transport.list('/')
    log('Connection test passed')
    if (browse || settingError('DEVSYNC_REMOTE_PATH', values.DEVSYNC_REMOTE_PATH, values)) {
      values.DEVSYNC_REMOTE_PATH = await selectRemoteFolder(transport, ask, log, entries)
      sources.DEVSYNC_REMOTE_PATH = 'prompt'
    }
    values.DEVSYNC_REMOTE_PATH = validateRemotePath(values.DEVSYNC_REMOTE_PATH)
  } catch (err) {
    const password = values.DEVSYNC_PASSWORD
    const message = password ? err.message.split(password).join('[redacted]') : err.message
    throw new Error(`Setup could not complete: ${message}. Check the hosting details or run devsync setup --edit.`)
  } finally {
    if (transport) await transport.close()
  }
  for (const s of ENV_SCHEMA) {
    if (values[s.key] === undefined || values[s.key] === '') continue
    const value = s.type === 'secret' || s.key === 'DEVSYNC_PRIVATE_KEY' ? '[set]' : clean(values[s.key])
    log(`  ${s.key}=${value} (${sources[s.key]})`)
  }
  return { values, sources }
}

export function assertLocalFolder(localPath) {
  const real = fs.realpathSync(localPath)
  if (!fs.statSync(real).isDirectory()) throw new Error('Local source must be a directory')
  return real
}
