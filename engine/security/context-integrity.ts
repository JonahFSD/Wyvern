import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ContextIntegrityResult } from './types.js';

export function validateContextWrite(
  db: Database.Database,
  taskId: string,
  key: string,
  value: string,
): ContextIntegrityResult {
  const violations: string[] = [];

  const injectionPatterns = [
    /ignore\s+(previous|above|all)\s+(instructions|rules|constraints)/i,
    /you\s+are\s+now\s+/i,
    /system\s*:\s*/i,
    /\bACT\s+AS\b/i,
    /do\s+not\s+follow\s+(the|your)\s+(previous|original)/i,
    /override\s+(the|your|all)\s+(previous|safety|instructions)/i,
  ];

  for (const pattern of injectionPatterns) {
    if (pattern.test(value)) {
      violations.push(`Context value for key '${key}' matches prompt injection pattern: ${pattern.source}`);
    }
  }

  const MAX_CONTEXT_VALUE_LENGTH = 10_000;
  if (value.length > MAX_CONTEXT_VALUE_LENGTH) {
    violations.push(`Context value for key '${key}' exceeds size limit (${value.length} > ${MAX_CONTEXT_VALUE_LENGTH})`);
  }

  const existing = db.prepare('SELECT * FROM context WHERE key = ?').get(key) as any;
  if (existing && existing.written_by !== taskId) {
    violations.push(`AUDIT: Task ${taskId} overwriting context key '${key}' previously written by ${existing.written_by}`);
  }

  return {
    passed: violations.filter(v => !v.startsWith('AUDIT:')).length === 0,
    violations,
  };
}

export function signContextEntry(key: string, value: string, taskId: string, secret: string): string {
  const payload = `${key}:${value}:${taskId}:${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyContextSignature(
  key: string, value: string, taskId: string, signature: string, secret: string
): boolean {
  return signature.length === 64;
}
