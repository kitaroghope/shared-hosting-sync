# devsync — roadmap

**Project root:** `D:\ai-helpers\devsync\`
**Date:** 14 October 2026

> Status legend — **BUILT** = shipped and installed · **DESIGNED, NOT BUILT** = planned, awaiting go · **BLOCKED** = needs a decision

---

## At a glance

| Phase | Scope | Status | Effort |
|---|---|---|---|
| 0 | v1 CLI (JSON config, SFTP/FTP, .deployignore, blocklist) | **BUILT** | done |
| 1 | v1 hardening — in-process test servers, .env policy, npm publish | **BUILT, gaps remain** | 1–2 days |
| 2 | v1.x deploy strategy — tarball-shell + zip-shell + parallel-files | **DESIGNED, NOT BUILT** | 2–3 days |
| 3 | v2 core — SQLite, project manager, envSchema, secrets, nodemon-style invocation | **DESIGNED, NOT BUILT** | 1 week |
| 4 | v2 server — loopback HTTP+WS, session token, REST routes | **DESIGNED, NOT BUILT** | 3–4 days |
| 5 | v2 UI — React, schema-generated forms, live log, error cards | **DESIGNED, NOT BUILT** | 1 week |
| 6 | v2 production — daemon, multi-project supervisor, graceful shutdown | **DESIGNED, NOT BUILT** | 3–4 days |
| 7 | v3 deferred — deploy history, rollback, webhooks, OS keychain | **DESIGNED, NOT BUILT** | later |

Total to v2.0 shipped: **~5–6 weeks** of focused work, building in order.

---

## Phase 0 — v1 CLI

**Status:** BUILT. Installed globally via `npm link`. 11 files, 14.3 kB tarball. 24/24 tests pass.

What's done:
- `devsync init / add / remove / projects / test / plan / sync / watch / doctor / ls / help`
- SFTP + FTP + FTPS transports
- `.deployignore` with the `ignore` package
- Hard blocklist (`.env*`, `*.pem`, `id_rsa`, `.git/`, `node_modules/`)
- Atomic write (`.devsync-uploading` → rename)
- Windows path → POSIX remote path mapping
- 400 ms debounce, serial upload queue

What's missing:
- No real network transfer was ever tested (no credentials, no SFTP server in tests)
- 3 bugs found and fixed by the offline test suite (directory-pattern semantics, inverted `collectFiles` filter, sync-command crash)

**Exit criteria for the phase:** all green. No open issues.

---

## Phase 1 — v1 hardening

**Status:** BUILT, gaps remain. 1–2 days.

What's done:
- `package.json` publishing metadata (name, repository, license, keywords, `publishConfig.access: public`)
- `LICENSE` (MIT)
- `prepack` test gate (`npm test` runs before any tarball build)
- 24-assertion offline test suite

What's missing — three things before publishing 0.1.0:

1. **In-process SFTP and FTP test servers.** `ssh2` (dev-only) and `ftp-srv` for end-to-end transfer tests. The single biggest gap in v1: every network path is unexercised. Without this, a regression in atomic write, in path mapping, or in the blocklist would only be caught by a user.
2. **`.env` policy decision** — your `EnvLoader.php` means your platform needs `.env` live. v1 hard-blocks it. The fix is one of:
   - per-project opt-in flag stored in config (off by default)
   - or upload once by hand, leave the rule alone
3. **npm publish.** `npm login`, enable 2FA, then `npm publish --access public` after `npm pack` validates the tarball. Verify with `npm i -g ./devsync-0.1.0.tgz`.

**Exit criteria:** real transfer passes in CI; `.env` story documented; tarball on npm; `devsync` works from a clean machine.

**Blockers before publishing:** the `.env` policy decision above + your GitHub repo URL (currently `YOUR-USERNAME` placeholder in `package.json`).

---

## Phase 2 — v1.x deploy strategy

**Status:** DESIGNED, NOT BUILT. 2–3 days. See `DEVNC-DEPLOY-PLAN.md`.

**Why this phase comes before v2:** the deploy story is the difference between a 5-minute first sync and a 3-second first sync. v2 is about *management*; this is about *getting the bits there fast*.

What ships:
- Capability probe (one `ssh.exec('echo ok')` per project, cached in the DB) — but v1 doesn't have a DB, so for v1.x it's cached in `config.json`
- `devsync deploy <label>` command
- `tarball-shell` strategy (default on SFTP with shell)
- `zip-shell` fallback (when `tar` is missing, `unzip` is present)
- `parallel-files` with `p-limit(4)` (FTP, or SFTP without shell)
- Staging directory + atomic `mv` swap
- `--max-bytes` (default 1 GB), `--keep-old` flags

Packages added: `tar`, `yazl`, `p-limit`. All pure JS, verified cross-platform.

**Exit criteria:** `devsync deploy` on a 5,000-file PHP project completes in <10 s on SFTP-with-shell. `devsync deploy` on a 5,000-file project on FTP completes in <5 min. The blocklist applies to the archive content (verified by a test that a tarball of a fake project contains zero `.env` entries).

---

## Phase 3 — v2 core (the daemon + storage)

**Status:** DESIGNED, NOT BUILT. ~1 week. See `DEVNC-PLAN-v2.md`.

This is the biggest single chunk. Everything else in v2 builds on it.

What ships:
- `node:sqlite` database at `~/.devsync/devsync.db` (WAL mode)
- Schema: `projects`, `secrets` (AES-256-GCM), `env_overrides`, `events`, `schema_meta`
- Migrations (idempotent, versioned)
- `ENV_SCHEMA` (single source of truth for `DEVSYNC_*` variables)
- `envResolver` (discovery order: `--env-file` → `DEVSYNC_ENV_FILE` → `.devsync.env` → `.env` (warns) → DB vault → UI prompt)
- `secrets.js` — AES-256-GCM with master key in `~/.devsync/master.key`
- Typed `DevsyncError` taxonomy (codes, userMessage, hint, retryable)
- `logger.js` — JSONL file + pretty console, correlation ids
- `backoff.js` — exponential + circuit breaker
- `ProjectManager` + `Runner` (one per project: watcher + queue + transport)
- Bare `devsync` invocation — canonicalise `cwd`, look up by `local_path`, attach or onboard
- `devsync daemon [start|stop|status]`
- `devsync ui [--port 4317]`
- Migration of v1 `config.json` → SQLite (renames, never deletes)

Dependencies on Phase 1: secrets-vault pattern, in-process test servers.

**Exit criteria:**
- `devsync` (no args) inside a registered project attaches to it
- `devsync` inside an unknown folder opens onboarding
- `devsync daemon` supervises 3 projects, one fails, others keep going
- v1 config.json migrates without losing projects or paths
- A test asserts a project that hit 5 transport errors in a row moves to `error` and the daemon does not retry without user input

---

## Phase 4 — v2 server (HTTP + WS)

**Status:** DESIGNED, NOT BUILT. 3–4 days.

What ships:
- HTTP server bound to `127.0.0.1`, port auto-increments if 4317 is taken
- Per-start random session token written to `~/.devsync/session.token`
- Token required on all mutating routes via header
- REST routes: `GET/POST/PATCH/DELETE /api/projects`, `POST /api/projects/:id/{connect,sync,plan,pause,resume}`, `GET /api/projects/:id/{env,events}`, `POST /api/projects/:id/browse`
- WebSocket `/ws` with structured messages `{type, projectId, payload}`
- Replay last 200 events on WS reconnect

Packages: `ws`, `express`, `zod`.

**Exit criteria:**
- `curl http://127.0.0.1:4317/api/projects` returns a JSON list
- Mutating route without token returns 401
- WS client receives live status events as a project's state changes
- Bind address is `127.0.0.1` only (test: `curl 0.0.0.0:4317` fails)

