// Quick, transport-free check: walk the project and report what the
// matcher would allow to upload, what it would block, and the size totals.
// This is a "plan" without a server — the safe way to verify the blocklist
// against a real project before pointing devsync at a live host.

import fs from 'node:fs'
import path from 'node:path'
import { buildMatcher } from './src/ignore.js'

const projectRoot = process.argv[2]
if (!projectRoot) {
  console.error('usage: node check-blocklist.mjs <projectRoot>')
  process.exit(1)
}

const matcher = buildMatcher(projectRoot)

const eligible = []
const blocked = []
let eligibleBytes = 0
let blockedBytes = 0
let fileCount = 0
let dirCount = 0

function walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name)
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      if (matcher.shouldWatch(abs)) {
        dirCount++
        walk(abs)
      }
    } else if (e.isFile()) {
      fileCount++
      const rel = path.relative(projectRoot, abs).split(path.sep).join('/')
      const reason = matcher.reason(rel)
      let size = 0
      try { size = fs.statSync(abs).size } catch {}
      if (reason === null) {
        eligible.push({ rel, size })
        eligibleBytes += size
      } else {
        blocked.push({ rel, reason, size })
        blockedBytes += size
      }
    }
  }
}
walk(projectRoot)

const fmt = (n) => (n / 1024 / 1024).toFixed(2) + ' MB'
const kb = (n) => (n / 1024).toFixed(1) + ' KB'

console.log(`\nProject: ${projectRoot}`)
console.log(`  files:   ${fileCount}`)
console.log(`  dirs:    ${dirCount}`)
console.log(`  eligible: ${eligible.length} files, ${fmt(eligibleBytes)}`)
console.log(`  blocked:  ${blocked.length} files, ${fmt(blockedBytes)}`)

if (blocked.length) {
  console.log(`\nBlocked (by reason):`)
  const byReason = {}
  for (const b of blocked) {
    byReason[b.reason] = (byReason[b.reason] || 0) + 1
  }
  for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(15)} ${count}`)
  }
  console.log(`\nFirst 30 blocked files:`)
  for (const b of blocked.slice(0, 30)) {
    console.log(`  ${b.reason.padEnd(15)} ${b.rel}`)
  }
  if (blocked.length > 30) console.log(`  ... ${blocked.length - 30} more`)
}

console.log(`\nFirst 30 eligible files (by size, biggest first):`)
const top = [...eligible].sort((a, b) => b.size - a.size).slice(0, 30)
for (const e of top) {
  console.log(`  ${kb(e.size).padStart(10)}  ${e.rel}`)
}
if (eligible.length > 30) console.log(`  ... ${eligible.length - 30} more`)