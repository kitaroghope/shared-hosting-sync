import fs from 'node:fs'
import path from 'node:path'
import ignore from 'ignore'

export const DEPLOYIGNORE = '.deployignore'

/**
 * Never upload these, regardless of what .deployignore says.
 * This is the control that stops a secret reaching a live host.
 */
export const HARD_BLOCKLIST = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  '.git/',
  '.svn/',
  '.hg/',
  'node_modules/'
]

export const TEMPLATE = `# devsync — what gets uploaded.
# gitignore syntax. One pattern per line, ! negates.
# This is NOT .gitignore: these files are usually gitignored but still needed live.
#
# The hard blocklist always wins and cannot be overridden here:
${HARD_BLOCKLIST.map((p) => `#   ${p}`).join('\n')}

# --- secrets and local state (keep off the server) ---
*.local.php
*.sql
*.sqlite
*.sqlite3
*.dump
.env.production.local
config.local.php

# --- build scratch ---
/scratch/
/tmp/
/backups/
*.log
.devsync-uploading
.deployignore

# --- editor noise ---
.DS_Store
Thumbs.db
*.swp
*~
.idea/
.vscode/

# --- editorconfig: deploy it, it changes behaviour ---
# (.editorconfig is intentionally NOT ignored)
`

/** Always ignored, on top of the user's list. */
function alwaysIgnored() {
  return ignore().add(HARD_BLOCKLIST)
}

export function ensureDeployignore(projectRoot) {
  const file = path.join(projectRoot, DEPLOYIGNORE)
  if (!fs.existsSync(file)) fs.writeFileSync(file, TEMPLATE)
  return file
}

/**
 * Resolve which files are eligible for upload.
 * Returns { allowed(relativePath) -> bool, blocked(relativePath) -> string|null, ig }
 */
export function buildMatcher(projectRoot, { useGitignore = false } = {}) {
  ensureDeployignore(projectRoot)

  const base = alwaysIgnored()
  const user = ignore()

  const deployFile = path.join(projectRoot, DEPLOYIGNORE)
  user.add(fs.readFileSync(deployFile, 'utf8'))

  // .gitignore is opt-in. It is a starting template, never the authority:
  // .env and vendor/ are usually gitignored but still required live.
  const gitFile = path.join(projectRoot, '.gitignore')
  const git = ignore()
  if (useGitignore && fs.existsSync(gitFile)) {
    git.add(fs.readFileSync(gitFile, 'utf8'))
  }

  const toPosix = (abs) => path.relative(projectRoot, abs).split(path.sep).join('/')

  return {
    /**
     * null = upload, otherwise the reason it was skipped.
     * A pattern like `node_modules/` only matches a path ending in `/`, so a
     * directory is tested in both forms — otherwise the subtree is never gated.
     */
    reason(relPath) {
      if (relPath === '' || relPath === '.') return 'directory'
      const asDir = relPath.endsWith('/') ? relPath : relPath + '/'
      if (base.ignores(relPath) || base.ignores(asDir)) return 'blocklist'
      if (user.ignores(relPath) || user.ignores(asDir)) return DEPLOYIGNORE
      if (useGitignore && (git.ignores(relPath) || git.ignores(asDir))) return '.gitignore'
      return null
    },
    allowed(relPath) {
      return this.reason(relPath) === null
    },
    /** Chokidar predicate. Excluded directories are refused so chokidar never opens them. */
    shouldWatch(absPath) {
      const rel = toPosix(absPath)
      if (rel === '' || rel === '.') return true
      return this.reason(rel) === null
    },
    /** Directories excluded by policy — surfaced so they are visible, not silent. */
    blockedSample(limit = 20) {
      const out = []
      const walk = (dir, depth) => {
        if (depth > 3 || out.length >= limit) return
        let entries = []
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const abs = path.join(dir, e.name)
          const rel = toPosix(abs)
          if (e.isDirectory()) {
            if (base.ignores(rel + '/')) out.push(rel + '/')
            else walk(abs, depth + 1)
          } else if (base.ignores(rel)) {
            out.push(rel)
          }
          if (out.length >= limit) return
        }
      }
      walk(projectRoot, 0)
      return out
    }
  }
}