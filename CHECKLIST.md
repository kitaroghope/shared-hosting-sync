# devsync — phase goals checklist

Every box is testable. A phase is done when every box in it is checked and the exit criteria are met.

---

## Phase 0 — v1 CLI

> Status: **BUILT**. The boxes here are the ones that are checked. Anything unchecked is a known gap.

- [x] `devsync init` creates `~/.devsync/`
- [x] `devsync add` / `remove` / `projects` CRUD on JSON config
- [x] `devsync test` connects and lists the remote root
- [x] SFTP transport (ssh2-sftp-client) — connect, list, ensureDir, put, rename, delete
- [x] FTP / FTPS transport (basic-ftp)
- [x] `.deployignore` honoured via the `ignore` package
- [x] Hard blocklist refuses `.env*`, `*.pem`, `id_rsa`, `.git/`, `node_modules/`
- [x] Atomic write: `.devsync-uploading` → rename
- [x] Windows path → POSIX remote path mapping
- [x] 400 ms debounce + serial upload queue
- [x] Globally installed via `npm link`
- [x] 24/24 offline tests pass (`node test/ignore.test.js`)

**Exit criteria:** ✅ all green.

---

## Phase 1 — v1 hardening

- [ ] `ssh2` (devDep) and `ftp-srv` (devDep) installed
- [ ] Test: spin an in-process SFTP server, upload a fixture, assert bytes match
- [ ] Test: in-process FTP server, same shape
- [ ] Test: atomic write — kill the connection mid-upload, assert no half-file on the server
- [ ] Test: hard blocklist — pack a fixture with a `.env` and an `id_rsa`, assert neither reaches the server
- [ ] Test: per-file plan — given a known remote, the right set is computed
- [ ] `.env` policy decision: per-project opt-in flag, OR "upload once by hand"
- [ ] `.env` opt-in implemented if chosen (flag in `~/.devsync/config.json` per project)
- [ ] `package.json` `repository` and `bugs` URLs point at a real GitHub repo
- [ ] `npm login`, 2FA enabled, automation token stored
- [ ] `npm pack` produces a 14–16 kB tarball
- [ ] `npm i -g ./devsync-0.1.0.tgz` installs on this machine
- [ ] `devsync doctor` from the installed tarball — clean
- [ ] `npm publish --access public` → package live on npm
- [ ] A clean `nvm`-style install on a different OS works (one macOS or Linux machine, not just Windows)

**Exit criteria:** real transfers pass in CI; `.env` story documented and tested; package on npm; installs cleanly on a second machine.

---

## Phase 2 — v1.x deploy strategy

- [ ] `devsync deploy <label>` command
- [ ] Capability probe: `ssh.exec('echo ok')`, cached in `~/.devsync/config.json` per project
- [ ] Tool probe: `command -v tar`, `command -v unzip` — result cached alongside the shell probe
- [ ] `tarball-shell` strategy: pack with `tar` (npm), upload, `tar -xzf` on remote
- [ ] `zip-shell` strategy: pack with `yazl`, upload, `unzip -qo` on remote
- [ ] `parallel-files` strategy: per-file upload with `p-limit(4)`
- [ ] Auto-pick: shell + tar → tarball-shell; shell + no-tar + unzip → zip-shell; no shell → parallel-files
- [ ] Atomic staging: extract to `.devsync-staging-<ts>/`, then `mv` to final
- [ ] Stale-tree guard: `mv <project> <project>.old-<ts>` before swap; never auto-merge
- [ ] `--max-bytes` (default 1 GB) refuses oversized archives
- [ ] `--keep-old` preserves the `.old-<ts>` tree
- [ ] Archive content respects the same matcher + hard blocklist as per-file
- [ ] Test: a tarball of a fixture with `.env` and `id_rsa` contains zero such entries
- [ ] Test: simulate transport failure mid-archive-upload, fall back to parallel-files, no half-state on the server
- [ ] Cleanup of staging tarball and staging dir happens on success
- [ ] On extraction failure, staging dir is removed and the live tree is untouched
- [ ] `devsync deploy` printed strategy is logged for debugging

**Exit criteria:** first-time deploy of a 5,000-file PHP project is <10 s on SFTP-with-shell; the blocklist is enforced inside the archive; a failed tarball does not corrupt the live tree.

---

## Phase 3 — v2 core

### 3a — Storage + env

- [ ] `node:sqlite` DB at `~/.devsync/devsync.db`, WAL mode, `foreign_keys=ON`
- [ ] Schema: `projects`, `secrets`, `env_overrides`, `events`, `schema_meta`
- [ ] Migrations are versioned and idempotent
- [ ] `ENV_SCHEMA` is the single source of truth (typed, with help text, defaults, type checks)
- [ ] `envResolver` honours the discovery order: `--env-file` → `DEVSYNC_ENV_FILE` → `.devsync.env` → `.env` (warns) → DB vault → UI prompt
- [ ] Unknown `DEVSYNC_*` keys warn, don't error; non-prefixed keys are ignored
- [ ] Secrets encrypted with `node:crypto` AES-256-GCM; master key in `~/.devsync/master.key` with restrictive ACLs
- [ ] `secrets.js` encrypts / decrypts / rotates
- [ ] `~/.devsync/` ships a `.gitignore`-style warning when permissions are wider than the user

### 3b — Error + reliability

