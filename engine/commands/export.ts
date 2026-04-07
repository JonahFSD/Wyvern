import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../store/db.js';

interface EventRow {
  id: number;
  stream_id: string;
  sequence: number;
  previous_id: number | null;
  type: string;
  payload: string;
  metadata: string | null;
  timestamp: string;
  actor: string | null;
}

interface RunRow {
  id: number;
  started_at: string;
  config: string;
  total_tasks: number;
}

export async function runExport(
  projectRoot: string,
  format: 'json' | 'md',
  runId?: string
): Promise<void> {
  const dbPath = path.join(projectRoot, '.wyvern', 'wyvern.db');

  if (!existsSync(dbPath)) {
    process.stderr.write('Error: No Wyvern database found at .wyvern/wyvern.db\n');
    process.exit(1);
  }

  const db = openDatabase(dbPath);

  let run: RunRow | undefined;
  if (runId !== undefined) {
    run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined;
  } else {
    run = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 1').get() as RunRow | undefined;
  }

  if (!run) {
    console.log('No runs found.');
    db.close();
    return;
  }

  const events = db
    .prepare('SELECT * FROM events WHERE timestamp >= ? ORDER BY timestamp ASC, id ASC')
    .all(run.started_at) as EventRow[];

  db.close();

  if (format === 'json') {
    const parsed = events.map(e => ({
      ...e,
      payload: tryParse(e.payload),
      metadata: e.metadata ? tryParse(e.metadata) : null,
    }));
    process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
  } else {
    const taskCount = new Set(
      events.map(e => e.stream_id).filter(id => id.startsWith('task:'))
    ).size;

    const lines: string[] = [
      `# Wyvern Export`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Run ID | ${run.id} |`,
      `| Started At | ${run.started_at} |`,
      `| Total Events | ${events.length} |`,
      `| Task Count | ${taskCount} |`,
      ``,
      `## Events`,
      ``,
    ];

    for (const e of events) {
      const summary = payloadSummary(e.payload);
      lines.push(
        `- \`${e.timestamp}\` **${e.type}** \`${e.stream_id}\` — ${summary}`
      );
    }

    process.stdout.write(lines.join('\n') + '\n');
  }
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function payloadSummary(payloadStr: string): string {
  try {
    const obj = JSON.parse(payloadStr);
    if (typeof obj !== 'object' || obj === null) return String(obj).slice(0, 80);
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    const first = keys.slice(0, 3).map(k => {
      const v = obj[k];
      const vs = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}: ${vs.slice(0, 30)}`;
    });
    return first.join(', ') + (keys.length > 3 ? ', …' : '');
  } catch {
    return payloadStr.slice(0, 80);
  }
}
