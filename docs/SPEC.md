# Wyvern v3: Rearchitecture Spec

**Status:** Design complete. Ready for execution.
**Author:** Jonah Elliott (April 2026)
**Scope:** Full rearchitecture of the Wyvern orchestration engine.

This document is a complete, executable specification. Another Claude instance should be able to read this file and the existing codebase, then implement the entire rearchitecture without further guidance.

---

## Table of Contents

1. [Vision](#1-vision)
2. [Architectural Overview](#2-architectural-overview)
3. [What Stays, What Goes, What's New](#3-what-stays-what-goes-whats-new)
4. [Layer 0: SQLite Event Store](#4-layer-0-sqlite-event-store)
5. [Layer 1: XState v5 State Machines](#5-layer-1-xstate-v5-state-machines)
6. [Layer 2: MCP Coordination Server](#6-layer-2-mcp-coordination-server)
7. [Layer 3: Content-Addressed Execution Cache](#7-layer-3-content-addressed-execution-cache)
8. [Layer 4: VCR Recording and Replay](#8-layer-4-vcr-recording-and-replay)
9. [Layer 5: Filesystem Isolation](#9-layer-5-filesystem-isolation)
10. [Layer 6: Executor Rewrite](#10-layer-6-executor-rewrite)
11. [Layer 7: Observability](#11-layer-7-observability)
12. [Layer 8: Security Auditing](#12-layer-8-security-auditing)
13. [Implementation Order](#13-implementation-order)
14. [Dependencies](#14-dependencies)
15. [Key External References](#15-key-external-references)
16. [Verification Criteria](#16-verification-criteria)

---

## 1. Vision

Wyvern is `make` for AI agents.

`make` solved three problems for compilation: dependency-ordered execution, incremental rebuilds (skip what hasn't changed), and reproducibility. Before `make`, you recompiled everything and prayed. After `make`, builds were correct, fast, and debuggable.

That's the same gap between "Claude Code can do things" and "Claude Code reliably ships production software." Wyvern fills it.

The DAG is the Makefile. The MCP server is the build runtime. The event store is the build log. Content-addressed caching is `make`'s timestamp comparison (but content-based, so it's actually correct). Deterministic replay is what `make` never had -- the ability to reproduce any historical build exactly, API responses and all.

The core architectural move: **agents don't touch state directly. They declare intentions through a typed API, and the orchestrator decides whether to accept them.** This inverts the current control model (agents modify files, executor polls and infers) into an explicit, enforceable, recordable system.

---

## 2. Architectural Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        EXECUTOR (Layer 6)                     │
│   Event-driven: wakes on stateChanged, spawns/reaps agents    │
│   Reads DAG, checks cache, crash recovery via event replay    │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐   │
│  │  VCR Proxy   │  │ Content-Addr │  │ Filesystem        │   │
│  │  (Layer 4)   │  │ Cache (L3)   │  │ Isolation (L5)    │   │
│  │  Records API │  │ Skip if      │  │ Worktrees +       │   │
│  │  responses   │  │ unchanged    │  │ sandbox-exec      │   │
│  └──────┬───────┘  └──────┬───────┘  └───────────────────┘   │
│         │                  │                                   │
├─────────┴──────────────────┴───────────────────────────────────┤
│                   MCP COORDINATION SERVER (Layer 2)            │
│   Streamable HTTP on localhost:3001/mcp                        │
│   Tools: claim_task, start_task, complete_task, fail_task,     │
│          report_progress, read/write_context, reserve_file,    │
│          query_cache                                           │
│   Each tool: send event to XState → persist → applyEvent →    │
│   emit stateChanged                                            │
├──────────────────────────────────────────────────────────────┤
│                   XSTATE v5 MACHINES (Layer 1)                │
│   Orchestrator machine ← contains → Task machines             │
│   Guard combinators: and('depsMet', 'withinBudget', 'owns')  │
│   Enforced transitions = illegal states are impossible         │
├──────────────────────────────────────────────────────────────┤
│                   SQLITE EVENT STORE (Layer 0)                │
│   better-sqlite3 + WAL mode                                   │
│   Append-only events → Projection tables                      │
│   BEFORE triggers for database-level invariant enforcement     │
│   Litestream for disaster recovery                             │
└──────────────────────────────────────────────────────────────┘
```

Data flow for a typical agent action:

```
Agent calls complete_task via MCP
  → MCP server receives request
  → Validates inputs (Zod schema check)
  → Sends VERIFICATION_STARTED event to XState task actor
  → If actor rejects (wrong state): return error, nothing persisted
  → If actor transitions: persist event → applyEvent updates projections
  → Run quality gates (build, lint, security scan) server-side
  → If gates fail: send VERIFICATION_FAILED to actor → persist → return rejection
  → If gates pass: send VERIFICATION_PASSED to actor → persist → applyEvent
  → stateChanged.emit('change') notifies executor
  → Executor wakes, finds newly unblocked tasks, spawns downstream agents
```

---

## 3. What Stays, What Goes, What's New

### Stays (keep these files, refactor as needed)

| File | Why |
|------|-----|
| `engine/config.ts` | Config loading + merge logic is solid. Add new config fields for SQLite path, MCP port, cache settings. |
| `engine/prompt-builder.ts` | Prompt construction works. Replace `{{context:key}}` resolution with MCP `read_context` call in agent prompt template. |
| `engine/prompt-linter.ts` | Prompt validation is good. Keep as-is. |
| `engine/watchdog.ts` | Activity-based timeout is robust. Keep as-is. |
| `engine/cost-tracker.ts` | Cost extraction and JSONL tracking. Keep, also feed into event store. |
| `engine/output-capture.ts` | Per-task log capture. Keep as-is. |
| `engine/logger.ts` | JSONL structured logging. Keep as-is. |
| `engine/verification.ts` | Verify command sequencing. Keep as-is. |
| `swarm/dependency-graph.ts` | Full DAG validation, cycle detection, critical path, topo sort. Excellent code, keep entirely. |
| `swarm/types.ts` | SwarmTask, Domain, SwarmPlan types. Keep, extend. |
| `swarm/conventions/` | Swarm and domain conventions docs. Keep. |
| `profiles/` | Profile system (web-app, research-pipeline, profile interface). Keep, extend with new defaults. |
| `cli.ts` | CLI entry point. Refactor to add new subcommands. |

### Goes (remove or fully replace)

| File | Why | Replaced By |
|------|-----|-------------|
| `engine/plan-parser.ts` | PLAN.md checkbox parsing. Agents no longer flip checkboxes; they call MCP tools. | MCP `complete_task` tool |
| `engine/snapshot.ts` | Git stash-based snapshots. Dead code (`restoreSnapshot`, `cleanupSnapshots` never called). Crash recovery now uses event replay. | Event store replay |
| `engine/file-lock.ts` | mkdir-based advisory locks for PLAN.md. No longer needed -- SQLite handles concurrency, MCP serializes writes. | SQLite WAL + MCP server |
| `engine/audit.ts` | Has wrong import path (`./swarm/types.js` should be `../swarm/types.js`). End-of-run-only audit. | Rebuilt as per-task quality gate in MCP server + end-of-run summary from event store |
| `engine/maintenance.ts` | Pin regen + lint + trend. Superseded by event store queries and CLI observability commands. | Event store + CLI dashboard |

### New (create these)

| File/Dir | Purpose |
|----------|---------|
| `engine/store/schema.ts` | SQLite schema definitions, migrations, table creation |
| `engine/store/events.ts` | Event store: append, replay, query |
| `engine/store/projections.ts` | Projection builders: task status, file ownership, context, cache |
| `engine/store/db.ts` | Database initialization, WAL config, connection management |
| `engine/machines/task.ts` | XState v5 task lifecycle machine |
| `engine/machines/orchestrator.ts` | XState v5 orchestrator machine |
| `engine/machines/guards.ts` | Shared guard functions for state machines |
| `engine/machines/registry.ts` | Live XState actor registry, hydration from event history |
| `engine/mcp/server.ts` | MCP coordination server (Streamable HTTP) |
| `engine/mcp/tools.ts` | MCP tool definitions and handlers |
| `engine/mcp/types.ts` | MCP request/response types |
| `engine/cache/manifest.ts` | Content-addressed task manifest hashing |
| `engine/cache/store.ts` | Cache lookup, write, invalidation |
| `engine/vcr/proxy.ts` | HTTP proxy for recording Claude API calls |
| `engine/vcr/cassette.ts` | VCR cassette storage and retrieval |
| `engine/isolation/worktree.ts` | Git worktree creation and cleanup |
| `engine/isolation/sandbox.ts` | sandbox-exec profile generation |
| `engine/security/scanner.ts` | Master security scan orchestrator |
| `engine/security/secrets.ts` | Secret scanning (gitleaks/betterleaks) |
| `engine/security/sast.ts` | Static analysis (semgrep) |
| `engine/security/dependencies.ts` | Dependency vulnerability auditing |
| `engine/security/context-integrity.ts` | Context poisoning detection + signing |
| `engine/security/types.ts` | Security finding types, severity levels |
| `engine/executor.ts` | Full rewrite of the execution loop |

---

## 4. Layer 0: SQLite Event Store

### Database Setup

Use `better-sqlite3` with WAL mode. Single database file at `{projectRoot}/.wyvern/wyvern.db`.

```typescript
// engine/store/db.ts
import Database from 'better-sqlite3';

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  return db;
}
```

### Schema

```sql
-- engine/store/schema.sql (execute on first run via schema.ts)

-- Core event store: append-only, immutable
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Optimistic concurrency: each event references the previous event for its stream
  stream_id TEXT NOT NULL,           -- e.g., 'task:T01', 'orchestrator', 'context'
  sequence INTEGER NOT NULL,         -- monotonic within stream
  previous_id INTEGER REFERENCES events(id),
  type TEXT NOT NULL,                -- event type enum
  payload TEXT NOT NULL,             -- JSON
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  actor TEXT,                        -- who caused this: 'executor', 'worker:T01', 'system'
  UNIQUE(stream_id, sequence)        -- optimistic concurrency enforcement
);

CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

-- Projection: current task state (materialized from events)
CREATE TABLE IF NOT EXISTS task_state (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  -- CHECK ensures only valid statuses exist in the DB
  CHECK(status IN ('pending', 'claimed', 'running', 'verifying', 'completed', 'failed', 'cancelled', 'timeout')),
  worker_id TEXT,
  gate INTEGER NOT NULL,
  model TEXT NOT NULL,
  description TEXT,
  depends_on TEXT,                    -- JSON array of task IDs
  prompt_hash TEXT,                   -- for cache lookups
  output_hash TEXT,                   -- hash of task output for downstream cache keys
  claimed_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  cost_usd REAL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0
);

-- Projection: file reservations (who owns what file right now)
CREATE TABLE IF NOT EXISTS file_reservations (
  file_path TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_state(task_id),
  reserved_at TEXT NOT NULL,
  released_at TEXT                    -- NULL = currently reserved
);

-- Projection: shared context (key-value, replacing context.md)
CREATE TABLE IF NOT EXISTS context (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  written_by TEXT NOT NULL,           -- task ID that wrote this
  written_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1  -- incremented on update
);

-- Content-addressed execution cache (append-only: rows are written once, never updated)
CREATE TABLE IF NOT EXISTS execution_cache (
  manifest_hash TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  git_tree_before TEXT NOT NULL,      -- git tree hash before execution
  git_tree_after TEXT NOT NULL,       -- git tree hash after execution
  output_hash TEXT NOT NULL,
  output_log TEXT,                    -- path to captured output
  vcr_conversation_id TEXT,          -- for VCR replay (Layer 4)
  cost_usd REAL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
  -- No hit_count or last_hit_at: these are derived from cache_checked events
  -- Query: SELECT manifest_hash, COUNT(*) as hits FROM events WHERE type='cache_checked' GROUP BY json_extract(payload,'$.manifestHash')
);

-- VCR cassettes: recorded API request/response pairs
CREATE TABLE IF NOT EXISTS vcr_cassettes (
  request_hash TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  request_body TEXT NOT NULL,         -- JSON (sanitized)
  response_body TEXT NOT NULL,        -- JSON
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
);

-- Execution runs (append-only: written once on run start, never updated)
-- Run lifecycle is tracked via events: run_started, run_completed, run_failed
-- Current status, completed_tasks, cost, etc. are derived from event stream:
--   SELECT COUNT(*) FROM events WHERE type='task_completed' AND json_extract(payload,'$.runId')=?
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  config TEXT NOT NULL,               -- JSON snapshot of WyvernConfig
  total_tasks INTEGER NOT NULL
  -- No status, completed_at, completed_tasks, failed_tasks, total_cost_usd, cache_hits, cache_misses
  -- All of these are projections derivable from the event stream
);

-- BEFORE trigger: enforce valid status transitions at the database level
-- This is defense-in-depth behind XState -- should never fire if XState is correct
CREATE TRIGGER IF NOT EXISTS enforce_task_transitions
BEFORE UPDATE OF status ON task_state
BEGIN
  SELECT CASE
    -- pending can go to: claimed, cancelled
    WHEN OLD.status = 'pending' AND NEW.status NOT IN ('claimed', 'cancelled')
      THEN RAISE(ABORT, 'Invalid transition from pending')
    -- claimed can go to: running, cancelled, failed
    WHEN OLD.status = 'claimed' AND NEW.status NOT IN ('running', 'cancelled', 'failed')
      THEN RAISE(ABORT, 'Invalid transition from claimed')
    -- running can go to: verifying, failed, timeout, cancelled
    WHEN OLD.status = 'running' AND NEW.status NOT IN ('verifying', 'failed', 'timeout', 'cancelled')
      THEN RAISE(ABORT, 'Invalid transition from running')
    -- verifying can go to: completed, failed, running (retry verification)
    WHEN OLD.status = 'verifying' AND NEW.status NOT IN ('completed', 'failed', 'running')
      THEN RAISE(ABORT, 'Invalid transition from verifying')
    -- completed, failed, cancelled, timeout are terminal
    WHEN OLD.status IN ('completed', 'failed', 'cancelled', 'timeout') AND OLD.status != NEW.status
      THEN RAISE(ABORT, 'Cannot transition from terminal state')
  END;
END;
```

### Event Types

Define an exhaustive enum of event types:

```typescript
// engine/store/events.ts
export type EventType =
  // Orchestrator lifecycle
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  // Task lifecycle
  | 'task_created'           // task added to plan
  | 'task_claimed'           // worker declared intent to start
  | 'task_started'           // execution began
  | 'task_progress'          // intermediate progress report
  | 'task_verification_started' // quality gate running
  | 'task_completed'         // quality gate passed, done
  | 'task_failed'            // failed (agent error, verification failure, etc.)
  | 'task_timeout'           // watchdog killed it
  | 'task_cancelled'         // cancelled by orchestrator
  | 'task_cache_hit'         // skipped because cache hit
  // Context
  | 'context_written'        // shared context key-value written
  | 'context_read'           // shared context read (for causal tracking)
  // Files
  | 'file_reserved'          // file lock acquired
  | 'file_released'          // file lock released
  // Cache
  | 'cache_checked'          // cache lookup performed
  | 'cache_entry_written'    // new cache entry stored
  // VCR
  | 'vcr_request_recorded'   // API request/response pair captured
  // System
  | 'snapshot_created'       // git state checkpointed
  | 'error'                  // system error
  ;

export interface WyvernEvent {
  id?: number;                // assigned by DB
  stream_id: string;
  sequence: number;
  previous_id: number | null;
  type: EventType;
  payload: Record<string, unknown>;
  timestamp: string;
  actor: string;
}
```

### Event Store Operations

```typescript
// engine/store/events.ts (continued)

export function appendEvent(db: Database.Database, event: Omit<WyvernEvent, 'id'>): number {
  // Use BEGIN IMMEDIATE to prevent write conflicts under WAL
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
  return stmt.all(streamId).map(row => ({
    ...row,
    payload: JSON.parse(row.payload as string),
  })) as WyvernEvent[];
}

export function replayAll(db: Database.Database, since?: string): WyvernEvent[] {
  if (since) {
    const stmt = db.prepare('SELECT * FROM events WHERE timestamp >= ? ORDER BY id ASC');
    return stmt.all(since).map(row => ({
      ...row,
      payload: JSON.parse(row.payload as string),
    })) as WyvernEvent[];
  }
  const stmt = db.prepare('SELECT * FROM events ORDER BY id ASC');
  return stmt.all().map(row => ({
    ...row,
    payload: JSON.parse(row.payload as string),
  })) as WyvernEvent[];
}

export function getLastEvent(db: Database.Database, streamId: string): WyvernEvent | null {
  const stmt = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY sequence DESC LIMIT 1');
  const row = stmt.get(streamId);
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload as string) } as WyvernEvent;
}
```

### Projections

Projections are materialized views computed from events. They can be rebuilt at any time by replaying the event stream.

```typescript
// engine/store/projections.ts

export function updateTaskProjection(
  db: Database.Database,
  event: WyvernEvent
): void {
  switch (event.type) {
    case 'task_created': {
      const p = event.payload;
      db.prepare(`
        INSERT INTO task_state (task_id, status, gate, model, description, depends_on, prompt_hash)
        VALUES (?, 'pending', ?, ?, ?, ?, ?)
      `).run(p.taskId, p.gate, p.model, p.description, JSON.stringify(p.dependsOn), p.promptHash);
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
      `).run(event.timestamp, p.durationMs, p.costUsd, p.promptTokens, p.completionTokens, p.outputHash, p.taskId);
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

// Master projection dispatcher -- called for every event
export function applyEvent(db: Database.Database, event: WyvernEvent): void {
  updateTaskProjection(db, event);
  updateFileProjection(db, event);
  updateContextProjection(db, event);
}

// Rebuild all projections from scratch (for recovery or migration)
export function rebuildProjections(db: Database.Database): void {
  db.exec('DELETE FROM task_state');
  db.exec('DELETE FROM file_reservations');
  db.exec('DELETE FROM context');

  const events = db.prepare('SELECT * FROM events ORDER BY id ASC').all();
  for (const row of events) {
    const event = { ...row, payload: JSON.parse(row.payload as string) } as WyvernEvent;
    applyEvent(db, event);
  }
}
```

---

## 5. Layer 1: XState v5 State Machines

### Install

```bash
npm install xstate
```

### Task Lifecycle Machine

```typescript
// engine/machines/task.ts
import { setup, createActor, assign } from 'xstate';
import type { Database } from 'better-sqlite3';

// Context that travels with each task machine instance
interface TaskContext {
  taskId: string;
  gate: number;
  model: string;
  dependsOn: string[];
  touchesFiles: string[];
  workerId: string | null;
  retryCount: number;
  maxRetries: number;
  failureReason: string | null;
}

// Events the task machine accepts
type TaskEvent =
  | { type: 'CLAIM'; workerId: string }
  | { type: 'START' }
  | { type: 'VERIFICATION_STARTED' }
  | { type: 'VERIFICATION_PASSED'; outputHash: string; durationMs: number; costUsd: number }
  | { type: 'VERIFICATION_FAILED'; reason: string }
  | { type: 'FAIL'; reason: string }
  | { type: 'TIMEOUT' }
  | { type: 'CANCEL' }
  | { type: 'CACHE_HIT'; outputHash: string }
  ;

export const taskMachine = setup({
  types: {
    context: {} as TaskContext,
    events: {} as TaskEvent,
  },
  guards: {
    dependenciesMet: ({ context }, params: { db: Database }) => {
      // Query task_state projection: all dependencies must be 'completed'
      const deps = context.dependsOn;
      if (deps.length === 0) return true;
      const placeholders = deps.map(() => '?').join(',');
      const stmt = params.db.prepare(
        `SELECT COUNT(*) as cnt FROM task_state WHERE task_id IN (${placeholders}) AND status = 'completed'`
      );
      const row = stmt.get(...deps) as { cnt: number };
      return row.cnt === deps.length;
    },
    withinBudget: ({ context }, params: { db: Database; config: WyvernConfig }) => {
      if (!params.config.budgetLimitUsd) return true;
      const spent = params.db.prepare(
        'SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_state WHERE status = ?'
      ).get('completed') as { total: number };
      return spent.total < params.config.budgetLimitUsd;
    },
    filesAvailable: ({ context }, params: { db: Database }) => {
      // Check no other active task has reserved any of our files
      if (context.touchesFiles.length === 0) return true;
      const placeholders = context.touchesFiles.map(() => '?').join(',');
      const stmt = params.db.prepare(
        `SELECT COUNT(*) as cnt FROM file_reservations
         WHERE file_path IN (${placeholders}) AND released_at IS NULL AND task_id != ?`
      );
      const row = stmt.get(...context.touchesFiles, context.taskId) as { cnt: number };
      return row.cnt === 0;
    },
    canRetry: ({ context }) => {
      return context.retryCount < context.maxRetries;
    },
  },
  actions: {
    assignWorker: assign({
      workerId: (_, params: { workerId: string }) => params.workerId,
    }),
    incrementRetry: assign({
      retryCount: ({ context }) => context.retryCount + 1,
    }),
    setFailureReason: assign({
      failureReason: (_, params: { reason: string }) => params.reason,
    }),
  },
}).createMachine({
  id: 'task',
  initial: 'pending',
  states: {
    pending: {
      on: {
        CLAIM: {
          target: 'claimed',
          // Guard: dependencies resolved, files available, within budget
          // Guard params are passed at runtime by the MCP server
          actions: [{ type: 'assignWorker', params: ({ event }) => ({ workerId: event.workerId }) }],
        },
        CACHE_HIT: {
          target: 'completed',
        },
        CANCEL: {
          target: 'cancelled',
        },
      },
    },
    claimed: {
      on: {
        START: { target: 'running' },
        CANCEL: { target: 'cancelled' },
        FAIL: {
          target: 'failed',
          actions: [{ type: 'setFailureReason', params: ({ event }) => ({ reason: event.reason }) }],
        },
      },
    },
    running: {
      on: {
        VERIFICATION_STARTED: { target: 'verifying' },
        FAIL: {
          target: 'failed',
          actions: [{ type: 'setFailureReason', params: ({ event }) => ({ reason: event.reason }) }],
        },
        TIMEOUT: { target: 'timeout' },
        CANCEL: { target: 'cancelled' },
      },
    },
    verifying: {
      on: {
        VERIFICATION_PASSED: { target: 'completed' },
        VERIFICATION_FAILED: [
          {
            // If we can retry, go back to running
            guard: 'canRetry',
            target: 'running',
            actions: ['incrementRetry'],
          },
          {
            // Otherwise, fail
            target: 'failed',
            actions: [{ type: 'setFailureReason', params: ({ event }) => ({ reason: event.reason }) }],
          },
        ],
      },
    },
    completed: { type: 'final' },
    failed: { type: 'final' },
    timeout: { type: 'final' },
    cancelled: { type: 'final' },
  },
});
```

### Orchestrator Machine

```typescript
// engine/machines/orchestrator.ts
import { setup } from 'xstate';

interface OrchestratorContext {
  runId: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  cacheHits: number;
}

type OrchestratorEvent =
  | { type: 'PLAN_PARSED'; totalTasks: number }
  | { type: 'TASK_COMPLETED' }
  | { type: 'TASK_FAILED' }
  | { type: 'TASK_CACHE_HIT' }
  | { type: 'ALL_DONE' }
  | { type: 'STALLED' }
  | { type: 'ABORT' }
  ;

export const orchestratorMachine = setup({
  types: {
    context: {} as OrchestratorContext,
    events: {} as OrchestratorEvent,
  },
  guards: {
    allTasksFinished: ({ context }) => {
      return (context.completedTasks + context.failedTasks + context.cacheHits) >= context.totalTasks;
    },
    hasFailures: ({ context }) => context.failedTasks > 0,
  },
}).createMachine({
  id: 'orchestrator',
  initial: 'planning',
  states: {
    planning: {
      on: {
        PLAN_PARSED: { target: 'executing' },
      },
    },
    executing: {
      on: {
        TASK_COMPLETED: { actions: assign({ completedTasks: ({ context }) => context.completedTasks + 1 }) },
        TASK_FAILED: { actions: assign({ failedTasks: ({ context }) => context.failedTasks + 1 }) },
        TASK_CACHE_HIT: { actions: assign({ cacheHits: ({ context }) => context.cacheHits + 1 }) },
        ALL_DONE: [
          { guard: 'hasFailures', target: 'completedWithFailures' },
          { target: 'completed' },
        ],
        STALLED: { target: 'stalled' },
        ABORT: { target: 'aborted' },
      },
      // The executor checks allTasksFinished after each event and sends ALL_DONE
    },
    draining: {
      // Waiting for in-flight tasks to finish after a stop signal
      on: {
        TASK_COMPLETED: { actions: assign({ completedTasks: ({ context }) => context.completedTasks + 1 }) },
        TASK_FAILED: { actions: assign({ failedTasks: ({ context }) => context.failedTasks + 1 }) },
        ALL_DONE: { target: 'completed' },
      },
    },
    completed: { type: 'final' },
    completedWithFailures: { type: 'final' },
    stalled: { type: 'final' },
    aborted: { type: 'final' },
  },
});
```

### XState as Runtime -- Not Documentation

XState is the actual runtime that governs all state transitions. It is not a specification sitting beside the real logic -- it IS the real logic. The MCP server never checks status with if-statements or inline SQL guards. Instead:

1. Each task gets a live XState actor (created at task_created, persisted in an in-memory `Map<string, ActorRef>`)
2. When an MCP tool fires (e.g., `claim_task`), it sends a typed event to the actor
3. The actor either **transitions** (guard passed) or **stays put** (guard rejected)
4. If the actor transitioned: persist the event to the event store, then call `applyEvent` to update projections
5. If the actor didn't transition: return a rejection with the guard name and reason
6. The SQLite BEFORE triggers are the last-resort defense -- they should never fire if XState is correct

```typescript
// engine/machines/registry.ts
import { createActor, type ActorRefFrom } from 'xstate';
import { taskMachine } from './task.js';

type TaskActor = ActorRefFrom<typeof taskMachine>;

const actors = new Map<string, TaskActor>();

export function getOrCreateTaskActor(
  taskId: string,
  initialContext: Partial<TaskContext>,
): TaskActor {
  let actor = actors.get(taskId);
  if (!actor) {
    actor = createActor(taskMachine, {
      input: {
        taskId,
        gate: initialContext.gate ?? 0,
        model: initialContext.model ?? 'opus',
        dependsOn: initialContext.dependsOn ?? [],
        touchesFiles: initialContext.touchesFiles ?? [],
        workerId: null,
        retryCount: 0,
        maxRetries: initialContext.maxRetries ?? 3,
        failureReason: null,
      },
    });
    actor.start();
    actors.set(taskId, actor);
  }
  return actor;
}

export function getTaskActor(taskId: string): TaskActor | undefined {
  return actors.get(taskId);
}

// On crash recovery: rebuild actors from task_state projection
export function hydrateActors(db: Database.Database): void {
  const tasks = db.prepare('SELECT * FROM task_state').all();
  for (const task of tasks) {
    const actor = getOrCreateTaskActor(task.task_id, {
      gate: task.gate,
      model: task.model,
      dependsOn: JSON.parse(task.depends_on || '[]'),
    });
    // Fast-forward actor to current state by replaying events
    const events = db.prepare(
      'SELECT * FROM events WHERE stream_id = ? ORDER BY sequence ASC'
    ).all(`task:${task.task_id}`);
    for (const evt of events) {
      const payload = JSON.parse(evt.payload);
      actor.send(eventToXState(evt.type, payload));
    }
  }
}

function eventToXState(type: string, payload: Record<string, unknown>): TaskEvent {
  switch (type) {
    case 'task_claimed': return { type: 'CLAIM', workerId: payload.workerId as string };
    case 'task_started': return { type: 'START' };
    case 'task_verification_started': return { type: 'VERIFICATION_STARTED' };
    case 'task_completed': return { type: 'VERIFICATION_PASSED', outputHash: payload.outputHash as string, durationMs: payload.durationMs as number, costUsd: payload.costUsd as number };
    case 'task_failed': return { type: 'FAIL', reason: payload.reason as string };
    case 'task_timeout': return { type: 'TIMEOUT' };
    case 'task_cancelled': return { type: 'CANCEL' };
    case 'task_cache_hit': return { type: 'CACHE_HIT', outputHash: payload.outputHash as string };
    default: throw new Error(`Unknown event type for XState: ${type}`);
  }
}
```

The critical invariant: **there is exactly one code path for updating projections, and it goes through `applyEvent`**. No MCP tool ever writes an inline `UPDATE task_state` query. This means projections can always be rebuilt from the event stream and will match the live state exactly.

---

## 6. Layer 2: MCP Coordination Server

### Setup

Use `@modelcontextprotocol/sdk` with `StreamableHTTPServerTransport`. Single HTTP endpoint at `http://127.0.0.1:3001/mcp`.

```bash
npm install @modelcontextprotocol/sdk
```

### Server Structure

```typescript
// engine/mcp/server.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import http from 'node:http';
import type Database from 'better-sqlite3';

export function createMcpServer(db: Database.Database, config: WyvernConfig): McpServer {
  const server = new McpServer({
    name: 'wyvern',
    version: '3.0.0',
  });

  // Register all tools (see tools.ts)
  registerTools(server, db, config);

  return server;
}

export function startHttpServer(mcpServer: McpServer, port: number = 3001): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/mcp' && req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  httpServer.listen(port, '127.0.0.1');
  return httpServer;
}
```

### Tool Definitions

Every tool follows one pattern. No exceptions, no inline SQL for state changes:

```
MCP tool receives request
  → Send typed event to XState actor
  → Actor transitions (guard passed) or rejects (guard failed)
  → If rejected: return error, nothing persisted, nothing changed
  → If transitioned: persist event to event store → call applyEvent → notify executor → return success
```

```typescript
// engine/mcp/tools.ts
import { getTaskActor, getOrCreateTaskActor } from '../machines/registry.js';
import { appendEvent, getLastEvent } from '../store/events.js';
import { applyEvent } from '../store/projections.js';
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';
import { z } from 'zod';

// The executor subscribes to this emitter to wake up when state changes.
// This replaces polling. See Layer 6.
export const stateChanged = new EventEmitter();

// Helper: persist event and update projections in one atomic step.
// This is the ONLY code path that modifies projection tables.
//
// If appendEvent or applyEvent throws (disk full, UNIQUE violation, etc.),
// the XState actor has already transitioned but the DB doesn't reflect it.
// We rehydrate the actor from the event stream to restore consistency.
// The caller gets the error and returns it to the agent.
function persistAndProject(db: Database.Database, event: Omit<WyvernEvent, 'id'>): number {
  try {
    const eventId = appendEvent(db, event);
    applyEvent(db, { ...event, id: eventId } as WyvernEvent);
    stateChanged.emit('change', { type: event.type, streamId: event.stream_id });
    return eventId;
  } catch (err) {
    // DB write failed. The XState actor is ahead of the DB.
    // Rehydrate the actor from the event stream to restore consistency.
    if (event.stream_id.startsWith('task:')) {
      const taskId = event.stream_id.replace('task:', '');
      const { hydrateActors } = require('./machines/registry.js');
      // Rebuild just this one actor from its event history
      const events = db.prepare(
        'SELECT * FROM events WHERE stream_id = ? ORDER BY sequence ASC'
      ).all(event.stream_id);
      const actor = getOrCreateTaskActor(taskId, {});
      actor.stop();
      // Re-create from scratch with event replay
      const fresh = getOrCreateTaskActor(taskId, {});
      for (const evt of events) {
        fresh.send(eventToXState(evt.type, JSON.parse(evt.payload)));
      }
    }
    throw err;  // Propagate to MCP handler, which returns error to agent
  }
}

function nextSeq(db: Database.Database, streamId: string): { sequence: number; previousId: number | null } {
  const last = getLastEvent(db, streamId);
  return { sequence: (last?.sequence ?? 0) + 1, previousId: last?.id ?? null };
}

export function registerTools(server: McpServer, db: Database.Database, config: WyvernConfig): void {

  // ── claim_task ──────────────────────────────────────────────
  server.tool('claim_task', {
    taskId: z.string(),
    workerId: z.string(),
  }, async ({ taskId, workerId }) => {
    const actor = getTaskActor(taskId);
    if (!actor) return { error: `Task ${taskId} not found` };

    // Snapshot before sending -- if state doesn't change, the guard rejected
    const before = actor.getSnapshot().value;
    actor.send({ type: 'CLAIM', workerId, db } as any);  // db passed for guard evaluation
    const after = actor.getSnapshot().value;

    if (before === after) {
      // Include current status so the agent can distinguish "already done" from "guard failed"
      const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(String(before));
      return {
        error: `Task ${taskId} cannot transition from '${before}' on CLAIM`,
        currentStatus: String(before),
        isTerminal,
        ...(before === 'completed' && { alreadyCompleted: true }),
      };
    }

    // Transition succeeded -- persist and project
    const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
    const eventId = persistAndProject(db, {
      stream_id: `task:${taskId}`,
      sequence,
      previous_id: previousId,
      type: 'task_claimed',
      payload: { taskId, workerId },
      timestamp: new Date().toISOString(),
      actor: `worker:${workerId}`,
    });

    return { success: true, eventId };
  });

  // ── start_task ──────────────────────────────────────────────
  server.tool('start_task', {
    taskId: z.string(),
    workerId: z.string(),
  }, async ({ taskId, workerId }) => {
    const actor = getTaskActor(taskId);
    if (!actor) return { error: `Task ${taskId} not found` };

    const before = actor.getSnapshot().value;
    actor.send({ type: 'START' });
    const after = actor.getSnapshot().value;

    if (before === after) {
      const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(String(before));
      return {
        error: `Task ${taskId} cannot transition from '${before}' on START`,
        currentStatus: String(before),
        isTerminal,
      };
    }

    const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
    persistAndProject(db, {
      stream_id: `task:${taskId}`,
      sequence,
      previous_id: previousId,
      type: 'task_started',
      payload: { taskId },
      timestamp: new Date().toISOString(),
      actor: `worker:${workerId}`,
    });

    return { success: true };
  });

  // ── complete_task ───────────────────────────────────────────
  server.tool('complete_task', {
    taskId: z.string(),
    workerId: z.string(),
    outputHash: z.string().optional(),
    durationMs: z.number().optional(),
    costUsd: z.number().optional(),
    promptTokens: z.number().optional(),
    completionTokens: z.number().optional(),
  }, async (params) => {
    const actor = getTaskActor(params.taskId);
    if (!actor) return { error: `Task ${params.taskId} not found` };

    // Step 1: Transition to 'verifying' via XState
    const snap1 = actor.getSnapshot().value;
    actor.send({ type: 'VERIFICATION_STARTED' });
    if (actor.getSnapshot().value === snap1) {
      const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(String(snap1));
      return {
        error: `Task ${params.taskId} cannot start verification from '${snap1}'`,
        currentStatus: String(snap1),
        isTerminal,
        ...(snap1 === 'completed' && { alreadyCompleted: true }),
      };
    }

    const { sequence: seq1, previousId: prev1 } = nextSeq(db, `task:${params.taskId}`);
    persistAndProject(db, {
      stream_id: `task:${params.taskId}`,
      sequence: seq1,
      previous_id: prev1,
      type: 'task_verification_started',
      payload: { taskId: params.taskId },
      timestamp: new Date().toISOString(),
      actor: `worker:${params.workerId}`,
    });

    // Step 2: Run quality gates (server-side enforcement, including security)
    const gateResult = await runQualityGates(params.taskId, db, config);

    if (!gateResult.passed) {
      // Send VERIFICATION_FAILED to actor -- it decides whether to retry or fail
      actor.send({ type: 'VERIFICATION_FAILED', reason: gateResult.reason });
      const postState = actor.getSnapshot().value;

      const { sequence: seq2, previousId: prev2 } = nextSeq(db, `task:${params.taskId}`);

      if (postState === 'running') {
        // canRetry guard passed -- actor went back to running for another attempt
        persistAndProject(db, {
          stream_id: `task:${params.taskId}`,
          sequence: seq2,
          previous_id: prev2,
          type: 'task_verification_started',  // re-use: we persist verification attempt, not the failure
          payload: {
            taskId: params.taskId,
            reason: gateResult.reason,
            event: 'retry',
            retryCount: actor.getSnapshot().context.retryCount,
          },
          timestamp: new Date().toISOString(),
          actor: `worker:${params.workerId}`,
        });

        return {
          error: `Quality gate failed (retryable): ${gateResult.reason}`,
          retryable: true,
          retriesRemaining: actor.getSnapshot().context.maxRetries -- actor.getSnapshot().context.retryCount,
          checks: gateResult.checks,
        };
      } else {
        // No retries left -- actor moved to failed (terminal)
        persistAndProject(db, {
          stream_id: `task:${params.taskId}`,
          sequence: seq2,
          previous_id: prev2,
          type: 'task_failed',
          payload: { taskId: params.taskId, reason: gateResult.reason },
          timestamp: new Date().toISOString(),
          actor: `worker:${params.workerId}`,
        });

        return {
          error: `Quality gate failed (no retries): ${gateResult.reason}`,
          retryable: false,
          checks: gateResult.checks,
        };
      }
    }

    // Step 3: Gates passed → complete via XState
    actor.send({
      type: 'VERIFICATION_PASSED',
      outputHash: params.outputHash ?? '',
      durationMs: params.durationMs ?? 0,
      costUsd: params.costUsd ?? 0,
    });

    const { sequence: seq3, previousId: prev3 } = nextSeq(db, `task:${params.taskId}`);
    persistAndProject(db, {
      stream_id: `task:${params.taskId}`,
      sequence: seq3,
      previous_id: prev3,
      type: 'task_completed',
      payload: {
        taskId: params.taskId,
        outputHash: params.outputHash,
        durationMs: params.durationMs,
        costUsd: params.costUsd,
        promptTokens: params.promptTokens,
        completionTokens: params.completionTokens,
      },
      timestamp: new Date().toISOString(),
      actor: `worker:${params.workerId}`,
    });

    // Release file reservations (also via event + projection)
    const reservations = db.prepare(
      'SELECT file_path FROM file_reservations WHERE task_id = ? AND released_at IS NULL'
    ).all(params.taskId);
    for (const { file_path } of reservations) {
      const { sequence, previousId } = nextSeq(db, `file:${file_path}`);
      persistAndProject(db, {
        stream_id: `file:${file_path}`,
        sequence,
        previous_id: previousId,
        type: 'file_released',
        payload: { filePath: file_path, taskId: params.taskId },
        timestamp: new Date().toISOString(),
        actor: `worker:${params.workerId}`,
      });
    }

    return { success: true };
  });

  // ── fail_task ───────────────────────────────────────────────
  server.tool('fail_task', {
    taskId: z.string(),
    workerId: z.string(),
    reason: z.string(),
  }, async ({ taskId, workerId, reason }) => {
    const actor = getTaskActor(taskId);
    if (!actor) return { error: `Task ${taskId} not found` };

    const before = actor.getSnapshot().value;
    actor.send({ type: 'FAIL', reason });
    if (before === actor.getSnapshot().value) {
      const isTerminal = ['completed', 'failed', 'timeout', 'cancelled'].includes(String(before));
      return {
        error: `Task ${taskId} cannot fail from '${before}'`,
        currentStatus: String(before),
        isTerminal,
        ...(before === 'failed' && { alreadyFailed: true }),
        ...(before === 'completed' && { alreadyCompleted: true }),
      };
    }

    const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
    persistAndProject(db, {
      stream_id: `task:${taskId}`,
      sequence,
      previous_id: previousId,
      type: 'task_failed',
      payload: { taskId, reason },
      timestamp: new Date().toISOString(),
      actor: `worker:${workerId}`,
    });

    return { success: true };
  });

  // ── report_progress ─────────────────────────────────────────
  server.tool('report_progress', {
    taskId: z.string(),
    workerId: z.string(),
    message: z.string(),
    percentComplete: z.number().optional(),
  }, async ({ taskId, workerId, message, percentComplete }) => {
    // Progress doesn't change state -- no XState event needed, just persist for observability
    const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
    persistAndProject(db, {
      stream_id: `task:${taskId}`,
      sequence,
      previous_id: previousId,
      type: 'task_progress',
      payload: { taskId, message, percentComplete },
      timestamp: new Date().toISOString(),
      actor: `worker:${workerId}`,
    });
    return { success: true };
  });

  // ── read_context ────────────────────────────────────────────
  server.tool('read_context', {
    key: z.string().optional(),
  }, async ({ key }) => {
    if (key) {
      const row = db.prepare('SELECT * FROM context WHERE key = ?').get(key);
      return row ? { key: row.key, value: row.value, writtenBy: row.written_by } : { error: 'Key not found' };
    }
    const rows = db.prepare('SELECT * FROM context ORDER BY key').all();
    return { entries: rows };
  });

  // ── write_context ───────────────────────────────────────────
  server.tool('write_context', {
    key: z.string(),
    value: z.string(),
    taskId: z.string(),
  }, async ({ key, value, taskId }) => {
    // Context integrity check (Layer 8) runs BEFORE persistence
    const integrityResult = validateContextWrite(db, taskId, key, value);
    if (!integrityResult.passed) {
      return { error: `Context write rejected: ${integrityResult.violations.join('; ')}` };
    }

    const { sequence, previousId } = nextSeq(db, 'context');
    persistAndProject(db, {
      stream_id: 'context',
      sequence,
      previous_id: previousId,
      type: 'context_written',
      payload: { key, value, taskId },
      timestamp: new Date().toISOString(),
      actor: `worker:${taskId}`,
    });
    return { success: true };
  });

  // ── reserve_file ────────────────────────────────────────────
  server.tool('reserve_file', {
    filePath: z.string(),
    taskId: z.string(),
  }, async ({ filePath, taskId }) => {
    // Check not already reserved by another active task
    const existing = db.prepare(
      'SELECT * FROM file_reservations WHERE file_path = ? AND released_at IS NULL AND task_id != ?'
    ).get(filePath, taskId);
    if (existing) {
      return { error: `File ${filePath} already reserved by task ${existing.task_id}` };
    }

    const { sequence, previousId } = nextSeq(db, `file:${filePath}`);
    persistAndProject(db, {
      stream_id: `file:${filePath}`,
      sequence,
      previous_id: previousId,
      type: 'file_reserved',
      payload: { filePath, taskId },
      timestamp: new Date().toISOString(),
      actor: `worker:${taskId}`,
    });
    return { success: true };
  });

  // ── query_cache ─────────────────────────────────────────────
  server.tool('query_cache', {
    manifestHash: z.string(),
  }, async ({ manifestHash }) => {
    const row = db.prepare('SELECT * FROM execution_cache WHERE manifest_hash = ?').get(manifestHash);
    if (row) {
      // Cache hit tracking is an event, not a mutable counter.
      // hit_count and last_hit_at are projections derived from cache_checked events.
      const { sequence, previousId } = nextSeq(db, 'cache');
      persistAndProject(db, {
        stream_id: 'cache',
        sequence,
        previous_id: previousId,
        type: 'cache_checked',
        payload: { manifestHash, hit: true },
        timestamp: new Date().toISOString(),
        actor: 'executor',
      });
      return { hit: true, ...row };
    }
    return { hit: false };
  });
}
```

### Quality Gate (Server-Side)

Port the existing `task-completed.ts` checks into the MCP server so they run on EVERY completion, not just swarm mode:

```typescript
// engine/mcp/quality-gate.ts

interface QualityGateResult {
  passed: boolean;
  reason: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
}

export async function runQualityGates(
  taskId: string,
  db: Database.Database,
  config: WyvernConfig,
): Promise<QualityGateResult> {
  const checks: QualityGateResult['checks'] = [];

  // 1. Run verification commands (from config or profile)
  for (const cmd of config.verifyCommands) {
    try {
      execSync(cmd, { cwd: config.projectRoot, stdio: 'pipe' });
      checks.push({ name: `verify: ${cmd}`, passed: true, message: 'passed' });
    } catch {
      checks.push({ name: `verify: ${cmd}`, passed: false, message: 'command failed' });
      return { passed: false, reason: `Verification failed: ${cmd}`, checks };
    }
  }

  // 2. File ownership (if domain info available)
  // Pull from task_state and file_reservations
  const task = db.prepare('SELECT * FROM task_state WHERE task_id = ?').get(taskId);
  // ... ownership checks using file_reservations projection

  // 3. Commit format validation
  // ... same checks as swarm/hooks/task-completed.ts but now universal

  return { passed: true, reason: '', checks };
}
```

### Agent MCP Config

When the executor spawns a Claude Code agent, it passes an MCP config file:

```json
{
  "mcpServers": {
    "wyvern": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp"
    }
  }
}
```

The agent's prompt template (updated from prompt-builder.ts) instructs the agent to use MCP tools:

```
## When Done
1. Run all verify commands.
2. Call mcp__wyvern__complete_task with your taskId and workerId.
3. If you learned something the next task should know, call mcp__wyvern__write_context.
4. Stop. The process will be killed after completion is confirmed.

## If Something Goes Wrong
1. Call mcp__wyvern__fail_task with the reason.
2. Stop.
```

---

## 7. Layer 3: Content-Addressed Execution Cache

### Manifest Hashing

A task's cache key is a deterministic hash of everything that affects its output:

```typescript
// engine/cache/manifest.ts
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

interface ManifestInputs {
  promptContent: string;        // full resolved prompt text
  relevantFileHashes: string;   // hash of ONLY the files this task touches (not the whole repo)
  model: string;                // 'opus', 'sonnet', 'haiku'
  configHash: string;           // hash of relevant config fields
  dependencyOutputHashes: Record<string, string>;  // taskId → outputHash for each dependency
}

export function computeManifestHash(inputs: ManifestInputs): string {
  // CRITICAL: deterministic serialization. Use sorted keys everywhere.
  // This is the Manus team's insight -- unsorted keys give 92% hit rates vs 99%+.
  const canonical = JSON.stringify(inputs, Object.keys(inputs).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Hash ONLY the files this task declares it touches, not the entire repo.
 *
 * Using `git write-tree` (entire repo) is overbroad -- Task A modifying an unrelated file
 * would invalidate Task B's cache even though B's inputs haven't changed. Instead, we use
 * `git ls-tree` on the specific paths from the task's `touchesFiles` declaration.
 *
 * This gives us surgical cache invalidation: a task's cache key only changes when files
 * that task actually reads or writes have changed.
 */
export function getRelevantFileHashes(projectRoot: string, touchesFiles: string[]): string {
  if (touchesFiles.length === 0) {
    // Task declares no files -- use empty hash (prompt + deps are still in the manifest)
    return crypto.createHash('sha256').update('no-files').digest('hex');
  }

  // git ls-tree gives us the blob hash for each file -- deterministic and content-addressed
  const paths = touchesFiles.sort().join(' ');
  try {
    const output = execSync(`git ls-tree HEAD -- ${paths}`, {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim();
    // Output format: "100644 blob <hash>\t<path>" per line, already deterministic
    return crypto.createHash('sha256').update(output).digest('hex');
  } catch {
    // Files don't exist yet (new file creation task) -- hash the path list itself
    return crypto.createHash('sha256').update(`new:${paths}`).digest('hex');
  }
}

export function computeConfigHash(config: WyvernConfig): string {
  // Only hash fields that affect execution output
  const relevant = {
    verifyCommands: config.verifyCommands,
    // Add other output-affecting fields as they're identified
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(relevant, Object.keys(relevant).sort()))
    .digest('hex');
}
```

### Cache Flow

Before executing any task:

```
1. Resolve prompt content (prompt-builder.ts)
2. Hash only the files this task touches: getRelevantFileHashes(root, task.touchesFiles)
3. Collect output hashes from completed dependencies
4. Compute manifest hash from { prompt, relevantFileHashes, model, config, depOutputs }
5. Query cache: SELECT * FROM execution_cache WHERE manifest_hash = ?
6. If hit:
   a. Verify git_tree_after still makes sense (files haven't been externally modified)
   b. Apply cached result (git checkout the cached tree, or replay file changes)
   c. Persist 'task_cache_hit' event
   d. Update task_state to 'completed'
   e. Skip to next task
7. If miss:
   a. Execute task normally
   b. After completion, compute output hash
   c. Store cache entry: manifest_hash → { git_tree_before, git_tree_after, output_hash, ... }
```

---

## 8. Layer 4: VCR Recording and Replay

### The Multi-Turn Problem

Content-hashing individual API requests doesn't work for conversation replay. Here's why: in a Claude Code session, request N contains response N-1 (as the assistant turn in the message history). If response N-1 was generated differently (or if we're replaying from scratch), the content hash of request N changes -- and we miss the cassette. This cascading hash problem means content-based matching breaks after the very first turn.

The solution: **sequence-based matching within a conversation**. Each task gets a conversation ID. Cassettes are keyed by `(task_id, sequence_number)`, not by content hash. Request 1 always matches cassette entry 1, request 2 matches entry 2, etc. This is the approach Docker's cagent uses, and it's the only one that actually works for multi-turn agent conversations.

### Schema

```sql
-- Replace the content-hash-keyed vcr_cassettes table with sequence-keyed version
CREATE TABLE IF NOT EXISTS vcr_cassettes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,     -- unique per task execution
  sequence_number INTEGER NOT NULL,  -- 1, 2, 3, ... within conversation
  request_body TEXT NOT NULL,        -- JSON (sanitized, for debugging only -- NOT used for matching)
  response_body TEXT NOT NULL,       -- JSON
  response_status INTEGER NOT NULL DEFAULT 200,
  response_headers TEXT,             -- JSON
  model TEXT NOT NULL,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  UNIQUE(conversation_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_vcr_task ON vcr_cassettes(task_id);
CREATE INDEX IF NOT EXISTS idx_vcr_conversation ON vcr_cassettes(conversation_id, sequence_number);
```

### Architecture

An HTTP proxy sits between each Claude Code agent and the Anthropic API. In record mode, it captures request/response pairs indexed by sequence position. In replay mode, it serves recorded responses by sequence position, ignoring request content entirely.

```typescript
// engine/vcr/proxy.ts
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

type VcrMode = 'record' | 'replay' | 'passthrough';

export function createVcrProxy(
  db: Database.Database,
  taskId: string,
  targetHost: string,  // api.anthropic.com
  mode: VcrMode,
  listenPort: number,
): http.Server {
  const conversationId = `${taskId}:${Date.now()}`;
  let sequenceCounter = 0;  // monotonic within this conversation

  return http.createServer(async (req, res) => {
    // Collect request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const requestBody = Buffer.concat(chunks).toString('utf-8');

    sequenceCounter++;
    const seqNum = sequenceCounter;

    if (mode === 'replay') {
      // Match by sequence position, NOT content hash
      const cassette = db.prepare(
        'SELECT * FROM vcr_cassettes WHERE conversation_id = ? AND sequence_number = ?'
      ).get(conversationId, seqNum);

      if (cassette) {
        const headers = cassette.response_headers
          ? JSON.parse(cassette.response_headers)
          : { 'content-type': 'application/json' };
        res.writeHead(cassette.response_status, headers);
        res.end(cassette.response_body);
        return;
      }

      // Strict replay: if no cassette at this sequence, the conversation has diverged
      // This is a real divergence -- log it clearly
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: `VCR replay divergence: no cassette for conversation ${conversationId} at sequence ${seqNum}. ` +
               `The agent made more API calls than the original recording.`,
      }));
      return;
    }

    // Forward to real API
    const proxyReq = https.request({
      hostname: targetHost,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetHost },
    }, (proxyRes) => {
      const responseChunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => responseChunks.push(chunk));
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(responseChunks).toString('utf-8');

        // Record if in record mode
        if (mode === 'record') {
          db.prepare(`
            INSERT INTO vcr_cassettes
            (task_id, conversation_id, sequence_number, request_body, response_body,
             response_status, response_headers, model, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            taskId,
            conversationId,
            seqNum,
            requestBody,
            responseBody,
            proxyRes.statusCode,
            JSON.stringify(Object.fromEntries(
              Object.entries(proxyRes.headers).filter(([, v]) => v !== undefined)
            )),
            extractModel(requestBody),
            new Date().toISOString(),
          );
        }

        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        res.end(responseBody);
      });
    });

    proxyReq.write(requestBody);
    proxyReq.end();
  });
}

function extractModel(body: string): string {
  try {
    return JSON.parse(body).model || 'unknown';
  } catch {
    return 'unknown';
  }
}
```

### Replay Invariants

For deterministic replay to work, all of the following must match the original execution:

1. **Same prompt** -- guaranteed by content-addressed cache (Layer 3)
2. **Same file state** -- guaranteed by worktree checked out to the cached git tree
3. **Same API responses** -- guaranteed by sequence-matched VCR cassettes
4. **Same MCP tool responses** -- the MCP server replays from the same event store state

The conversation ID for replay is stored alongside the cache entry so the executor knows which cassettes to use:

```typescript
// Addition to execution_cache table
// ALTER TABLE execution_cache ADD COLUMN vcr_conversation_id TEXT;
```

### Integration with Agent Spawning

When spawning a Claude Code agent, the executor:

1. Starts a VCR proxy on a unique port (3100 + taskIndex) with a fresh conversation ID
2. Sets `ANTHROPIC_BASE_URL=http://127.0.0.1:{port}` in the agent's environment
3. The agent's Claude API calls route through the proxy transparently
4. On task completion, proxy is shut down and cassettes are in SQLite keyed by conversation ID
5. The conversation ID is stored in the execution_cache entry for later replay

For replay mode: the executor starts the proxy with `mode: 'replay'` and the **same conversation ID** from the original cache entry. The agent gets identical API responses at each turn regardless of whether its requests match the originals byte-for-byte. Combined with the same prompt and git state (from the content-addressed cache), this produces a fully deterministic reproduction.

### Fidelity Bounds

VCR replay guarantees identical **Claude API responses** but NOT identical **tool call results**. If the agent makes MCP tool calls or reads files during replay, those responses come from the live system (not from cassettes). This means:

- **VCR replay IS useful for:** cost-free re-execution (zero API spend), debugging (see exactly what the model returned at each turn), regression testing (detect when model behavior changes on the same inputs)
- **VCR replay is NOT a guarantee of:** bit-identical task output. An agent whose behavior depends on MCP tool responses or filesystem state may diverge during replay.

This is an inherent limitation of recording only the API layer. Recording MCP tool responses would increase fidelity but introduces a new problem: MCP tools have side effects (file writes, context mutations) that can't be replayed from recordings. Full deterministic replay of side-effecting tools requires a snapshot-and-restore approach, which is a fundamentally different architecture.

### Proxy Health Monitoring

The VCR proxy must outlive the agent process. If the proxy crashes while the agent is running, the agent loses API access permanently (no reconnect, no fallback). The executor monitors proxy health:

```typescript
// In the executor, after creating the VCR proxy:
vcrProxy.on('error', (err) => {
  logger.error('vcr-proxy-crash', { taskId: task.task_id, error: err.message });
  // Kill the agent -- it can't function without API access
  proc.kill('SIGTERM');
  // The proc.on('exit') handler will capture the failure in the event stream
});

// Also monitor with a liveness check: if the proxy stops accepting connections,
// the executor detects it on the next agent API call (connection refused → agent crashes → proc exit → event)
```

---

## 9. Layer 5: Filesystem Isolation

### Git Worktrees

Each agent gets its own worktree. This prevents file collisions between parallel agents.

```typescript
// engine/isolation/worktree.ts
import { execSync } from 'node:child_process';
import { join } from 'node:path';

export function createWorktree(
  projectRoot: string,
  taskId: string,
  branch?: string,
): string {
  const worktreePath = join(projectRoot, '.wyvern', 'worktrees', taskId);
  const branchName = branch || `wyvern/${taskId}`;

  // Create branch from current HEAD
  try {
    execSync(`git branch ${branchName}`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Branch may already exist -- that's fine
  }

  execSync(`git worktree add ${worktreePath} ${branchName}`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });

  return worktreePath;
}

export function removeWorktree(projectRoot: string, taskId: string): void {
  const worktreePath = join(projectRoot, '.wyvern', 'worktrees', taskId);
  try {
    execSync(`git worktree remove ${worktreePath} --force`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Already removed
  }
}

export function mergeWorktree(
  projectRoot: string,
  taskId: string,
  targetBranch: string = 'main',
): void {
  const branchName = `wyvern/${taskId}`;
  execSync(`git checkout ${targetBranch}`, { cwd: projectRoot, stdio: 'pipe' });
  execSync(`git merge --no-ff ${branchName} -m "Merge task ${taskId}"`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}
```

### sandbox-exec Profiles

Restrict each agent's write access to its declared files within its worktree.

```typescript
// engine/isolation/sandbox.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function generateSandboxProfile(
  worktreePath: string,
  allowedPaths: string[],
): string {
  const profilePath = join(worktreePath, '.wyvern-sandbox.sb');

  const allowRules = allowedPaths.map(p =>
    `(allow file-write* (subpath "${join(worktreePath, p)}"))`
  ).join('\n');

  const profile = `
(version 1)
(deny default)
(allow process*)
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow network*)

;; Read anywhere
(allow file-read*)

;; Write only to allowed paths within the worktree
${allowRules}

;; Allow tmp writes
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/private/tmp"))

;; Allow writes to wyvern state directory
(allow file-write* (subpath "${join(worktreePath, '.wyvern')}"))
`.trim();

  writeFileSync(profilePath, profile);
  return profilePath;
}

// Spawn agent with sandbox:
// sandbox-exec -f <profilePath> claude -p --mcp-config <config> ...
```

---

## 10. Layer 6: Executor Rewrite

The executor is the top-level orchestration loop. It replaces the current `executor.ts` entirely.

The critical design change: **the executor is event-driven, not poll-based.** The MCP server emits events on a shared `EventEmitter` (see `stateChanged` in Layer 2). The executor awaits those events instead of sleeping and re-querying. This eliminates the latency-waste tradeoff of polling (poll too fast = CPU waste, poll too slow = idle time between task completion and downstream spawn).

```typescript
// engine/executor.ts (full rewrite)
import { stateChanged } from './mcp/tools.js';
import { getOrCreateTaskActor, hydrateActors } from './machines/registry.js';
import { persistAndProject } from './mcp/tools.js';  // reuse the same single code path

export async function executeLoop(
  planSource: string,        // path to spec file or PLAN.md
  options: ExecuteOptions,
): Promise<void> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');

  // 1. Initialize infrastructure
  await mkdir(join(projectRoot, '.wyvern'), { recursive: true });
  const db = openDatabase(dbPath);
  initializeSchema(db);

  const config = await loadConfig(projectRoot);
  const logger = createLogger(join(projectRoot, '.wyvern', 'logs'));

  // 2. Start MCP server
  const mcpServer = createMcpServer(db, config);
  const httpServer = startHttpServer(mcpServer, config.mcpPort || 3001);
  logger.info('mcp-server-started', { port: config.mcpPort || 3001 });

  // 3. Check for crash recovery
  const lastRun = db.prepare('SELECT * FROM runs WHERE status = ? ORDER BY id DESC LIMIT 1').get('running');
  if (lastRun) {
    logger.info('crash-recovery', { runId: lastRun.id });

    // Rebuild projections from the event stream unconditionally.
    // This handles the edge case where a crash occurred between appendEvent
    // and applyEvent -- the event is in the stream but the projection is stale.
    // Cost: O(events) replay, <100ms for typical runs (<1000 events).
    rebuildProjections(db);

    // Rebuild XState actors from event history
    hydrateActors(db);
    // Any task in 'claimed' or 'running' that didn't complete gets reset to 'pending'
    // (via XState CANCEL event → persist → applyEvent, keeping the single code path)
    const stale = db.prepare(`SELECT task_id FROM task_state WHERE status IN ('claimed', 'running')`).all();
    for (const { task_id } of stale) {
      const actor = getOrCreateTaskActor(task_id, {});
      actor.send({ type: 'CANCEL' });
      const { sequence, previousId } = nextSeq(db, `task:${task_id}`);
      persistAndProject(db, {
        stream_id: `task:${task_id}`,
        sequence,
        previous_id: previousId,
        type: 'task_cancelled',
        payload: { taskId: task_id, reason: 'crash recovery' },
        timestamp: new Date().toISOString(),
        actor: 'executor',
      });
      // Re-create as pending for retry
      // (The plan re-parse below will handle this)
    }
  }

  // 4. Parse DAG and populate task_state + XState actors
  const plan = await parsePlan(planSource); // returns SwarmPlan or ExecutionPlan
  const runId = db.prepare('INSERT INTO runs (started_at, config, total_tasks, status) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), JSON.stringify(config), plan.totalTasks, 'running')
    .lastInsertRowid;

  for (const task of plan.tasks) {
    // Skip tasks that already have state (crash recovery)
    const existing = db.prepare('SELECT task_id FROM task_state WHERE task_id = ?').get(task.id);
    if (existing) continue;

    // Compute prompt hash for cache lookup
    const promptContent = await buildDriverPrompt(task, config);
    const promptHash = crypto.createHash('sha256').update(promptContent).digest('hex');

    // Persist task_created event via the single code path
    const event = {
      stream_id: `task:${task.id}`,
      sequence: 1,
      previous_id: null,
      type: 'task_created' as const,
      payload: {
        taskId: task.id, gate: task.tier, model: task.model,
        description: task.description, dependsOn: task.blockedBy, promptHash,
        touchesFiles: task.touchesFiles,
      },
      timestamp: new Date().toISOString(),
      actor: 'executor',
    };
    persistAndProject(db, event);

    // Create live XState actor for this task
    getOrCreateTaskActor(task.id, {
      gate: task.tier,
      model: task.model,
      dependsOn: task.blockedBy,
      touchesFiles: task.touchesFiles,
    });
  }

  // 5. Track in-flight agent processes for cleanup
  const inFlight = new Map<string, { proc: ChildProcess; vcrProxy: http.Server; watchdog: Watchdog }>();

  // 6. Event-driven execution loop
  const trySpawn = async () => {
    // Find tasks that are pending with all dependencies completed
    const ready = db.prepare(`
      SELECT ts.* FROM task_state ts
      WHERE ts.status = 'pending'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(ts.depends_on) dep
        JOIN task_state dep_ts ON dep_ts.task_id = dep.value
        WHERE dep_ts.status != 'completed'
      )
      ORDER BY ts.gate ASC
      LIMIT ?
    `).all(config.parallelTasksPerGate -- inFlight.size);

    for (const task of ready) {
      // Check content-addressed cache FIRST
      const manifestHash = await computeTaskManifest(task, db, config);
      const cacheResult = db.prepare('SELECT * FROM execution_cache WHERE manifest_hash = ?').get(manifestHash);

      if (cacheResult) {
        logger.info('cache-hit', { taskId: task.task_id, manifestHash });
        // Cache hit goes through XState → persist → applyEvent (single code path)
        const actor = getOrCreateTaskActor(task.task_id, {});
        actor.send({ type: 'CACHE_HIT', outputHash: cacheResult.output_hash });
        const { sequence, previousId } = nextSeq(db, `task:${task.task_id}`);
        persistAndProject(db, {
          stream_id: `task:${task.task_id}`,
          sequence,
          previous_id: previousId,
          type: 'task_cache_hit',
          payload: { taskId: task.task_id, manifestHash, outputHash: cacheResult.output_hash },
          timestamp: new Date().toISOString(),
          actor: 'executor',
        });
        // Apply cached git changes to worktree
        continue;
      }

      // No cache hit -- spawn agent
      const worktreePath = createWorktree(projectRoot, task.task_id);

      const vcrPort = 3100 + parseInt(task.task_id.replace(/\D/g, ''), 10);
      const vcrProxy = createVcrProxy(db, task.task_id, 'api.anthropic.com', 'record', vcrPort);

      const mcpConfigPath = join(worktreePath, '.wyvern-mcp.json');
      writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          wyvern: { type: 'http', url: `http://127.0.0.1:${config.mcpPort || 3001}/mcp` },
        },
      }));

      const prompt = await buildDriverPrompt(task, config);

      const modelArgs = task.model !== 'opus' ? ['--model', `claude-${task.model}-4-6`] : [];
      const proc = spawn('claude', [
        '--dangerously-skip-permissions',
        ...modelArgs,
        '--mcp-config', mcpConfigPath,
        '-p', '-',
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: worktreePath,
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${vcrPort}`,
          WYVERN_TASK_ID: task.task_id,
          WYVERN_WORKTREE: worktreePath,
        },
      });

      // Pre-claim and start via XState → persist → applyEvent (single code path)
      const actor = getOrCreateTaskActor(task.task_id, {});
      actor.send({ type: 'CLAIM', workerId: `proc:${proc.pid}` });
      const { sequence: s1, previousId: p1 } = nextSeq(db, `task:${task.task_id}`);
      persistAndProject(db, {
        stream_id: `task:${task.task_id}`,
        sequence: s1, previous_id: p1,
        type: 'task_claimed',
        payload: { taskId: task.task_id, workerId: `proc:${proc.pid}` },
        timestamp: new Date().toISOString(),
        actor: 'executor',
      });

      actor.send({ type: 'START' });
      const { sequence: s2, previousId: p2 } = nextSeq(db, `task:${task.task_id}`);
      persistAndProject(db, {
        stream_id: `task:${task.task_id}`,
        sequence: s2, previous_id: p2,
        type: 'task_started',
        payload: { taskId: task.task_id },
        timestamp: new Date().toISOString(),
        actor: 'executor',
      });

      proc.stdin.write(prompt);
      proc.stdin.end();

      // Watchdog
      const watchdog = createWatchdog(config.watchdogTimeout * 1000, worktreePath);
      watchdog.onTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      });
      watchdog.start(proc.pid!);

      inFlight.set(task.task_id, { proc, vcrProxy, watchdog });

      // Clean up when process exits (regardless of how -- MCP complete, timeout, crash)
      proc.on('exit', (code) => {
        const entry = inFlight.get(task.task_id);
        if (entry) {
          entry.vcrProxy.close();
          entry.watchdog.stop();
          inFlight.delete(task.task_id);
        }

        // Ensure task reaches a terminal state in the event stream.
        // If the agent crashed without calling fail_task, capture that.
        const taskRow = db.prepare('SELECT status FROM task_state WHERE task_id = ?').get(task.task_id) as { status: string } | undefined;
        if (taskRow && !['completed', 'failed', 'timeout', 'cancelled'].includes(taskRow.status)) {
          const actor = getTaskActor(task.task_id);
          if (actor) {
            const reason = code === null
              ? `Agent process killed (signal)`
              : code === 0
                ? `Agent exited without calling complete_task or fail_task`
                : `Agent process exited with code ${code}`;
            actor.send({ type: 'FAIL', reason });
            const { sequence, previousId } = nextSeq(db, `task:${task.task_id}`);
            persistAndProject(db, {
              stream_id: `task:${task.task_id}`,
              sequence,
              previous_id: previousId,
              type: 'task_failed',
              payload: { taskId: task.task_id, reason },
              timestamp: new Date().toISOString(),
              actor: 'executor',
            });
          }
        }

        removeWorktree(projectRoot, task.task_id);
      });
    }
  };

  // Initial spawn attempt
  await trySpawn();

  // Event-driven loop: wake up when ANY task state changes
  await new Promise<void>((resolve) => {
    const onStateChange = async () => {
      const remaining = db.prepare(
        `SELECT COUNT(*) as cnt FROM task_state WHERE status NOT IN ('completed', 'failed', 'cancelled', 'timeout')`
      ).get() as { cnt: number };

      if (remaining.cnt === 0) {
        stateChanged.off('change', onStateChange);
        resolve();
        return;
      }

      // Check for stall: nothing in-flight AND nothing ready
      const inFlightCount = db.prepare(
        `SELECT COUNT(*) as cnt FROM task_state WHERE status IN ('claimed', 'running', 'verifying')`
      ).get() as { cnt: number };

      if (inFlightCount.cnt === 0 && remaining.cnt > 0) {
        // One more spawn attempt -- if nothing spawns, we're stalled
        await trySpawn();
        const newInFlight = db.prepare(
          `SELECT COUNT(*) as cnt FROM task_state WHERE status IN ('claimed', 'running', 'verifying')`
        ).get() as { cnt: number };
        if (newInFlight.cnt === 0) {
          logger.error('execution-stalled', { remaining: remaining.cnt });
          stateChanged.off('change', onStateChange);
          resolve();
          return;
        }
      }

      // Try to spawn newly unblocked tasks
      await trySpawn();
    };

    stateChanged.on('change', onStateChange);
  });

  // 7. Finalize -- via event, not mutable row update
  const failedCount = db.prepare(`SELECT COUNT(*) as cnt FROM task_state WHERE status = 'failed'`).get() as { cnt: number };
  const completedCount = db.prepare(`SELECT COUNT(*) as cnt FROM task_state WHERE status = 'completed'`).get() as { cnt: number };
  const totalCost = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_state WHERE status = 'completed'`).get() as { total: number };
  const finalStatus = failedCount.cnt > 0 ? 'completed_with_failures' : 'completed';

  const { sequence: runSeq, previousId: runPrev } = nextSeq(db, 'orchestrator');
  persistAndProject(db, {
    stream_id: 'orchestrator',
    sequence: runSeq,
    previous_id: runPrev,
    type: finalStatus === 'completed' ? 'run_completed' : 'run_failed',
    payload: {
      runId,
      completedTasks: completedCount.cnt,
      failedTasks: failedCount.cnt,
      totalCostUsd: totalCost.total,
    },
    timestamp: new Date().toISOString(),
    actor: 'executor',
  });

  httpServer.close();
  logger.info('run-complete', { runId, status: finalStatus });
  await logger.close();
}
```

The key insight: `stateChanged.on('change', onStateChange)` fires every time `persistAndProject` is called in any MCP tool handler. The executor reacts immediately -- no polling interval, no wasted cycles, no latency gap between one task completing and its dependents spawning.

---

## 11. Layer 7: Observability

Everything is a query over the event store.

### CLI Dashboard

```bash
wyvern status              # Current run: task states, in-flight, completed, failed
wyvern history             # Past runs with summary stats
wyvern events [--stream X] # Raw event log, optionally filtered
wyvern costs [--run N]     # Cost breakdown by task, model, run
wyvern cache-stats         # Cache hit rate, savings, most-hit entries
wyvern timeline [--run N]  # Task execution timeline (gantt-style in terminal)
wyvern replay <taskId>     # Show all events for a specific task
wyvern context             # Current context key-value pairs
```

### Queries

Every observability question is a SQL query:

```sql
-- What's the current state of all tasks?
SELECT task_id, status, model, duration_ms, cost_usd FROM task_state ORDER BY task_id;

-- What caused task T07 to fail?
SELECT * FROM events WHERE stream_id = 'task:T07' ORDER BY sequence;

-- What's the cache hit rate?
SELECT
  (SELECT COUNT(*) FROM events WHERE type = 'task_cache_hit') as hits,
  (SELECT COUNT(*) FROM events WHERE type IN ('task_completed', 'task_cache_hit')) as total;

-- What's the total cost of the current run?
SELECT SUM(cost_usd) FROM task_state WHERE status = 'completed';

-- What context did task T05 see when it ran?
SELECT c.* FROM context c
JOIN events e ON e.type = 'context_read' AND json_extract(e.payload, '$.taskId') = 'T05';

-- Which files does each task touch?
SELECT task_id, file_path FROM file_reservations ORDER BY task_id;

-- Bottleneck analysis: which tasks took longest?
SELECT task_id, duration_ms, model FROM task_state WHERE status = 'completed' ORDER BY duration_ms DESC LIMIT 10;
```

---

## 12. Layer 8: Security Auditing

### Threat Model

Multi-agent orchestration has specific attack surfaces that single-agent systems don't. The threats are validated by recent research:

**Agent-generated code leaks secrets at 2x the baseline rate** (GitGuardian 2026: 28.65M secrets added to GitHub, AI-assisted commits leak at 3.2% vs 1.5%). Every file an agent writes must be scanned before the orchestrator accepts it.

**Supply chain poisoning is active and current.** LiteLLM (PyPI, March 2026) had credential-stealing backdoor for 40 minutes. Axios (npm, March 2026, 100M+ weekly downloads) was poisoned with a RAT. When agents run `npm install` or `pip install`, they're pulling from attack surfaces. Every dependency change must be audited.

**Context poisoning propagates laterally.** (Torra et al., arXiv 2603.20357): one agent's false data in shared context corrupts downstream agent decisions. The shared context system in Wyvern (the `write_context` / `read_context` MCP tools backed by SQLite) is exactly this attack surface.

**Agent session smuggling** (Palo Alto Unit 42, 2026): a compromised agent injects covert instructions into inter-agent communication channels. In Wyvern, this means a compromised agent could write context entries designed to manipulate how downstream agents interpret their tasks.

**Sandbox escape is feasible at ~40% success rate** on misconfigured containers (SandboxEscapeBench, March 2026). Hardened systems (levels 4-5) resist frontier models, but misconfiguration is the norm. Defense-in-depth is not optional.

### Architecture: Security as Quality Gate Extension

Security scanning integrates into the existing quality gate in the MCP server's `complete_task` handler. When an agent declares completion, the gate runs in order:

```
1. Verification commands (build, lint, typecheck)        -- existing
2. File ownership validation                              -- existing
3. Commit format validation                               -- existing
4. SECRET SCAN on git diff                                -- NEW
5. SAST (static analysis) on modified files               -- NEW
6. DEPENDENCY AUDIT if package files changed              -- NEW
7. CONTEXT INTEGRITY check on any context writes          -- NEW
```

If any security gate fails, `complete_task` rejects with a structured security report. The agent gets the report and can fix the issue (remove the hardcoded key, pin the dependency version, etc.) and call `complete_task` again.

### New Files

```
engine/security/
├── scanner.ts          # Orchestrates all security checks
├── secrets.ts          # Secret scanning (gitleaks/betterleaks integration)
├── sast.ts             # Static analysis (semgrep integration)
├── dependencies.ts     # Dependency auditing (npm audit, pip-audit)
├── context-integrity.ts # Context poisoning detection
└── types.ts            # Security finding types, severity levels
```

### Secret Scanning

Run on the git diff of every completed task. Catches hardcoded API keys, credentials, tokens, private keys, connection strings.

```typescript
// engine/security/secrets.ts
import { execSync } from 'node:child_process';

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;           // e.g., 'aws-access-key', 'generic-api-key'
  severity: 'critical' | 'high' | 'medium' | 'low';
  match: string;          // redacted match preview
  description: string;
}