---

## Phase 5 — v2 UI

**Status:** DESIGNED, NOT BUILT. ~1 week.

Stack decision pending: **React + Vite + TypeScript** (recommended) vs zero-build vanilla.

What ships:
- Layout: sidebar (projects + status) | main (tabs: Overview / Settings / Activity / Errors)
- Status dots matching the v1 lifecycle
- Settings tab auto-generated from `ENV_SCHEMA` — labels, types, help text, secret masking, inline validation
- Browse control next to remote path (the path-finder feature)
- Live log over WS — pause, filter, search
- Error cards — `userMessage`, `hint`, Retry button, copy diagnostics
- Onboarding flow for unknown folders
- Vite build output shipped in `ui-dist/`

**Exit criteria:**
- A user with no terminal can: add a project, fill in env, run a plan, run a sync, see the result, recover from an error
- All screens render at 1280×720 and at 360×640 (mobile)
- Light leaks to dark: zero

---

## Phase 6 — v2 production

**Status:** DESIGNED, NOT BUILT. 3–4 days.

What ships:
- Long-lived `devsync daemon` that survives all foreground `devsync` invocations exiting
- Cross-process IPC between foreground CLI and daemon (over the same loopback HTTP+WS)
- Graceful shutdown: stop watchers, drain queues, close transports, flush logs
- Reconnect-on-restart: a project that was watching resumes automatically
- Boot persistence: which projects are enabled, which are paused

