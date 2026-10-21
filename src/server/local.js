import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/** Directory-only picker, independent of the folder used to launch the UI. */
export async function browseLocal(requestedPath) {
  const target = requestedPath || os.homedir()
  if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Enter an absolute local folder path')
  const current = await fs.realpath(target)
  if (!(await fs.stat(current)).isDirectory()) throw new Error('Select a local folder, not a file')
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name))
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const roots = process.platform === 'win32'
    ? (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
      const root = `${letter}:\\`
      try { return (await fs.stat(root)).isDirectory() ? root : null } catch { return null }
    }))).filter(Boolean)
    : ['/']
  const parent = path.dirname(current)
  return { path: current, parent: parent === current ? null : parent, home: os.homedir(), roots, entries }
}