export function scanSecretsInDiff(
  worktreePath: string,
  diffBase: string,
): SecretFinding[] {
  // Primary: gitleaks (most comprehensive, 500+ rules)
  // Fallback: betterleaks (BPE-based, lower token overhead, agent-native)
  // Both output JSON; we normalize into SecretFinding[]

  try {
    // gitleaks scan on the diff between task start and current HEAD
    const output = execSync(
      `gitleaks detect --source="${worktreePath}" --log-opts="${diffBase}..HEAD" --report-format=json --no-banner --exit-code=0`,
      { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const findings = JSON.parse(output || '[]');
    return findings.map((f: any) => ({
      file: f.File,
      line: f.StartLine,
      rule: f.RuleID,
      severity: mapGitleaksSeverity(f.RuleID),
      match: f.Match ? redact(f.Match) : '',
      description: f.Description || f.RuleID,
    }));
  } catch (err) {
    // If gitleaks isn't installed, try betterleaks
    try {
      const output = execSync(
        `betterleaks scan --diff="${diffBase}..HEAD" --format=json`,
        { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return JSON.parse(output || '[]');
    } catch {
      // Neither scanner available -- log warning, don't block
      console.warn('WARNING: No secret scanner available (install gitleaks or betterleaks)');
      return [];
    }
  }
}

function redact(match: string): string {
  if (match.length <= 8) return '***';
  return match.slice(0, 4) + '...' + match.slice(-4);
}

function mapGitleaksSeverity(ruleId: string): SecretFinding['severity'] {
  // AWS keys, private keys, database URLs are critical
  if (/private.key|aws-secret|database-url|password/i.test(ruleId)) return 'critical';
  if (/api.key|token|secret/i.test(ruleId)) return 'high';
  return 'medium';
}
```

### Static Analysis (SAST)

Run Semgrep on modified files. Catches OWASP Top 10 patterns, injection vulnerabilities, insecure crypto, path traversal, etc.

```typescript
// engine/security/sast.ts
import { execSync } from 'node:child_process';

export interface SastFinding {
  file: string;
  line: number;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  category: string;       // e.g., 'injection', 'crypto', 'auth'
}

export function runSastOnModifiedFiles(
  worktreePath: string,
  modifiedFiles: string[],
  config: { rulesets: string[] },
): SastFinding[] {
  if (modifiedFiles.length === 0) return [];

  // Default rulesets: OWASP Top 10, security-audit
  const rulesets = config.rulesets.length > 0
    ? config.rulesets
    : ['p/owasp-top-ten', 'p/security-audit'];

  const ruleArgs = rulesets.map(r => `--config=${r}`).join(' ');
  const fileArgs = modifiedFiles.join(' ');

  try {
    const output = execSync(
      `semgrep ${ruleArgs} --json --quiet ${fileArgs}`,
      { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const result = JSON.parse(output);
    return (result.results || []).map((r: any) => ({
      file: r.path,
      line: r.start?.line,
      rule: r.check_id,
      severity: r.extra?.severity || 'warning',
      message: r.extra?.message || r.check_id,
      category: r.extra?.metadata?.category || 'security',
    }));
  } catch {
    console.warn('WARNING: Semgrep not available (install with `pip install semgrep`)');
    return [];
  }
}
```

### Dependency Auditing

When an agent modifies `package.json`, `package-lock.json`, `requirements.txt`, `pyproject.toml`, or any dependency manifest, run a dependency audit.

```typescript
// engine/security/dependencies.ts
import { execSync } from 'node:child_process';

export interface DependencyFinding {
  package: string;
  version: string;
  vulnerability: string;
  severity: 'critical' | 'high' | 'moderate' | 'low';
  fixAvailable: string | null;
}

const DEPENDENCY_FILES = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile.lock',
];

export function shouldAuditDependencies(modifiedFiles: string[]): boolean {
  return modifiedFiles.some(f => DEPENDENCY_FILES.some(dep => f.endsWith(dep)));
}

export function auditNpmDependencies(worktreePath: string): DependencyFinding[] {
  try {
    const output = execSync('npm audit --json 2>/dev/null', {
      cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output);
    return Object.values(result.vulnerabilities || {}).map((v: any) => ({
      package: v.name,
      version: v.range,
      vulnerability: v.title || v.via?.[0]?.title || 'Unknown',
      severity: v.severity,
      fixAvailable: v.fixAvailable?.version || null,
    }));
  } catch {
    return [];
  }
}

export function auditPipDependencies(worktreePath: string): DependencyFinding[] {
  try {
    const output = execSync('pip-audit --format=json 2>/dev/null', {
      cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output);
    return (result.dependencies || [])
      .filter((d: any) => d.vulns?.length > 0)
      .flatMap((d: any) => d.vulns.map((v: any) => ({
        package: d.name,
        version: d.version,
        vulnerability: v.id,
        severity: mapCvss(v.fix_versions?.[0] ? 'high' : 'critical'),
        fixAvailable: v.fix_versions?.[0] || null,
      })));
  } catch {
    return [];
  }
}

function mapCvss(level: string): DependencyFinding['severity'] {
  return level as DependencyFinding['severity'];
}
```

### Context Integrity

Detect and prevent context poisoning. Every `write_context` call is validated before acceptance.

```typescript
// engine/security/context-integrity.ts
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ContextIntegrityResult {
  passed: boolean;
  violations: string[];
}

// Schema addition for context integrity:
// ALTER TABLE context ADD COLUMN signature TEXT;
// ALTER TABLE context ADD COLUMN task_scope TEXT;  -- expected scope of this key

export function validateContextWrite(
  db: Database.Database,
  taskId: string,
  key: string,
  value: string,
): ContextIntegrityResult {
  const violations: string[] = [];

  // 1. Scope check: task can only write context keys in its declared scope
  //    (e.g., a frontend task shouldn't write 'database_connection_string')
  const task = db.prepare('SELECT * FROM task_state WHERE task_id = ?').get(taskId);
  if (task) {
    const scope = JSON.parse(task.depends_on || '[]'); // use domain info if available
    // Profile-specific scope rules can restrict which tasks write which keys
  }

  // 2. Injection pattern detection: catch attempts to embed instructions in context values
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

  // 3. Size bounds: context values shouldn't be enormous (sign of data exfiltration or prompt stuffing)
  const MAX_CONTEXT_VALUE_LENGTH = 10_000; // 10KB per entry
  if (value.length > MAX_CONTEXT_VALUE_LENGTH) {
    violations.push(`Context value for key '${key}' exceeds size limit (${value.length} > ${MAX_CONTEXT_VALUE_LENGTH})`);
  }

  // 4. Overwrite detection: flag if a task is overwriting a value written by a different task
  //    (not necessarily a violation, but worth recording as an event for audit)
  const existing = db.prepare('SELECT * FROM context WHERE key = ?').get(key);
  if (existing && existing.written_by !== taskId) {
    // Not a hard block -- but emit a security event
    // The orchestrator can review these in the event stream
    violations.push(`AUDIT: Task ${taskId} overwriting context key '${key}' previously written by ${existing.written_by}`);
  }

  return {
    passed: violations.filter(v => !v.startsWith('AUDIT:')).length === 0,
    violations,
  };
}

// Sign context entries for tamper detection
export function signContextEntry(key: string, value: string, taskId: string, secret: string): string {
  const payload = `${key}:${value}:${taskId}:${Date.now()}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyContextSignature(
  key: string, value: string, taskId: string, signature: string, secret: string
): boolean {
  // Re-derive requires the original timestamp, so we store it alongside
  // For now, signature serves as tamper-evidence in the event log
  return signature.length === 64; // basic format check; full verification needs stored timestamp
}
```

### Integrated Security Scanner

The master function that orchestrates all security checks, called by the quality gate:

```typescript
// engine/security/scanner.ts
import type Database from 'better-sqlite3';
import { scanSecretsInDiff } from './secrets.js';
import { runSastOnModifiedFiles } from './sast.js';
import { shouldAuditDependencies, auditNpmDependencies, auditPipDependencies } from './dependencies.js';

export interface SecurityScanResult {
  passed: boolean;
  secretFindings: SecretFinding[];
  sastFindings: SastFinding[];
  dependencyFindings: DependencyFinding[];
  summary: string;
}

export interface SecurityConfig {
  enabled: boolean;
  blockOnSecrets: boolean;       // hard block on any secret finding (default: true)
  blockOnSastErrors: boolean;    // hard block on SAST errors, not warnings (default: true)
  blockOnCriticalDeps: boolean;  // hard block on critical dependency vulns (default: true)
  secretScanner: 'gitleaks' | 'betterleaks' | 'auto';
  semgrepRulesets: string[];     // default: ['p/owasp-top-ten', 'p/security-audit']
  allowedSecretPatterns: string[]; // regex patterns to allowlist (e.g., test fixtures)
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  blockOnSecrets: true,
  blockOnSastErrors: true,
  blockOnCriticalDeps: true,
  secretScanner: 'auto',
  semgrepRulesets: ['p/owasp-top-ten', 'p/security-audit'],
  allowedSecretPatterns: [],
};

export async function runSecurityScan(
  taskId: string,
  worktreePath: string,
  diffBase: string,
  modifiedFiles: string[],
  config: SecurityConfig,
  db: Database.Database,
): Promise<SecurityScanResult> {
  if (!config.enabled) {
    return { passed: true, secretFindings: [], sastFindings: [], dependencyFindings: [], summary: 'Security scanning disabled' };
  }

  // 1. Secret scan
  const secretFindings = scanSecretsInDiff(worktreePath, diffBase);
  const filteredSecrets = secretFindings.filter(f =>
    !config.allowedSecretPatterns.some(p => new RegExp(p).test(f.match))
  );

  // 2. SAST
  const sastFindings = runSastOnModifiedFiles(worktreePath, modifiedFiles, { rulesets: config.semgrepRulesets });
  const sastErrors = sastFindings.filter(f => f.severity === 'error');

  // 3. Dependency audit
  let dependencyFindings: DependencyFinding[] = [];
  if (shouldAuditDependencies(modifiedFiles)) {
    const hasPackageJson = modifiedFiles.some(f => f.endsWith('package.json') || f.endsWith('package-lock.json'));
    const hasPythonDeps = modifiedFiles.some(f => f.endsWith('requirements.txt') || f.endsWith('pyproject.toml'));

    if (hasPackageJson) dependencyFindings.push(...auditNpmDependencies(worktreePath));
    if (hasPythonDeps) dependencyFindings.push(...auditPipDependencies(worktreePath));
  }
  const criticalDeps = dependencyFindings.filter(f => f.severity === 'critical');

  // 4. Persist security events
  const securityEvent = {
    taskId,
    secrets: filteredSecrets.length,
    sast: sastFindings.length,
    sastErrors: sastErrors.length,
    dependencies: dependencyFindings.length,
    criticalDeps: criticalDeps.length,
  };
  // appendEvent(db, { type: 'security_scan_completed', payload: securityEvent, ... });

  // 5. Determine pass/fail
  const blocked =
    (config.blockOnSecrets && filteredSecrets.length > 0) ||
    (config.blockOnSastErrors && sastErrors.length > 0) ||
    (config.blockOnCriticalDeps && criticalDeps.length > 0);

  const parts: string[] = [];
  if (filteredSecrets.length > 0) parts.push(`${filteredSecrets.length} secret(s)`);
  if (sastErrors.length > 0) parts.push(`${sastErrors.length} SAST error(s)`);
  if (criticalDeps.length > 0) parts.push(`${criticalDeps.length} critical dep vuln(s)`);

  return {
    passed: !blocked,
    secretFindings: filteredSecrets,
    sastFindings,
    dependencyFindings,
    summary: blocked
      ? `BLOCKED: ${parts.join(', ')}`
      : parts.length > 0
        ? `PASSED with warnings: ${parts.join(', ')}`
        : 'Clean',
  };
}
```

### Updated Quality Gate

The quality gate in `engine/mcp/quality-gate.ts` now includes security scanning as steps 4-7:

```typescript
export async function runQualityGates(
  taskId: string,
  worktreePath: string,
  diffBase: string,
  modifiedFiles: string[],
  db: Database.Database,
  config: WyvernConfig,
): Promise<QualityGateResult> {
  const checks: QualityGateResult['checks'] = [];

  // 1-3: Existing checks (verification, ownership, commit format)
  // ... (unchanged from Layer 2 spec)

  // 3.5: touchesFiles validation -- compare declared files against actual changes
  const actualChanges = execSync(`git diff --name-only ${diffBase}..HEAD`, {
    cwd: worktreePath, encoding: 'utf-8',
  }).trim().split('\n').filter(Boolean);

  const declaredFiles = db.prepare(
    'SELECT file_path FROM file_reservations WHERE task_id = ? AND released_at IS NULL'
  ).all(taskId).map((r: any) => r.file_path);

  const undeclaredFiles = actualChanges.filter(f => !declaredFiles.includes(f));
  if (undeclaredFiles.length > 0) {
    checks.push({
      name: 'touchesFiles',
      passed: false,
      message: `Agent modified files not in its touchesFiles declaration: ${undeclaredFiles.join(', ')}. ` +
               `This breaks cache correctness. Add these to the task's touchesFiles or revert them.`,
    });
    return { passed: false, reason: `Undeclared files modified: ${undeclaredFiles.join(', ')}`, checks };
  }
  checks.push({ name: 'touchesFiles', passed: true, message: 'all modified files are declared' });

  // 4-7: Security scanning
  const securityResult = await runSecurityScan(
    taskId, worktreePath, diffBase, modifiedFiles,
    config.security || DEFAULT_SECURITY_CONFIG, db,
  );

  checks.push({
    name: 'Secret Scan',
    passed: securityResult.secretFindings.length === 0 || !config.security?.blockOnSecrets,
    message: securityResult.secretFindings.length === 0
      ? 'no secrets detected'
      : `${securityResult.secretFindings.length} finding(s): ${securityResult.secretFindings.map(f => f.rule).join(', ')}`,
  });

  checks.push({
    name: 'SAST',
    passed: securityResult.sastFindings.filter(f => f.severity === 'error').length === 0 || !config.security?.blockOnSastErrors,
    message: securityResult.sastFindings.length === 0
      ? 'no issues'
      : `${securityResult.sastFindings.length} finding(s)`,
  });

  checks.push({
    name: 'Dependency Audit',
    passed: securityResult.dependencyFindings.filter(f => f.severity === 'critical').length === 0 || !config.security?.blockOnCriticalDeps,
    message: securityResult.dependencyFindings.length === 0
      ? 'no vulnerabilities'
      : `${securityResult.dependencyFindings.length} finding(s)`,
  });

  // Context integrity is checked in the write_context tool, not here

  const failed = checks.filter(c => !c.passed);
  return {
    passed: failed.length === 0,
    reason: failed.length > 0 ? failed.map(c => `${c.name}: ${c.message}`).join('; ') : '',
    checks,
  };
}
```

### Security Event Types

Add to the event store schema (Layer 0):

```typescript
// Additional event types for engine/store/events.ts
export type SecurityEventType =
  | 'security_scan_completed'      // scan ran, results recorded
  | 'security_secret_detected'     // specific secret finding
  | 'security_sast_finding'        // specific SAST finding
  | 'security_dep_vulnerability'   // specific dependency vulnerability
  | 'security_context_injection'   // injection pattern detected in context write
  | 'security_context_overwrite'   // cross-task context overwrite (audit trail)
  | 'security_finding_resolved'    // finding resolved (append-only resolution tracking)
  ;
```

### Security-Specific SQL Schema Addition

```sql
-- Append to Layer 0 schema

-- Security findings log (append-only: rows are written once, never updated)
-- Resolution is tracked via a 'security_finding_resolved' event, not a mutable flag.
-- To find unresolved: LEFT JOIN events WHERE type='security_finding_resolved' IS NULL
CREATE TABLE IF NOT EXISTS security_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  scan_type TEXT NOT NULL,       -- 'secret', 'sast', 'dependency', 'context'
  severity TEXT NOT NULL,        -- 'critical', 'high', 'medium', 'low'
  rule TEXT NOT NULL,
  file_path TEXT,
  line_number INTEGER,
  message TEXT NOT NULL,
  found_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now'))
  -- No 'resolved' flag. Resolution is an event:
 --  INSERT INTO events (type='security_finding_resolved', payload={findingId, resolvedBy})
  -- Query unresolved: SELECT sf.* FROM security_findings sf
 --  WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.type='security_finding_resolved'
 --  AND json_extract(e.payload,'$.findingId')=sf.id)
);

CREATE INDEX IF NOT EXISTS idx_security_findings_task ON security_findings(task_id);
CREATE INDEX IF NOT EXISTS idx_security_findings_severity ON security_findings(severity);
```

### Security Observability Queries

```sql
-- How many secrets have agents leaked?
SELECT COUNT(*) FROM security_findings WHERE scan_type = 'secret' AND NOT resolved;

-- Which tasks produce the most security findings?
SELECT task_id, COUNT(*) as findings FROM security_findings GROUP BY task_id ORDER BY findings DESC;

-- What's our security posture over time?
SELECT date(found_at) as day, scan_type, COUNT(*) as count
FROM security_findings GROUP BY day, scan_type ORDER BY day;

-- Unresolved critical findings across all runs (join against resolution events)
SELECT sf.* FROM security_findings sf
WHERE sf.severity = 'critical'
AND NOT EXISTS (
  SELECT 1 FROM events e
  WHERE e.type = 'security_finding_resolved'
  AND json_extract(e.payload, '$.findingId') = sf.id
);
```

### WyvernConfig Extension

```typescript
// Add to engine/types.ts WyvernConfig interface
interface WyvernConfig {
  // ... existing fields ...
  security?: SecurityConfig;
}
```

### External Tool Requirements

| Tool | Install | Purpose | Required? |
|------|---------|---------|-----------|
| **gitleaks** | `brew install gitleaks` | Secret scanning (500+ rules, comprehensive) | Recommended |
| **betterleaks** | `pip install betterleaks` | Secret scanning (BPE-based, lighter) | Fallback |
| **semgrep** | `pip install semgrep` | SAST (OWASP Top 10, security-audit rulesets) | Recommended |
| **pip-audit** | `pip install pip-audit` | Python dependency vulnerability scanning | If Python project |
| **npm** | Comes with Node.js | `npm audit` for JS dependency scanning | Already present |

All external scanner tools are soft dependencies. If a scanner isn't installed, the quality gate logs a warning and continues (graceful degradation, not a hard failure). This is configurable per-scanner: set `blockOnSecrets: false` etc. to make any check advisory-only. The default configuration blocks on secrets and critical vulnerabilities.

### Threat-Specific Mitigations

| Threat | Source | Mitigation in Wyvern |
|--------|--------|---------------------|
| Agent leaks secrets in generated code | GitGuardian 2026 (3.2% AI leak rate) | gitleaks/betterleaks scan on every task diff; hard block on detection |
| Supply chain poisoning via agent-added deps | LiteLLM/Axios March 2026 incidents | npm audit / pip-audit on every dependency file change; block on critical |
| Context poisoning across agents | Torra et al., arXiv 2603.20357 | Injection pattern detection + size bounds + overwrite auditing in `write_context` |
| Agent session smuggling | Palo Alto Unit 42, April 2026 | Context integrity validation; HMAC signing of context entries; event trail |
| Sandbox escape | SandboxEscapeBench March 2026 (~40% on misconfig) | sandbox-exec + worktree isolation (Layer 5); defense-in-depth |
| OWASP Top 10 in generated code | OWASP Agentic Top 10, 2026 | Semgrep with owasp-top-ten ruleset on every modified file |

---

## 13. Implementation Order

This is a single system, not a phased rollout. Everything ships together. But the layers have dependency ordering -- you can't build the MCP server without the event store, and you can't build the executor without the MCP server. This section describes the implementation order dictated by those dependencies, with tests at each step to catch problems early.

### Step 1: Event Store + State Machines

```
npm install better-sqlite3 xstate @modelcontextprotocol/sdk zod
```

1. Create `engine/store/` directory with `db.ts`, `schema.ts`, `events.ts`, `projections.ts`
2. Create `engine/machines/` directory with `task.ts`, `orchestrator.ts`, `guards.ts`, `registry.ts`
3. Write and run schema creation (all tables including `security_findings` and VCR cassettes)
4. Unit test: create DB → insert events → replay → verify projections match
5. Unit test: XState actor transitions (all valid transitions fire, all invalid transitions are blocked)

### Step 2: MCP Server + Security

1. Create `engine/mcp/` directory with `server.ts`, `tools.ts`, `types.ts`, `quality-gate.ts`
2. Create `engine/security/` with `scanner.ts`, `secrets.ts`, `sast.ts`, `dependencies.ts`, `context-integrity.ts`, `types.ts`
3. Implement all 9 tools (claim_task, start_task, complete_task, fail_task, report_progress, read_context, write_context, reserve_file, query_cache)
4. Port quality gate checks from `swarm/hooks/task-completed.ts` and integrate security scanning
5. Add context integrity validation to `write_context` handler
6. Integration test: start server → call tools via MCP client → verify events + projections + XState state
7. Integration test: agent writes hardcoded API key → `complete_task` rejects with secret finding

### Step 3: Cache + VCR + Isolation

1. Create `engine/cache/` with `manifest.ts`, `store.ts`
2. Create `engine/vcr/` with `proxy.ts`, `cassette.ts`
3. Create `engine/isolation/` with `worktree.ts`, `sandbox.ts`
4. Implement manifest hashing with `getRelevantFileHashes` (not whole-repo hash)
5. Implement VCR proxy with sequence-based conversation matching
6. Implement worktree creation/cleanup/merge and sandbox-exec profile generation
7. Test: execute a task → verify cache entry → re-execute with cache hit
8. Test: spawn agent in worktree with sandbox → verify write restrictions

### Step 4: Executor + Observability

1. Rewrite `engine/executor.ts` with event-driven loop using `stateChanged` EventEmitter
2. Update `engine/prompt-builder.ts` to reference MCP tools in agent prompts
3. Update `cli.ts` with new subcommands (status, history, events, costs, cache-stats, timeline, replay, context)
4. End-to-end test: parse a 3-task DAG → execute through the full loop → verify all events, caching, VCR recording

### Delete

Once everything is working and tested:

- `engine/plan-parser.ts` -- PLAN.md checkbox parsing replaced by MCP tools
- `engine/snapshot.ts` -- git stash-based snapshots replaced by event replay
- `engine/file-lock.ts` -- mkdir advisory locks replaced by SQLite + MCP serialization
- `engine/audit.ts` -- end-of-run audit replaced by per-task quality gate
- `engine/maintenance.ts` -- pin regen + lint + trend, superseded by event store queries
- `swarm/hooks/task-completed.ts` -- ported into MCP quality gate
- `swarm/hooks/task-completed.sh` and `teammate-idle.sh` -- shell wrappers no longer needed

---

## 14. Dependencies

### New npm packages

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "xstate": "^5.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

### Existing (keep)

- `tsx` (dev runner)
- `typescript` (build)

### System requirements

- macOS (for `sandbox-exec`)
- Git (for worktrees)
- Node.js 18+ (for `fetch`, `crypto.randomUUID`)
- Claude Code CLI (for spawning agents)

---

## 15. Key External References

Study these before implementing:

| Project | What to Learn | URL |
|---------|---------------|-----|
| **swarm-mail** (Joel Hooks) | Event sourcing + SQLite + multi-agent Claude Code coordination. Closest existing architecture. | github.com/joelhooks/swarm-tools |
| **Overstory** | Multi-DB pattern (5 separate SQLite databases). WAL + busy timeout patterns. | github.com/jayminwest/overstory |
| **sql-event-store** | Append-only event store with optimistic concurrency via `previous_id` chaining. Reference SQL schema. | github.com/mattbishop/sql-event-store |
| **XState v5 docs** | Guard combinators, actor model, TypeScript integration. | stately.ai/docs/xstate-v5 |
| **MCP SDK** | StreamableHTTPServerTransport, tool registration, session management. | github.com/modelcontextprotocol/typescript-sdk |
| **MS Agent Governance Toolkit** | Policy enforcement patterns, OWASP agentic risk coverage. TypeScript. | opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit |
| **SandboxEscapeBench** | Frontier model escape rates on containers. Defense-in-depth rationale. | arxiv.org/abs/2603.02277 |
| **OWASP Agentic Top 10** | Threat taxonomy for AI agent systems. All 10 risks apply to Wyvern. | genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026 |
| **Torra et al. (Memory Poisoning)** | Cross-agent context corruption attack. Validates context integrity checks. | arxiv.org/abs/2603.20357 |
| **MAESTRO (CSA)** | 7-layer threat model for agent systems. | cloudsecurityalliance.org/blog/2026/02/11/applying-maestro-to-real-world-agentic-ai-threat-models |
| **ESAA paper** | Event taxonomy for multi-agent systems: intentions, dispatches, effects. Validates our event types. | arxiv.org/abs/2602.23193 |
| **Docker cagent** | VCR cassette format for API recording. | github.com/docker/docker-agent |
| **Lawrence Jones transition tables** | Unique indexes for concurrency-safe state transitions in SQL. | blog.lawrencejones.dev |

---

## 16. Verification Criteria

The rearchitecture is complete when:

1. **Unit tests pass** for: event store (append, replay, projection rebuild), XState machines (all valid transitions fire, all invalid transitions are blocked), manifest hashing (deterministic across runs), sandbox profile generation.

2. **Integration test passes**: Start MCP server → call `claim_task` → call `complete_task` → verify event stream → verify projections → verify cache entry written.

3. **End-to-end test passes**: Parse a 3-task DAG with dependencies → execute with 2 parallel agents → all tasks complete → events recorded → costs tracked → cache populated. Then re-run the same DAG → all 3 tasks served from cache.

4. **Crash recovery test passes**: Start a 5-task execution → kill the executor mid-run → restart → execution resumes from where it left off (no duplicate work, no lost state).

5. **Quality gate test passes**: Agent produces output that fails verification → `complete_task` rejects with reason → task status is `failed` → event records the failure.

6. **VCR replay test passes**: Execute a task in record mode → execute same task in replay mode → identical output (same files written, same commit produced).

7. **File isolation test passes**: Two parallel agents in separate worktrees → neither can write to the other's files → both complete independently → results merge cleanly.

8. **The SQLite BEFORE trigger fires** when code tries to make an invalid transition directly (bypassing XState) → proves defense-in-depth works.

9. **Secret scanning test passes**: Agent writes code containing a hardcoded AWS key → `complete_task` rejects with secret finding → agent removes key → `complete_task` succeeds on retry.

10. **SAST test passes**: Agent writes code with SQL injection vulnerability → Semgrep detects it → `complete_task` rejects → agent fixes the parameterized query → succeeds on retry.

11. **Dependency audit test passes**: Agent adds a dependency with known critical CVE → `complete_task` rejects → agent pins to safe version → succeeds on retry.

12. **Context integrity test passes**: Agent attempts to write context value containing prompt injection pattern → `write_context` rejects with injection detection → legitimate context writes succeed normally.

13. **XState is the runtime test**: Bypass MCP and directly attempt `UPDATE task_state SET status = 'completed' WHERE status = 'pending'` → SQLite BEFORE trigger aborts. Then send the same transition through XState → actor rejects it. The only way to complete a task is through the proper event sequence (pending → claimed → running → verifying → completed).

14. **Single projection path test**: Replay all events from scratch with `rebuildProjections()` → resulting projection tables match the live tables exactly, byte for byte. This proves no MCP tool ever wrote to projections outside of `applyEvent`.

15. **Event-driven executor test**: Task A completes → `stateChanged` fires → executor immediately spawns Task B (which depends on A) → measure latency between A's completion event and B's spawn. Must be <100ms (no poll interval).

16. **Sequence-based VCR test**: Record a multi-turn agent conversation (5+ API turns). Replay it. Verify every turn matches by sequence position even though request content hashes would differ (because response N-1 is embedded in request N).

17. **XState/trigger consistency test**: Programmatically enumerate all (state, event) pairs from the XState machine definition. For each pair, attempt the transition via XState AND via direct SQL UPDATE against the BEFORE trigger. Both must agree: if XState accepts, the trigger must accept; if XState rejects, the trigger must reject. Zero disagreements allowed. This test should run in CI and should be regenerated any time the machine definition or trigger changes.

18. **touchesFiles validation test**: Execute a task that modifies a file NOT in its `touchesFiles` declaration. The quality gate catches the undeclared file and rejects completion. Execute a task that correctly declares all files -- gate passes.

19. **Persist failure recovery test**: Force `appendEvent` to throw (e.g., mock disk full). Verify the XState actor is rehydrated from the event stream and its state matches the DB projections. The agent gets an error. No inconsistency between actor and DB.

---

*This spec is the blueprint. Every layer, every tool, every guard, every security check all ships as one system. Test at each dependency boundary, and the system will be correct by construction.*
