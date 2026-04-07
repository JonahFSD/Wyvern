// Guard functions for XState machines.
// Database-backed guards are evaluated at the MCP tool level (pre-flight checks)
// before sending events to XState actors. This keeps machine definitions pure
// while still enforcing constraints at the application layer.
//
// See REARCHITECTURE.md §5 (Layer 1) lines 579-612 for spec definitions.

import type Database from 'better-sqlite3';
import type { WyvernConfig } from '../types.js';

// -- Terminal state check (used by MCP tools for idempotent rejections) --

export function isTerminalState(status: string): boolean {
  return ['completed', 'failed', 'timeout', 'cancelled'].includes(status);
}

// -- Pre-flight guards for claim_task --
// These run BEFORE sending CLAIM to the XState actor.
// If any fails, the MCP tool returns an error and nothing is persisted.

export interface GuardContext {
  taskId: string;
  dependsOn: string[];
  touchesFiles: string[];
}

export interface GuardResult {
  passed: boolean;
  reason?: string;
}

/**
 * All dependencies must be in 'completed' state before a task can be claimed.
 * Spec: REARCHITECTURE.md lines 580-589
 */
export function dependenciesMet(db: Database.Database, ctx: GuardContext): GuardResult {
  if (ctx.dependsOn.length === 0) return { passed: true };

  const placeholders = ctx.dependsOn.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT COUNT(*) as cnt FROM task_state WHERE task_id IN (${placeholders}) AND status = 'completed'`
  ).get(...ctx.dependsOn) as { cnt: number };

  if (row.cnt === ctx.dependsOn.length) return { passed: true };

  const incomplete = db.prepare(
    `SELECT task_id, status FROM task_state WHERE task_id IN (${placeholders}) AND status != 'completed'`
  ).all(...ctx.dependsOn) as Array<{ task_id: string; status: string }>;

  return {
    passed: false,
    reason: `Dependencies not met: ${incomplete.map(d => `${d.task_id}(${d.status})`).join(', ')}`,
  };
}

/**
 * Cumulative spend must not exceed configured budget limit.
 * Spec: REARCHITECTURE.md lines 591-597
 */
export function withinBudget(db: Database.Database, config: WyvernConfig): GuardResult {
  if (!config.budgetLimitUsd) return { passed: true };

  const row = db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_state WHERE status = 'completed'"
  ).get() as { total: number };

  if (row.total < config.budgetLimitUsd) return { passed: true };
  return {
    passed: false,
    reason: `Budget exceeded: $${row.total.toFixed(2)} >= $${config.budgetLimitUsd.toFixed(2)} limit`,
  };
}

/**
 * No other active task has reserved any of the files this task needs.
 * Spec: REARCHITECTURE.md lines 598-608
 */
export function filesAvailable(db: Database.Database, ctx: GuardContext): GuardResult {
  if (ctx.touchesFiles.length === 0) return { passed: true };

  const placeholders = ctx.touchesFiles.map(() => '?').join(',');
  const conflicts = db.prepare(
    `SELECT file_path, task_id FROM file_reservations
     WHERE file_path IN (${placeholders}) AND released_at IS NULL AND task_id != ?`
  ).all(...ctx.touchesFiles, ctx.taskId) as Array<{ file_path: string; task_id: string }>;

  if (conflicts.length === 0) return { passed: true };
  return {
    passed: false,
    reason: `Files locked: ${conflicts.map(c => `${c.file_path}(by ${c.task_id})`).join(', ')}`,
  };
}

/**
 * Run all pre-flight guards for claim_task.
 * Returns the first failure, or { passed: true } if all pass.
 */
export function runClaimGuards(
  db: Database.Database,
  config: WyvernConfig,
  ctx: GuardContext,
): GuardResult {
  const depCheck = dependenciesMet(db, ctx);
  if (!depCheck.passed) return depCheck;

  const budgetCheck = withinBudget(db, config);
  if (!budgetCheck.passed) return budgetCheck;

  const fileCheck = filesAvailable(db, ctx);
  if (!fileCheck.passed) return fileCheck;

  return { passed: true };
}
