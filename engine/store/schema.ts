import type Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stream_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      previous_id INTEGER REFERENCES events(id),
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      metadata TEXT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
      actor TEXT,
      UNIQUE(stream_id, sequence)
    );

    CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

    -- Immutability enforcement: events are append-only
    CREATE TRIGGER IF NOT EXISTS prevent_event_update
    BEFORE UPDATE ON events
    BEGIN
      SELECT RAISE(ABORT, 'Events table is append-only: UPDATE not allowed');
    END;

    CREATE TRIGGER IF NOT EXISTS prevent_event_delete
    BEFORE DELETE ON events
    BEGIN
      SELECT RAISE(ABORT, 'Events table is append-only: DELETE not allowed');
    END;

    CREATE TABLE IF NOT EXISTS task_state (
      task_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      worker_id TEXT,
      gate INTEGER NOT NULL,
      model TEXT NOT NULL,
      description TEXT,
      depends_on TEXT,
      touches_files TEXT,
      prompt_hash TEXT,
      output_hash TEXT,
      claimed_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      cost_usd REAL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      failure_reason TEXT,
      retry_count INTEGER DEFAULT 0,
      CHECK(status IN ('pending', 'claimed', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'timeout'))
    );

    CREATE TABLE IF NOT EXISTS file_reservations (
      file_path TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES task_state(task_id),
      reserved_at TEXT NOT NULL,
      released_at TEXT
    );

    CREATE TABLE IF NOT EXISTS context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      written_by TEXT NOT NULL,
      written_at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS execution_cache (
      manifest_hash TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      git_tree_before TEXT NOT NULL,
      git_tree_after TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      output_log TEXT,
      vcr_conversation_id TEXT,
      cost_usd REAL,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );

    CREATE TABLE IF NOT EXISTS vcr_cassettes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      request_body TEXT NOT NULL,
      response_body TEXT NOT NULL,
      response_status INTEGER NOT NULL DEFAULT 200,
      response_headers TEXT,
      model TEXT NOT NULL,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
      UNIQUE(conversation_id, sequence_number)
    );

    CREATE INDEX IF NOT EXISTS idx_vcr_task ON vcr_cassettes(task_id);
    CREATE INDEX IF NOT EXISTS idx_vcr_conversation ON vcr_cassettes(conversation_id, sequence_number);

    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      config TEXT NOT NULL,
      total_tasks INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS security_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      scan_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      rule TEXT NOT NULL,
      file_path TEXT,
      line_number INTEGER,
      message TEXT NOT NULL,
      found_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_security_findings_task ON security_findings(task_id);
    CREATE INDEX IF NOT EXISTS idx_security_findings_severity ON security_findings(severity);

    -- BEFORE trigger: enforce valid status transitions at database level
    -- This matches the XState machine transitions exactly:
    --   pending -> claimed, cancelled, completed (cache_hit only via XState)
    --   claimed -> running, cancelled, failed
    --   running -> verifying, failed, timeout, cancelled
    --   verifying -> completed, failed, running (retry)
    --   completed, failed, cancelled, timeout are terminal
    CREATE TRIGGER IF NOT EXISTS enforce_task_transitions
    BEFORE UPDATE OF status ON task_state
    BEGIN
      SELECT CASE
        WHEN OLD.status = 'pending' AND NEW.status NOT IN ('claimed', 'cancelled', 'completed')
          THEN RAISE(ABORT, 'Invalid transition from pending')
        WHEN OLD.status = 'claimed' AND NEW.status NOT IN ('running', 'cancelled', 'failed')
          THEN RAISE(ABORT, 'Invalid transition from claimed')
        WHEN OLD.status = 'running' AND NEW.status NOT IN ('verifying', 'failed', 'timeout', 'cancelled')
          THEN RAISE(ABORT, 'Invalid transition from running')
        WHEN OLD.status = 'verifying' AND NEW.status NOT IN ('completed', 'failed', 'running')
          THEN RAISE(ABORT, 'Invalid transition from verifying')
        WHEN OLD.status IN ('completed', 'failed', 'cancelled', 'timeout') AND OLD.status != NEW.status
          THEN RAISE(ABORT, 'Cannot transition from terminal state')
      END;
    END;
  `);
}
