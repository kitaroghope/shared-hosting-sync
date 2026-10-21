CREATE TABLE IF NOT EXISTS operation_locks (
  token TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT,
  remote_path TEXT,
  started_at TEXT NOT NULL
);
