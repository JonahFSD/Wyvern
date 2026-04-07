import type Database from 'better-sqlite3';
import type { WyvernEvent } from './events.js';

export function updateTaskProjection(db: Database.Database, event: WyvernEvent): void {
  switch (event.type) {
    case 'task_created': {
      const p = event.payload;
      db.prepare(`
        INSERT INTO task_state (task_id, status, gate, model, description, depends_on, touches_files, prompt_hash)
        VALUES (?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(p.taskId, p.gate, p.model, p.description ?? null, JSON.stringify(p.dependsOn ?? []), JSON.stringify(p.touchesFiles ?? []), p.promptHash ?? null);
      break;
    }
    case 'task_claimed': {
      db.prepare(`UPDATE task_state SET status = 'claimed', worker_id = ?, claimed_at = ? WHERE task_id = ?`)
        .run(event.payload.workerId, event.timestamp, event.payload.taskId);
      break;
    }
    case 'task_started': {
      db.prepare(`UPDATE task_state SET status = 'running', started_at = ? WHERE task_id = ?`)
        .run(event.timestamp, event.payload.taskId);
      break;
    }
    case 'task_completed': {
      const p = event.payload;
      db.prepare(`
        UPDATE task_state
        SET status = 'completed', completed_at = ?, duration_ms = ?, cost_usd = ?,
            prompt_tokens = ?, completion_tokens = ?, output_hash = ?
        WHERE task_id = ?
      `).run(event.timestamp, p.durationMs ?? null, p.costUsd ?? null, p.promptTokens ?? null, p.completionTokens ?? null, p.outputHash ?? null, p.taskId);
      break;
    }
    case 'task_failed': {
      db.prepare(`UPDATE task_state SET status = 'failed', failure_reason = ?, completed_at = ? WHERE task_id = ?`)
        .run(event.payload.reason, event.timestamp, event.payload.taskId);
      break;
    }
    case 'task_timeout': {
      db.prepare(`UPDATE task_state SET status = 'timeout', completed_at = ? WHERE task_id = ?`)
        .run(event.timestamp, event.payload.taskId);
      break;
    }
    case 'task_cache_hit': {
      const p = event.payload;
      db.prepare(`
        UPDATE task_state
        SET status = 'completed', completed_at = ?, output_hash = ?, duration_ms = 0
        WHERE task_id = ?
      `).run(event.timestamp, p.outputHash, p.taskId);
      break;
    }
    case 'task_cancelled': {
      db.prepare(`UPDATE task_state SET status = 'cancelled', completed_at = ? WHERE task_id = ?`)
        .run(event.timestamp, event.payload.taskId);
      break;
    }
    case 'task_verification_started': {
      db.prepare(`UPDATE task_state SET status = 'verifying' WHERE task_id = ?`)
        .run(event.payload.taskId);
      break;
    }
  }
}

export function updateFileProjection(db: Database.Database, event: WyvernEvent): void {
  if (event.type === 'file_reserved') {
    db.prepare(`INSERT OR REPLACE INTO file_reservations (file_path, task_id, reserved_at) VALUES (?, ?, ?)`)
      .run(event.payload.filePath, event.payload.taskId, event.timestamp);
  } else if (event.type === 'file_released') {
    db.prepare(`UPDATE file_reservations SET released_at = ? WHERE file_path = ? AND task_id = ?`)
      .run(event.timestamp, event.payload.filePath, event.payload.taskId);
  }
}

export function updateContextProjection(db: Database.Database, event: WyvernEvent): void {
  if (event.type === 'context_written') {
    const p = event.payload;
    db.prepare(`
      INSERT INTO context (key, value, written_by, written_at, version)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(key) DO UPDATE SET value = ?, written_by = ?, written_at = ?, version = version + 1
    `).run(p.key, p.value, p.taskId, event.timestamp, p.value, p.taskId, event.timestamp);
  }
}

export function updateSecurityProjection(db: Database.Database, event: WyvernEvent): void {
  const securityEventTypes = [
    'security_secret_detected', 'security_sast_finding', 'security_dep_vulnerability',
    'security_context_injection', 'security_context_overwrite',
  ];
  if (securityEventTypes.includes(event.type)) {
    const p = event.payload;
    db.prepare(`
      INSERT INTO security_findings (task_id, scan_type, severity, rule, file_path, line_number, message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(p.taskId, p.scanType, p.severity, p.rule, p.filePath ?? null, p.lineNumber ?? null, p.message);
  }
}

export function applyEvent(db: Database.Database, event: WyvernEvent): void {
  updateTaskProjection(db, event);
  updateFileProjection(db, event);
  updateContextProjection(db, event);
  updateSecurityProjection(db, event);
}

export function rebuildProjections(db: Database.Database): void {
  db.exec('DELETE FROM task_state');
  db.exec('DELETE FROM file_reservations');
  db.exec('DELETE FROM context');
  db.exec('DELETE FROM security_findings');

  const events = db.prepare('SELECT * FROM events ORDER BY id ASC').all();
  for (const row of events) {
    const event = { ...(row as any), payload: JSON.parse((row as any).payload as string) } as WyvernEvent;
    applyEvent(db, event);
  }
}
