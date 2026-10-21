#!/usr/bin/env node
// Keep unsupported runtimes out of imports that require built-in SQLite.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('shared-hosting-sync requires Node.js 24 or newer. Upgrade Node.js and run the command again.')
  process.exitCode = 1
} else {
  await import('./cli.js')
}
