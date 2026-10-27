-- Persistent sync metadata scoped to the project source and hosting destination.
CREATE TABLE sync_targets (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  scanned_at TEXT,
  PRIMARY KEY (project_id, target_key)
);
CREATE TABLE sync_files (
  project_id INTEGER NOT NULL,
  target_key TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  ctime_ms REAL NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (project_id, target_key, relative_path),
  FOREIGN KEY (project_id, target_key) REFERENCES sync_targets(project_id, target_key) ON DELETE CASCADE
);
