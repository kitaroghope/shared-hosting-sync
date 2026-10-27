import fs from 'node:fs'

export const fingerprint = (stat) => ({ size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
export const sameFile = (a, b) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
export function currentFingerprint(abs) {
  try { const stat = fs.statSync(abs); return stat.isFile() ? fingerprint(stat) : null }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

