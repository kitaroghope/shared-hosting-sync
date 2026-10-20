# devsync — SQLite schema (discussion draft)

**Date:** 14 October 2026 · **Phase:** 3 (v2 core) · **Status:** design discussion

This is *not* a final schema. It's what I'd ship if you said "go" tomorrow, with the open questions marked so we can argue about them.

---

## What goes in the DB vs on disk

Before the table list, the split — because the wrong call here ripples through everything.

| Lives in SQLite (`~/.devsync/devsync.db`) | Lives in `~/.devsync/` as files |
|---|---|
| Projects, env overrides, secrets, events, schema version | Master AES key, session token, JSONL debug log, daemon config, SQLite WAL/SHM |
| Queryable, transactional, capped | Append-only, log-rotation, OS-ACL-friendly |

**Rule of thumb:** if it's relational, transactional, or bounded, it goes in SQLite. If it's a blob you'd `cat` or `tail`, it stays on disk.

---

## The proposed schema

```sql
-- 1. Schema version
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 2. The project registry
CREATE TABLE projects (
  id                INTEGER PRIMARY KEY,
  label             TEXT NOT NULL UNIQUE,
  local_path        TEXT NOT NULL UNIQUE,        -- canonical realpath
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,                -- ISO 8601 UTC
  updated_at        TEXT NOT NULL,

  -- Runtime state (denormalised cache; events table is source of truth)
  last_status       TEXT NOT NULL DEFAULT 'idle',  -- one of STATUS enum
  last_error        TEXT,
  last_sync_at      TEXT,
  last_upload_bytes INTEGER,

  -- Capability probe cache
  probe_shell       INTEGER,                      -- NULL = not yet probed
  probe_tar         INTEGER,
  probe_unzip       INTEGER,
  probe_at          TEXT
);

CREATE INDEX idx_projects_local_path ON projects(local_path);
CREATE INDEX idx_projects_enabled    ON projects(enabled);

-- 3. Encrypted secrets (one row per project; all creds in one blob)
CREATE TABLE secrets (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,                       -- base64 AES-256-GCM
  iv         TEXT NOT NULL,                       -- base64 12-byte IV
  auth_tag   TEXT NOT NULL,                       -- base64 16-byte GCM tag
  updated_at TEXT NOT NULL
);

-- 4. Per-project env overrides (what the UI sets; merged with discovered files)
CREATE TABLE env_overrides (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT   NOT NULL,
  value       TEXT,                               -- NULL when is_secret=1
  is_secret   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT   NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- 5. Events (status transitions, uploads, errors, transport events)
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts          TEXT    NOT NULL,                   -- ISO 8601 UTC
  level       TEXT    NOT NULL,                   -- debug|info|warn|error
  kind        TEXT    NOT NULL,                   -- status|upload|watch|config|transport|system
  message     TEXT    NOT NULL,
  file        TEXT,                                -- optional
  bytes       INTEGER,                            -- optional
  duration_ms INTEGER,                            -- optional
  error_code  TEXT                                -- optional
);

CREATE INDEX idx_events_project_ts ON events(project_id, ts DESC);
CREATE INDEX idx_events_ts         ON events(ts DESC);
CREATE INDEX idx_events_kind       ON events(project_id, kind, ts DESC);
```

That's 5 tables, 5 indexes, ~20 columns. About 200 lines of schema + indexes including migrations.

---

## Why each table looks the way it does

### `projects.last_status` is denormalised

The events table is the source of truth. The `last_status` column is a **cache** for the sidebar dot, so we don't have to query events on every UI render. It is updated in the **same transaction** that writes the status event. If the runner crashes between writing the event and updating the cache, the worst that happens is a stale dot until the next event — the data is not lost.

**Alternative considered:** drop the cache, query events every time. Cheaper to reason about, but means a JOIN or subquery on every project list call. With N=10 projects it doesn't matter; with N=1000 it does.

### `secrets` is one row, not one row per credential

Three approaches were on the table:

| Approach | Pros | Cons |
|---|---|---|
| One row per credential (host, port, user, password, key) | Simple to update one field | Need to encrypt per field; harder to rotate the whole record atomically |
| One row per project, all creds in one encrypted blob | Atomic rotation; one cipher; one place to look | Have to decrypt the whole blob to read one field |
| Don't store — read from `.env` every time | No storage, no encryption needed | Defeats the "credentials come from the UI" requirement |

**Recommendation:** the single-blob approach. We always need the *whole* credential set to open a transport, so there's no point splitting it.

### `env_overrides` is per-key, not a JSON blob

Same trade-off as secrets. The UI needs to edit one field at a time and show validation inline. A JSON blob forces the UI to deserialise the whole thing on every keystroke. Per-key rows are also where we'd add per-key audit later if needed.

**Important:** the *effective* env a runner sees is built by merging the discovered env file with the overrides — the DB never replaces the file, it overlays it. Override semantics documented in code.

### `events` carries denormalised context (file, bytes, error_code)

