import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../store/db.js';

function pad(s: string, n: number): string {
  return s.padEnd(n);
}

export async function runHealth(projectRoot: string): Promise<void> {
  const rows: { name: string; status: string; detail: string }[] = [];

  // SQLite
  const dbPath = path.join(projectRoot, '.wyvern', 'wyvern.db');
  try {
    if (!existsSync(dbPath)) throw new Error('file not found');
    const db = openDatabase(dbPath);
    const result = db.pragma('integrity_check', { simple: true }) as string;
    db.close();
    if (result !== 'ok') throw new Error(`integrity_check returned: ${result}`);
    rows.push({ name: 'SQLite', status: 'PASS', detail: `.wyvern/wyvern.db (integrity ok)` });
  } catch (err: any) {
    rows.push({ name: 'SQLite', status: 'FAIL', detail: err.message ?? String(err) });
  }

  // Git
  try {
    const out = execSync('git --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    rows.push({ name: 'Git', status: 'PASS', detail: out });
  } catch {
    rows.push({ name: 'Git', status: 'FAIL', detail: 'git not found' });
  }

  // gitleaks
  try {
    const out = execSync('gitleaks version', { encoding: 'utf-8', timeout: 5000 }).trim();
    rows.push({ name: 'gitleaks', status: 'PASS', detail: out });
  } catch {
    rows.push({ name: 'gitleaks', status: 'SKIP', detail: 'not installed (optional)' });
  }

  // semgrep
  try {
    const out = execSync('semgrep --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    rows.push({ name: 'semgrep', status: 'PASS', detail: out });
  } catch {
    rows.push({ name: 'semgrep', status: 'SKIP', detail: 'not installed (optional)' });
  }

  const nameWidth = Math.max(...rows.map(r => r.name.length));
  const statusWidth = 6;

  console.log('Wyvern Health Check');
  console.log('-------------------');
  for (const row of rows) {
    console.log(`${pad(row.name, nameWidth + 2)}${pad(row.status, statusWidth)} ${row.detail}`);
  }
}
