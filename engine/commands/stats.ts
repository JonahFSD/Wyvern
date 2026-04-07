import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../store/db.js';

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export async function runStats(projectRoot: string, runId?: string): Promise<void> {
  const dbPath = path.join(projectRoot, '.wyvern', 'wyvern.db');

  if (!existsSync(dbPath)) {
    process.stderr.write('Error: No Wyvern database found at .wyvern/wyvern.db\n');
    process.exit(1);
  }

  const db = openDatabase(dbPath);

  try {
    // Find the target run
    let run: { id: number; started_at: string } | undefined;

    if (runId !== undefined) {
      run = db.prepare('SELECT id, started_at FROM runs WHERE id = ?').get(runId) as
        | { id: number; started_at: string }
        | undefined;
    } else {
      run = db.prepare('SELECT id, started_at FROM runs ORDER BY id DESC LIMIT 1').get() as
        | { id: number; started_at: string }
        | undefined;
    }

    if (!run) {
      console.log('No runs found.');
      return;
    }

    // Query all events for this run (events at or after started_at)
    const events = db
      .prepare(
        'SELECT stream_id, type, payload, timestamp FROM events WHERE timestamp >= ? ORDER BY timestamp ASC'
      )
      .all(run.started_at) as { stream_id: string; type: string; payload: string; timestamp: string }[];

    if (events.length === 0) {
      console.log(`Run: ${run.id}`);
      console.log('No events found for this run.');
      return;
    }

    // Wall-clock time
    const firstTs = new Date(events[0].timestamp).getTime();
    const lastTs = new Date(events[events.length - 1].timestamp).getTime();
    const wallClockMs = lastTs - firstTs;

    // Agent-time: sum durationMs from task_completed payloads
    let agentTimeMs = 0;
    for (const event of events) {
      if (event.type === 'task_completed') {
        try {
          const payload = JSON.parse(event.payload) as { durationMs?: number };
          if (typeof payload.durationMs === 'number') {
            agentTimeMs += payload.durationMs;
          }
        } catch {
          // skip malformed payloads
        }
      }
    }

    // Parallelism ratio
    const parallelism = wallClockMs > 0 ? agentTimeMs / wallClockMs : 0;

    // Task counts
    const streamIds = new Set(events.map(e => e.stream_id));
    const totalTasks = streamIds.size;
    const completed = events.filter(e => e.type === 'task_completed').length;
    const failed = events.filter(e => e.type === 'task_failed').length;
    const cached = events.filter(e => e.type === 'task_cache_hit').length;

    // Print results
    console.log(`Run: ${run.id}`);
    console.log(`Wall-clock:       ${formatDuration(wallClockMs)}`);
    console.log(`Agent-time:       ${formatDuration(agentTimeMs)}`);
    console.log(`Parallelism:      ${parallelism.toFixed(1)}x`);
    console.log(`Tasks:            ${totalTasks} total, ${completed} completed, ${failed} failed, ${cached} cached`);
  } finally {
    db.close();
  }
}
