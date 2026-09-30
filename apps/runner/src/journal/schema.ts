/** Slice 3 design §1.4 plus D23 (cancel_requested_at, result_branch, result_sha, applied_commands.detail) and D76 (last_push_attempt_at). */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  command TEXT NOT NULL,
  state TEXT NOT NULL,
  repo_key TEXT NOT NULL,
  branch TEXT,
  pid INTEGER,
  pgid INTEGER,
  nax_run_id TEXT,
  log_path TEXT,
  job_dir TEXT NOT NULL,
  assign_json TEXT NOT NULL,
  cancel_requested_at TEXT,
  result_branch TEXT,
  result_sha TEXT,
  last_push_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at TEXT,
  PRIMARY KEY (job_id, lease_epoch)
);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, lease_epoch, seq)
);
CREATE INDEX IF NOT EXISTS events_pending ON events (acked, job_id, lease_epoch, seq);
CREATE TABLE IF NOT EXISTS applied_commands (
  command_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
