import type Database from 'better-sqlite3';

export type EventType =
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'task_created'
  | 'task_claimed'
  | 'task_started'
  | 'task_progress'
  | 'task_verification_started'
  | 'task_completed'
  | 'task_failed'
  | 'task_timeout'
  | 'task_cancelled'
  | 'task_cache_hit'
  | 'context_written'
  | 'context_read'
  | 'file_reserved'
  | 'file_released'
  | 'cache_checked'
  | 'cache_entry_written'
  | 'vcr_request_recorded'
  | 'snapshot_created'
  | 'error'
  | 'security_scan_completed'
  | 'security_secret_detected'
  | 'security_sast_finding'
  | 'security_dep_vulnerability'
  | 'security_context_injection'
  | 'security_context_overwrite'
  | 'security_finding_resolved'
  ;

export interface WyvernEvent {
  id?: number;
  stream_id: string;
  sequence: number;
  previous_id: number | null;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: string;
  actor: string;
}

export function appendEvent(db: Database.Database, event: Omit<WyvernEvent, 'id'>): number {
  const stmt = db.prepare(`
    INSERT INTO events (stream_id, sequence, previous_id, type, payload, timestamp, actor)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    event.stream_id,
    event.sequence,
    event.previous_id,
    event.type,
    JSON.stringify(event.payload),
    event.timestamp || new Date().toISOString(),
    event.actor
  );
  return result.lastInsertRowid as number;
}

export function replayStream(db: Database.Database, streamId: string): WyvernEvent[] {
  const stmt = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY sequence ASC');
  return stmt.all(streamId).map((row: any) => ({
    ...row,
    payload: JSON.parse(row.payload as string),
  })) as WyvernEvent[];
}

export function replayAll(db: Database.Database, since?: string): WyvernEvent[] {
  if (since) {
    const stmt = db.prepare('SELECT * FROM events WHERE timestamp >= ? ORDER BY id ASC');
    return stmt.all(since).map((row: any) => ({
      ...row,
      payload: JSON.parse(row.payload as string),
    })) as WyvernEvent[];
  }
  const stmt = db.prepare('SELECT * FROM events ORDER BY id ASC');
  return stmt.all().map((row: any) => ({
    ...row,
    payload: JSON.parse(row.payload as string),
  })) as WyvernEvent[];
}

export function getLastEvent(db: Database.Database, streamId: string): WyvernEvent | null {
  const stmt = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY sequence DESC LIMIT 1');
  const row = stmt.get(streamId) as any;
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload as string) } as WyvernEvent;
}