A flat row is fast to render and to filter. Storing these as JSON would be more flexible, but the UI only ever needs a small set of known shapes, and JOINing events against a meta table is the kind of "clever" you regret by year two. Keep it flat.

### `schema_meta` is just a kv table, not a real migrations table

Migrations are a stack of `001_init.sql`, `002_events_index.sql`, etc. On open, the DB layer checks `schema_meta.value WHERE key='version'` and applies any missing files in order. No "applied_at" table is needed because the DB file's `mtime` and the `version` row together are enough.

---

## Open design questions

These are the calls I'd argue for. Push back on any.

### 1. Events cap — per-project or global?

**My pick: 5,000 per project, oldest pruned on insert.**
- Per-project cap means a single chatty project can't crowd out quiet ones
- Global cap means a healthy sum budget, but one bad day fills the cap
- 5,000 is ~one day of normal activity; old enough to debug from, cheap to render

### 2. Watch-state resumption

The v1 watcher is in-memory. After a daemon restart, it has to re-scan the whole tree to compute a baseline. That's fine for small projects; for a 50,000-file project it's a few seconds of stuttering.

**My pick: don't persist watcher state in v2.0.** The `chokidar` native `fs.watch` on each platform is fast enough on the second start. If profiling later shows it's a problem, we add a `watcher_state` table — but adding it speculatively is the kind of thing that ends up wrong.

### 3. Soft delete vs hard delete

**My pick: hard delete with a 30-day grace folder.** When a project is deleted via `DELETE /api/projects/:id`, the database row and secrets/events go. The local project folder is untouched (we never owned it). A "trash" of recent deletions lives in `~/.devsync/trash/<timestamp>-<label>/` for 30 days, then purged. If you really delete a project, you can ask the daemon to undelete from the trash.

This avoids the "soft delete makes the schema gross" problem while still being forgiving.

### 4. Stats — denormalised or derived from events

Currently I have `last_sync_at` and `last_upload_bytes` on `projects`. Could also have `upload_count_today`, `bytes_today`, etc.

**My pick: only the two I listed.** Everything else is a `SELECT … FROM events … WHERE project_id = ? AND ts > ?` query. SQLite is fast at that; pre-aggregating just adds columns that have to be kept in sync.

### 5. Multi-user / multi-machine

**My pick: not in v2.** One user account on one machine. The DB file is in `~/.devsync/`, owned by the user, mode 0600-ish on Unix. If you want to share config across machines, sync the directory with whatever you already use (rsync, iCloud, etc.) — we don't build that.

### 6. JSON in env_overrides.value?

`env_overrides.value` is `TEXT`. A complex env value (e.g. a JSON-encoded private key) would be stored as the string itself. When we display or edit it, we don't try to validate the structure — the env resolver does that when the runner boots.

**My pick: TEXT, no JSON. The validation lives in `ENV_SCHEMA` and the resolver, not the DB.**

### 7. Per-project event retention

A long-running project accumulates 5,000 events. What about a year-old project? Does the DB ever compact? **My pick: never compact in v2.** 5,000 × N projects × ~250 bytes = manageable. `VACUUM` on explicit user request.

### 8. The session token

**My pick: in a file, not in the DB.** It's not relational, it's a secret, and it should be readable by the daemon process only. `~/.devsync/session.token` mode 0600. UI bootstraps by `GET /api/session` from same-origin — it doesn't need the DB.

---

## The schema decisions worth changing your mind about

| Choice | If you disagree | Trade-off |
|---|---|---|
| One-blob secrets | Per-field rows | Loses atomic rotation, gains per-field UI without decrypt |
| Per-project event cap | Global cap | Loses per-project isolation, gains predictable total size |
| `last_status` cache | Query events on every read | Loses O(1) sidebar, gains no cache-staleness bugs |
| Hard delete + 30-day trash | Soft delete (`deleted_at` column) | Loses instant undelete, gains a simpler schema |
| TEXT for env values | JSON-typed values | Loses nested objects in env, gains `ENV_SCHEMA` as the only validator |
| No persisted watcher state | A `watcher_state` table | Loses faster restart on huge trees, gains one less thing to reason about |

---

## What I'd ship in milestone 3a (storage + env)

1. `db.js` — `node:sqlite` wrapper, WAL, foreign keys, prepared statements
2. `migrations/001_init.sql` — the schema above, applied idempotently
3. `migrations/002_secrets_columns.sql` etc. — empty for now, but the directory exists
4. `envSchema.js` — the `ENV_SCHEMA` constant + the `validate()` function
5. `envResolver.js` — the discovery chain
6. `secrets.js` — encrypt/decrypt with `node:crypto`
7. `db.test.js` — migrations, CRUD, cascades
8. `envSchema.test.js` — every type, the warning cases
9. `secrets.test.js` — round-trip + wrong-key failure
10. Manual: insert a row, query it back, see it survive a daemon restart

That's the only DB-aware code in v2. Everything else (the UI, the daemon, the runners) reads from this layer.

---

## What I want from you

A decision on each of the **five** open questions above, especially the events cap and the soft-vs-hard delete. The rest have a default I'd ship; push back on whichever feels wrong.