- [ ] `DevsyncError` base + 7 subclasses (Env, Auth, Network, RemotePath, Permission, Upload, DiskFull)
- [ ] Each carries `code`, `userMessage`, `hint`, `retryable`, `cause`
- [ ] `logger.js` writes JSONL to `~/.devsync/logs/devsync.log` AND pretty to console
- [ ] Correlation id per operation, included in every log line
- [ ] `backoff.js`: 1 → 2 → 4 → 8 → 16 → 30s, reset on success
- [ ] Circuit breaker opens after 5 consecutive transport failures

### 3c — Process model

- [ ] `ProjectManager` supervises N `Runner`s
- [ ] `Runner` owns one watcher, one transport, one queue
- [ ] Bare `devsync` resolves `cwd` to a canonical realpath, looks it up in the DB
- [ ] Unknown path → onboarding entry point
- [ ] Known path → attach to the existing project
- [ ] `Ctrl+C` stops one runner only; daemon and other runners keep going
- [ ] `devsync daemon [start|stop|status]`
- [ ] One failing project never breaks the daemon

### 3d — Migration

- [ ] First run reads `~/.devsync/config.json` and imports projects into SQLite
- [ ] Original `config.json` renamed to `config.json.migrated` — never deleted
- [ ] Re-running the migration is a no-op

**Exit criteria:** `devsync` from a project attaches to it; unknown folder opens onboarding; three projects in one daemon, one fails, two keep going; v1 config.json migrates without losing anything; circuit breaker test passes.

---

## Phase 4 — v2 server

- [ ] HTTP server bound to `127.0.0.1` only (test: `curl 0.0.0.0:4317` fails)
- [ ] Port auto-increments if 4317 is taken
- [ ] Random session token written to `~/.devsync/session.token` on start
- [ ] Token required as header on all mutating routes
- [ ] Same-origin UI reads the token via `GET /api/session` on boot
- [ ] `GET /api/projects` returns the project list
- [ ] `POST /api/projects` registers a project
- [ ] `PATCH /api/projects/:id` updates label, remotePath, transport, enabled
- [ ] `DELETE /api/projects/:id` removes
- [ ] `POST /api/projects/:id/connect` reconnects, bypassing backoff
- [ ] `POST /api/projects/:id/sync` and `/plan`
- [ ] `GET /api/projects/:id/env` returns schema + current values (secrets masked)
- [ ] `PUT /api/projects/:id/env` validates, persists, reconnects
- [ ] `GET /api/projects/:id/events` returns recent history
- [ ] `POST /api/projects/:id/browse` lists a remote directory (the path-finder)
- [ ] WebSocket `/ws` with structured messages `{type, projectId, payload}`
- [ ] Reconnect replays last 200 events
- [ ] WS message types: `status`, `event`, `plan`, `error`, `project.updated`

**Exit criteria:** `curl` tests for every route pass; mutating-without-token returns 401; WS receives live status changes; bind address is verified loopback-only.

---

## Phase 5 — v2 UI

### 5a — Shell

- [ ] Layout: sidebar (projects + status) | main (tabs: Overview / Settings / Activity / Errors)
- [ ] Status dots match the v2 lifecycle: idle / connecting / watching / uploading / error / paused
- [ ] Empty states for no projects, no events, no errors
- [ ] Responsive: 1280×720 and 360×640 both render cleanly

### 5b — Settings

- [ ] Form generated from `ENV_SCHEMA`
- [ ] Labels, help text, correct input types, inline validation
- [ ] Secret fields masked with reveal toggle
- [ ] Validation errors name the exact variable
- [ ] "Test connection" button next to host / port
- [ ] **Browse** control next to remote path (uses `/api/projects/:id/browse`)

### 5c — Activity + Errors

- [ ] Live log over WS, virtualised (1,000+ lines don't die)
- [ ] Pause / filter by level / filter by file / search
- [ ] Error cards: `userMessage`, `hint`, Retry button, Copy diagnostics
- [ ] Pending-upload preview on Overview
- [ ] Throughput sparkline for the session

### 5d — Build

- [ ] Vite + React + TypeScript
- [ ] `npm run build` produces `ui-dist/`
- [ ] `ui-dist/` is in `package.json` `files`
- [ ] `prepack` runs the build before the tarball is created

**Exit criteria:** a non-terminal user can add a project, fill env, run a plan, run a sync, see the result, recover from an error. All without touching the terminal.

---

## Phase 6 — v2 production

- [ ] `devsync daemon` survives all foreground CLI invocations exiting
- [ ] Foreground CLI talks to the daemon over loopback HTTP+WS
- [ ] Graceful shutdown: stop watchers, drain in-flight uploads, close transports, flush logs, close DB
- [ ] Crash of foreground CLI does not stop watching
- [ ] Boot persistence: which projects are enabled and paused survives restart
- [ ] Reconnect on restart: a project that was watching resumes automatically
- [ ] `devsync daemon stop` — all in-flight uploads finish or are marked failed, then exit 0

**What I am NOT shipping in v2:** OS service integration (systemd, launchd, Windows service). Auto-start is a v3 problem.

**Exit criteria:** `devsync daemon start` → close terminal → `devsync` from a project still attaches. `devsync daemon stop` returns exit 0 cleanly.

---

## Phase 7 — v3 deferred

- [ ] Deploy history: keep last N deploys in `<remote>/.devsync-versions/`
- [ ] One-click rollback from the UI
- [ ] Resumable uploads (would need a hand-rolled SFTP protocol extension)
- [ ] Webhook on deploy success / failure
- [ ] OS keychain for the master key (DPAPI / libsecret / Keychain) with file-key fallback
- [ ] Per-host profiles (multiple servers per project — staging, prod, etc.)
- [ ] `devsync update` self-update

These are **DESIGNED, NOT BUILT** and are only built on demand.