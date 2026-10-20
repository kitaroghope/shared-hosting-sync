-- 001_init.sql — initial devsync v2 schema.
-- Mirrors DB-SCHEMA.md §"The proposed schema" (5 tables, 4 indexes).

CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE projects (
  id                INTEGER PRIMARY KEY,
  label             TEXT NOT NULL UNIQUE,
  local_path        TEXT NOT NULL UNIQUE,        -- canonical realpath
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,                -- ISO 8601 UTC
  updated_at        TEXT NOT NULL,

  last_status       TEXT NOT NULL DEFAULT 'idle', -- idle|planning|syncing|watching|error
  last_error        TEXT,
  last_sync_at      TEXT,
  last_upload_bytes INTEGER,

  probe_shell       INTEGER,                      -- capability probes; NULL = not probed
  probe_tar         INTEGER,
  probe_unzip       INTEGER,
  probe_at          TEXT
);

CREATE INDEX idx_projects_enabled ON projects(enabled);

-- Encrypted creds for a project (one row, one cipher blob).
CREATE TABLE secrets (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,                       -- base64 AES-256-GCM
  iv         TEXT NOT NULL,                       -- base64 12-byte IV
  auth_tag   TEXT NOT NULL,                       -- base64 16-byte GCM tag
  updated_at TEXT NOT NULL
);

-- Per-key env overrides. value is NULL when is_secret=1 (the secret is in
-- the secrets table, not here).
CREATE TABLE env_overrides (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT   NOT NULL,
  value       TEXT,
  is_secret   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT   NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- Events: status transitions, uploads, errors, transport, etc.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ts          TEXT    NOT NULL,                   -- ISO 8601 UTC
  level       TEXT    NOT NULL,                   -- debug|info|warn|error
  kind        TEXT    NOT NULL,                   -- status|upload|watch|config|transport|system
  message     TEXT    NOT NULL,
  file        TEXT,
  bytes       INTEGER,
  duration_ms INTEGER,
  error_code  TEXT
);

CREATE INDEX idx_events_project_ts ON events(project_id, ts DESC);
CREATE INDEX idx_events_kind       ON events(project_id, kind, ts DESC);

INSERT INTO schema_meta (key, value) VALUES ('version', '1');