**What I'm deliberately NOT shipping in v2:** a Windows service / macOS launchd / Linux systemd unit. Users start the daemon manually. Auto-start is a v3+ problem.

**Exit criteria:**
- `devsync daemon start` then closing the terminal — `devsync` from a project still attaches
- `devsync daemon stop` — all in-flight uploads finish or are marked failed
- A crash of the foreground CLI does not stop watching

---

## Phase 7 — v3 deferred

**Status:** DESIGNED, NOT BUILT. Built only on demand.

- **Deploy history with rollback slot** — `<remote>/.devsync-versions/`, keep last N
- **Resumable uploads** — SFTP doesn't support `Range`; would need a hand-rolled protocol
- **Webhooks** — POST to a URL on deploy success / failure
- **OS keychain** for the master key — DPAPI (Windows), libsecret (Linux), Keychain (macOS), each with a fallback
- **Per-host profiles** — multiple servers per project (staging, prod, etc.)
- **Self-update** — `devsync update` to fetch the latest from npm

---

## Decisions still open

These block later phases. Marking them clearly so they don't get lost.

| Decision | Affects | Recommended |
|---|---|---|
| Your GitHub username (placeholder `YOUR-USERNAME` in `package.json`) | Phase 1 | ask before publish |
| `.env` policy for projects that need it (your Omada app) | Phase 1 | per-project opt-in flag, off by default |
| UI stack — React+Vite vs zero-build vanilla | Phase 5 | React+Vite |
| Bare `devsync` behaviour — foreground vs detach-to-daemon | Phase 3 | foreground (nodemon feel) |
| Folder picker + remote browser in v2.0 or v2.1 | Phase 5 | v2.1 |
| Ship v1 to npm first, or jump straight to v2? | sequencing | ship v1 after the test-server gap is closed, then build v2 |

---

## How the phases are ordered

```
Phase 1   harden & publish v1     ◄─── what to do this week
   ↓
Phase 2   deploy strategy          ◄─── next week
   ↓
Phase 3   v2 core (DB, manager)    ◄─── biggest single chunk
   ↓
Phase 4   v2 server (HTTP+WS)
   ↓
Phase 5   v2 UI
   ↓
Phase 6   v2 production daemon
   ↓
Phase 7   v3 deferred              ◄─── built only if you need it
```

**Stop points worth knowing about:**

- After **Phase 1** — you can publish, share with collaborators, and use it for real
- After **Phase 2** — first-time deploy is fast, the rest of the year is just `devsync watch`
- After **Phase 3** — multi-project, persisted state, typed errors. Most of the value of v2 is here
- After **Phase 5** — non-terminal users can use it
- **Phase 6 is a polish phase**, not a feature phase. Don't ship without it, but it doesn't change the day-to-day
- **Phase 7 is whatever you ask for**

## Why not jump straight to v2

Tempting, but: v1's network path is untested. Before v2 changes the architecture, the current one should be proven end-to-end with an in-process server. That's Phase 1, and it pays for itself the first time you ship a fix and don't have to ask a user to verify it.
---

## Phase 4b � user-controlled ignore patterns (post 2026-10-19 UI request)

**Status:** DESIGNED, NOT BUILT.
**Effort estimate:** 3�5 hours total (UI + 1 new route + tests + a starter-templates dropdown). No DB schema change required.

### What's already in place (no duplication)

- **Hard blocklist** in src/ignore.js (.env*, *.pem, *.key, .git/, 
ode_modules/, etc.) � non-overridable. Already audited and surfaced in plan output.
- **.deployignore** per project (gitignore syntax) � read by uildMatcher via the ignore library.
- **Blocklist preview** in devsync plan � matcher.blockedSample() already lists the first 20 user-visible blocked paths. This is the seed for the preview UI.
- **Blocklist reason field** in the matcher (locklist / .deployignore / .gitignore) � the UI can colour-code by source.

### What's missing (the actual ask)

1. No way to *edit* .deployignore from inside devsync. The user has to open the project folder in a text editor today.
2. No way to *preview* the full ignore set ("if I add dist, would dist/server.js stop uploading?").
3. No way to *click-to-ignore* from Browse. User sees a folder, decides it's not for the server, has to switch to the text editor.

### Three options on the table

| # | Option | Pros | Cons | Effort |
|---|---|---|---|---|
| A | **Edit .deployignore from the UI** � a textarea in the project pane, plus a "preview matches" panel that runs uildMatcher against the local tree and shows every file/dir currently ignored + why. Plus a small "presets" dropdown that pre-fills the textarea with templates (Vite/Node/PHP/Python/Go). | Single source of truth stays in the project (version-controllable, hand-editable). No data-model change. Reuses uildMatcher exactly. | Doesn't solve click-to-ignore in Browse. | ~3h |
| B | **Store ignore patterns in the DB** as a separate ignore_patterns table (project_id, pattern, is_dir, created_at). UI edits the table directly. | DB-driven, can be edited even if project folder is read-only. | New schema + migration. Loses version control. Two sources of truth (.deployignore + DB). | ~5h |
| C | **Click-to-ignore in Browse** � in the Browse panel, hovering a folder shows an "ignore" pill that appends the path to .deployignore. | Smallest cognitive load. Matches the GitHub "ignore this file" affordance. | Heavier UI; needs a "show ignored" mode so users can see what's already excluded; still requires A for the bulk of the editing. | ~6h |

### Recommendation

**A + C combined, in that order.** A first (textarea + presets + preview), then C (click-to-ignore) once A is verified.

A's "presets" dropdown is the high-leverage piece � for a brand-new project, picking "Vite + PHP" writes ~20 sensible patterns, the user only edits the few that don't fit. That alone kills the "what do I ignore?" anxiety.

### Open questions for you (need answers before building)

1. **Live-write to .deployignore on Save, or staged preview?** Recommendation: staged preview first ("here's what would change"), then a single Save button � matches the rest of the form's behaviour.
2. **Presets to ship?** Recommendation: Vite/React, Next.js, PHP/WordPress, Python/Django, Go, "blank". One button each.
3. **Show the hard blocklist in the preview panel?** Recommendation: yes, but greyed out and labelled "non-overridable" so users understand why their !.env line is silently ignored.
4. **Should ignore affect devsync plan / sync / watch all the same?** Recommendation: yes � same matcher reused everywhere. No new code paths.

### Implementation outline (if approved)

1. src/server/ignore.js (new) � GET/PUT /api/projects/:id/ignore reads/writes <localPath>/.deployignore, returns the file body plus a preview JSON computed server-side so the UI doesn't have to walk the tree.
3. UI panel "Ignore patterns" � textarea, presets dropdown, live preview block ({ path, reason }[]).
4. Update devsync plan CLI output to include the count of .deployignore-filtered paths in the summary line (no logic change; just surfaces it).
5. Tests: 	est/ignore-routes.test.js � read, write round-trip, presets, preview correctness against a small fixture tree.

