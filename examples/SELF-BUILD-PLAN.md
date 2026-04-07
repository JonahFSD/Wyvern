# Wyvern Rearchitecture: Execution Plan

**For:** Another Claude instance (Cowork with parallel subagents, or Wyvern batch)
**Spec:** `wyvern/REARCHITECTURE.md` (2,947 lines -- the complete executable spec)
**Analysis:** `wyvern/REARCHITECTURE-ANALYSIS.md` (500+ lines -- invariants, failure modes, Bayesian confidence)
**Read both files in full before starting any task.**

---

## Ground Rules

1. **No phasing, no deferral.** Everything ships as one system. Do not cut scope.
2. **The spec is the blueprint.** Every TypeScript code block in REARCHITECTURE.md is the implementation. Translate it directly into files. Do not redesign, do not "improve." If you think something is wrong, check the analysis doc -- it probably already identified and fixed it.
3. **Append-only invariant.** The event store is the single source of truth. Projection tables are derived. No mutable state outside the event stream. See Analysis §1 for the audit.
4. **Single code path for projections.** Every state change goes through `persistAndProject()` → `appendEvent()` + `applyEvent()`. No inline SQL updates to projection tables in any MCP tool handler.
5. **XState is the runtime.** MCP tools send events to XState actors. Actors transition or reject. Only on transition does the event get persisted. No if-statement status checks.
6. **Test at each boundary.** Each task has acceptance criteria. Run them before declaring done.

---

## Prerequisites (run before any task)

```bash
cd wyvern
npm install better-sqlite3 @types/better-sqlite3 xstate @modelcontextprotocol/sdk zod
```

Verify tsconfig.json has `"strict": true` and `"module": "NodeNext"` (it does).

---

## Task DAG

```
T01 ──┐
T02 ──┼──→ T07 ──→ T08 ──┐
T03 ──┘                    │
                           ├──→ T12 ──→ T13 ──→ T14
T04 ──┐                    │
T05 ──┼──→ T09 ────────────┘
T06 ──┘

T10 ───────────────────────────→ T14
T11 ───────────────────────────→ T14
```

Gate 1 (parallel): T01, T02, T03, T04, T05, T06, T10, T11
Gate 2 (parallel): T07, T08, T09
Gate 3: T12
Gate 4: T13
Gate 5: T14

---

## Gate 1 -- Foundation (all parallel, no dependencies)

### T01: SQLite Database Setup
**Creates:** `engine/store/db.ts`, `engine/store/schema.ts`
**Touches:** `engine/store/db.ts`, `engine/store/schema.ts`
**Model:** sonnet

Create the database module. Reference REARCHITECTURE.md §4 "Database Setup" and "Schema."

`engine/store/db.ts`:
- `openDatabase(dbPath: string): Database.Database` -- opens SQLite with WAL, NORMAL sync, 5s busy timeout, foreign keys ON
- Export the type for consumers

`engine/store/schema.ts`:
- `initializeSchema(db: Database.Database): void` -- creates all tables if not exist:
  -- `events` (append-only, UNIQUE(stream_id, sequence), indexes on stream, type, timestamp)
  -- `task_state` (projection, CHECK constraint on status, BEFORE trigger for valid transitions)
  -- `file_reservations` (projection)
  -- `context` (projection)
  -- `execution_cache` (write-once: no hit_count, no last_hit_at, includes vcr_conversation_id)
  -- `vcr_cassettes` (write-once, UNIQUE(conversation_id, sequence_number), indexes)
  -- `runs` (write-once: no status/completed_at columns, just id/started_at/config/total_tasks)
  -- `security_findings` (write-once: no resolved flag)
- Include ALL indexes from the spec
- The BEFORE trigger must match the XState machine transitions exactly (see Analysis §2 for the matrix)

**Acceptance:**
```bash
npx tsx -e "
import { openDatabase } from './engine/store/db.js';
import { initializeSchema } from './engine/store/schema.js';
import { mkdirSync } from 'fs';
mkdirSync('.wyvern', { recursive: true });
const db = openDatabase('.wyvern/test.db');
initializeSchema(db);
// Verify tables exist
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map(t => t.name).sort());
// Verify trigger exists
const triggers = db.prepare(\"SELECT name FROM sqlite_master WHERE type='trigger'\").all();
console.log('Triggers:', triggers.map(t => t.name));
// Verify BEFORE trigger blocks illegal transition
db.prepare(\"INSERT INTO task_state (task_id, status, gate, model) VALUES ('test', 'pending', 1, 'sonnet')\").run();
try {
  db.prepare(\"UPDATE task_state SET status = 'completed' WHERE task_id = 'test'\").run();
  console.log('ERROR: trigger did not fire');
  process.exit(1);
} catch (e) {
  console.log('PASS: trigger blocked illegal transition:', e.message);
}
db.close();
"
```

---

### T02: Event Store Operations
**Creates:** `engine/store/events.ts`
**Touches:** `engine/store/events.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §4 "Event Types" and "Event Store Operations."

- Define `EventType` union (all types including security events)
- Define `WyvernEvent` interface
- `appendEvent(db, event): number` -- INSERT into events, return lastInsertRowid
- `replayStream(db, streamId): WyvernEvent[]` -- SELECT ordered by sequence
- `replayAll(db, since?): WyvernEvent[]` -- SELECT all or since timestamp
- `getLastEvent(db, streamId): WyvernEvent | null` -- SELECT ... ORDER BY sequence DESC LIMIT 1

**Acceptance:**
```bash
npx tsx -e "
import { openDatabase } from './engine/store/db.js';
import { initializeSchema } from './engine/store/schema.js';
import { appendEvent, replayStream, getLastEvent } from './engine/store/events.js';
const db = openDatabase('.wyvern/test.db');
initializeSchema(db);
const id = appendEvent(db, { stream_id: 'task:T01', sequence: 1, previous_id: null, type: 'task_created', payload: { taskId: 'T01' }, timestamp: new Date().toISOString(), actor: 'test' });
console.log('Event ID:', id);
const events = replayStream(db, 'task:T01');
console.log('Events:', events.length === 1 ? 'PASS' : 'FAIL');
const last = getLastEvent(db, 'task:T01');
console.log('Last event:', last?.type === 'task_created' ? 'PASS' : 'FAIL');
db.close();
"
```

---

### T03: Projections
**Creates:** `engine/store/projections.ts`
**Touches:** `engine/store/projections.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §4 "Projections."

- `updateTaskProjection(db, event): void` -- switch on event.type, handle ALL cases: task_created, task_claimed, task_started, task_completed, task_failed, task_timeout, task_cache_hit, task_cancelled, task_verification_started
- `updateFileProjection(db, event): void` -- file_reserved, file_released
- `updateContextProjection(db, event): void` -- context_written
- `applyEvent(db, event): void` -- calls all three updaters
- `rebuildProjections(db): void` -- DELETE all projection tables, replay all events through applyEvent

**Critical:** The projection functions use `event.timestamp` for all temporal fields, never `new Date()`. This ensures replay produces identical results.

**Acceptance:**
```bash
npx tsx -e "
import { openDatabase } from './engine/store/db.js';
import { initializeSchema } from './engine/store/schema.js';
import { appendEvent } from './engine/store/events.js';
import { applyEvent, rebuildProjections } from './engine/store/projections.js';
const db = openDatabase('.wyvern/test.db');
initializeSchema(db);
// Create task
const ts = new Date().toISOString();
const e1 = { stream_id: 'task:T01', sequence: 1, previous_id: null, type: 'task_created', payload: { taskId: 'T01', gate: 1, model: 'sonnet', description: 'test', dependsOn: [], promptHash: 'abc' }, timestamp: ts, actor: 'test' };
const id1 = appendEvent(db, e1);
applyEvent(db, { ...e1, id: id1 });
// Verify projection
let row = db.prepare('SELECT * FROM task_state WHERE task_id = ?').get('T01');
console.log('Status:', row.status === 'pending' ? 'PASS' : 'FAIL');
// Rebuild and verify same result
rebuildProjections(db);
row = db.prepare('SELECT * FROM task_state WHERE task_id = ?').get('T01');
console.log('After rebuild:', row.status === 'pending' ? 'PASS' : 'FAIL');
db.close();
"
```

---

### T04: XState Task Machine
**Creates:** `engine/machines/task.ts`
**Touches:** `engine/machines/task.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §5 "Task Lifecycle Machine."

- Define `TaskContext` and `TaskEvent` types
- Define all guards: `dependenciesMet`, `withinBudget`, `filesAvailable`, `canRetry`
- Define all actions: `assignWorker`, `incrementRetry`, `setFailureReason`
- Create the machine with `setup().createMachine()` -- 8 states, all transitions per the spec
- Export `taskMachine`, `TaskContext`, `TaskEvent`

**Acceptance:**
```bash
npx tsx -e "
import { createActor } from 'xstate';
import { taskMachine } from './engine/machines/task.js';
// Test happy path
const actor = createActor(taskMachine, { input: { taskId: 'T01', gate: 1, model: 'sonnet', dependsOn: [], touchesFiles: [], workerId: null, retryCount: 0, maxRetries: 3, failureReason: null } });
actor.start();
console.log('Initial:', actor.getSnapshot().value);
actor.send({ type: 'CLAIM', workerId: 'w1' });
console.log('After CLAIM:', actor.getSnapshot().value === 'claimed' ? 'PASS' : 'FAIL');
actor.send({ type: 'START' });
console.log('After START:', actor.getSnapshot().value === 'running' ? 'PASS' : 'FAIL');
actor.send({ type: 'VERIFICATION_STARTED' });
console.log('After VERIF:', actor.getSnapshot().value === 'verifying' ? 'PASS' : 'FAIL');
actor.send({ type: 'VERIFICATION_PASSED', outputHash: 'x', durationMs: 100, costUsd: 0.01 });
console.log('After PASS:', actor.getSnapshot().value === 'completed' ? 'PASS' : 'FAIL');
// Test illegal transition: CLAIM from completed
actor.send({ type: 'CLAIM', workerId: 'w2' });
console.log('Completed stays:', actor.getSnapshot().value === 'completed' ? 'PASS' : 'FAIL');
// Test retry path
const actor2 = createActor(taskMachine, { input: { taskId: 'T02', gate: 1, model: 'sonnet', dependsOn: [], touchesFiles: [], workerId: null, retryCount: 0, maxRetries: 2, failureReason: null } });
actor2.start();
actor2.send({ type: 'CLAIM', workerId: 'w1' });
actor2.send({ type: 'START' });
actor2.send({ type: 'VERIFICATION_STARTED' });
actor2.send({ type: 'VERIFICATION_FAILED', reason: 'lint failed' });
console.log('After retry:', actor2.getSnapshot().value === 'running' ? 'PASS' : 'FAIL');
console.log('Retry count:', actor2.getSnapshot().context.retryCount === 1 ? 'PASS' : 'FAIL');
"
```

---

### T05: XState Orchestrator Machine
**Creates:** `engine/machines/orchestrator.ts`
**Touches:** `engine/machines/orchestrator.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §5 "Orchestrator Machine."

- Define `OrchestratorContext`, `OrchestratorEvent`
- Guards: `allTasksFinished`, `hasFailures`
- States: planning, executing, draining, completed, completedWithFailures, stalled, aborted
- Export `orchestratorMachine`

**Acceptance:** Create actor, send PLAN_PARSED, send TASK_COMPLETED × N, send ALL_DONE, verify state is `completed`.

---

### T06: Actor Registry
**Creates:** `engine/machines/registry.ts`, `engine/machines/guards.ts`
**Touches:** `engine/machines/registry.ts`, `engine/machines/guards.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §5 "XState as Runtime" section.

`engine/machines/registry.ts`:
- `getOrCreateTaskActor(taskId, initialContext): TaskActor` -- Map-backed registry
- `getTaskActor(taskId): TaskActor | undefined`
- `hydrateActors(db): void` -- rebuild all actors from task_state + event history
- `eventToXState(type, payload): TaskEvent` -- maps event store types to XState events

`engine/machines/guards.ts`:
- Export any shared guard helpers used across machines

**Acceptance:** Create two actors, verify they're independent. Hydrate from a DB with events, verify actor states match projections.

---

### T10: Security Scanners
**Creates:** `engine/security/scanner.ts`, `engine/security/secrets.ts`, `engine/security/sast.ts`, `engine/security/dependencies.ts`, `engine/security/context-integrity.ts`, `engine/security/types.ts`
**Touches:** all files in `engine/security/`
**Model:** sonnet

Reference REARCHITECTURE.md §12 "Layer 8: Security Auditing" -- ALL of it.

This is a self-contained module. Implement every file exactly as specified:
- `types.ts`: SecretFinding, SastFinding, DependencyFinding, ContextIntegrityResult, SecurityConfig, DEFAULT_SECURITY_CONFIG, SecurityScanResult
- `secrets.ts`: scanSecretsInDiff (gitleaks primary, betterleaks fallback)
- `sast.ts`: runSastOnModifiedFiles (semgrep)
- `dependencies.ts`: shouldAuditDependencies, auditNpmDependencies, auditPipDependencies
- `context-integrity.ts`: validateContextWrite (scope check, injection patterns, size bounds, overwrite detection), signContextEntry, verifyContextSignature
- `scanner.ts`: runSecurityScan (orchestrates all checks, returns SecurityScanResult)

**Acceptance:** Unit tests for injection pattern detection in context-integrity. Verify scanner returns clean result when no tools are installed (graceful degradation).

---

### T11: Filesystem Isolation
**Creates:** `engine/isolation/worktree.ts`, `engine/isolation/sandbox.ts`
**Touches:** `engine/isolation/worktree.ts`, `engine/isolation/sandbox.ts`
**Model:** sonnet

Reference REARCHITECTURE.md §9 "Layer 5: Filesystem Isolation."

- `worktree.ts`: createWorktree, removeWorktree, mergeWorktree
- `sandbox.ts`: generateSandboxProfile (macOS sandbox-exec .sb file generation)

**Acceptance:** Create a worktree from the current repo, verify it exists, remove it.

---

## Gate 2 -- Integration Layer (depends on Gate 1)

### T07: MCP Server + Tools
**Creates:** `engine/mcp/server.ts`, `engine/mcp/tools.ts`, `engine/mcp/types.ts`
**Touches:** all files in `engine/mcp/` except quality-gate.ts
**Depends on:** T01, T02, T03, T04, T05, T06
**Model:** opus

**This is the most critical task.** Reference REARCHITECTURE.md §6 "Layer 2: MCP Coordination Server" -- the ENTIRE section.

`engine/mcp/server.ts`:
- `createMcpServer(db, config): McpServer`
- `startHttpServer(mcpServer, port): http.Server`
- StreamableHTTPServerTransport on `/mcp`

`engine/mcp/types.ts`:
- Request/response types for all tools

`engine/mcp/tools.ts`:
- `stateChanged` EventEmitter (executor subscribes to this)
- `persistAndProject(db, event): number` -- the SINGLE code path. With try/catch for actor rehydration on persist failure.
- `nextSeq(db, streamId)` helper
- `registerTools(server, db, config)` -- all 9 tools:
  -- `claim_task` -- XState actor send → persist → project. Terminal-state rejection includes `currentStatus`, `isTerminal`, `alreadyCompleted`.
  -- `start_task` -- same pattern
  -- `complete_task` -- verification flow: VERIFICATION_STARTED → quality gate → VERIFICATION_PASSED or VERIFICATION_FAILED (with retry check). Releases file reservations via events.
  -- `fail_task` -- same pattern, includes `alreadyFailed` on terminal rejection
  -- `report_progress` -- event-only, no XState transition
  -- `read_context` -- pure read
  -- `write_context` -- context integrity check BEFORE persist
  -- `reserve_file` -- check exclusivity, persist
  -- `query_cache` -- persist cache_checked event (not mutable counter)

**CRITICAL INVARIANTS (from Analysis §3, §4):**
1. No inline `UPDATE task_state` anywhere in this file
2. Every state change goes through `persistAndProject`
3. XState actor is the authority -- check `before === after` to detect rejection
4. `persistAndProject` wraps in try/catch and rehydrates actor on failure
5. Terminal-state rejections include status info for idempotency

**Acceptance:**
```bash
# Start MCP server, call claim_task via HTTP, verify event + projection
npx tsx -e "
import { openDatabase } from './engine/store/db.js';
import { initializeSchema } from './engine/store/schema.js';
import { createMcpServer, startHttpServer } from './engine/mcp/server.js';
// ... setup, create task, call claim_task via fetch to localhost:3001/mcp
// ... verify task_state shows 'claimed', events table has task_claimed event
"
```

---

### T08: Quality Gate
**Creates:** `engine/mcp/quality-gate.ts`
**Touches:** `engine/mcp/quality-gate.ts`
**Depends on:** T07, T10
**Model:** sonnet

Reference REARCHITECTURE.md §6 "Quality Gate (Server-Side)" and §12 "Updated Quality Gate."

- Port checks from `swarm/hooks/task-completed.ts` (read that file for the 6 existing checks)
- Add touchesFiles validation (git diff --name-only vs file_reservations)
- Integrate security scanning (call `runSecurityScan` from T10)
- Return `QualityGateResult` with structured check details

**Acceptance:** Mock a task that modified an undeclared file → gate rejects. Mock a clean task → gate passes.

---

### T09: Cache + VCR
**Creates:** `engine/cache/manifest.ts`, `engine/cache/store.ts`, `engine/vcr/proxy.ts`, `engine/vcr/cassette.ts`
**Touches:** all files in `engine/cache/` and `engine/vcr/`
**Depends on:** T01, T02, T03
**Model:** sonnet

**Cache** -- Reference REARCHITECTURE.md §7:
- `manifest.ts`: `computeManifestHash(inputs)`, `getRelevantFileHashes(root, touchesFiles)` (git ls-tree, NOT git write-tree), `computeConfigHash(config)`
- `store.ts`: cache lookup, cache write, cache stats queries

**VCR** -- Reference REARCHITECTURE.md §8:
- `proxy.ts`: `createVcrProxy(db, taskId, targetHost, mode, listenPort)` -- sequence-based matching, NOT content-hash. Uses `conversationId` + monotonic `sequenceCounter`. Strict replay returns 500 on sequence overflow.
- `cassette.ts`: helpers for cassette queries, conversation ID management

**Acceptance:**
- Manifest hash is deterministic: same inputs → same hash across runs
- `getRelevantFileHashes` returns different hashes when a touched file changes, same hash when untouched files change
- VCR proxy records and replays by sequence position

---

## Gate 3 -- Executor (depends on Gate 2)

### T12: Executor Rewrite
**Creates:** (rewrites) `engine/executor.ts`
**Touches:** `engine/executor.ts`
**Depends on:** T07, T08, T09, T10, T11
**Model:** opus

Reference REARCHITECTURE.md §10 "Layer 6: Executor Rewrite" -- the ENTIRE section.

This is the full rewrite. Key architecture points:

1. **Event-driven, not poll-based.** Subscribe to `stateChanged` EventEmitter from MCP tools. No `sleep(pollInterval)`.
2. **Crash recovery:** detect stale run → `rebuildProjections(db)` → `hydrateActors(db)` → cancel stale tasks via XState → persistAndProject → re-parse plan.
3. **Task lifecycle:** For each ready task: check cache → if hit, CACHE_HIT via XState → persist. If miss: create worktree → start VCR proxy (with `on('error')` handler) → write MCP config → build prompt → spawn claude process → pre-claim + start via XState → persist.
4. **Process tracking:** `inFlight` Map tracks proc/vcrProxy/watchdog per task. `proc.on('exit')` cleans up AND captures task failure if not in terminal state.
5. **Completion detection:** `stateChanged` handler checks remaining count. If 0 → resolve. If stalled → log and resolve.
6. **Finalization:** run_completed/run_failed event via persistAndProject (not mutable UPDATE on runs table).

**Acceptance:** Create a 3-task DAG (T01→T02→T03 where T02 depends on T01, T03 depends on T02). Execute. All three complete in order. Events are in the stream. Cache entries are written.

---

## Gate 4 -- Integration (depends on Gate 3)

### T13: Config, Prompt Builder, CLI Updates
**Creates:** (modifies) `engine/config.ts`, `engine/prompt-builder.ts`, `cli.ts`
**Touches:** `engine/config.ts`, `engine/prompt-builder.ts`, `cli.ts`
**Depends on:** T12
**Model:** sonnet

**config.ts** -- Add to WyvernConfig interface:
- `mcpPort?: number` (default 3001)
- `security?: SecurityConfig`
- `budgetLimitUsd?: number`
- `parallelTasksPerGate?: number`

**prompt-builder.ts** -- Update agent prompt template to reference MCP tools:
- Add "When Done" and "If Something Goes Wrong" sections per REARCHITECTURE.md §6 "Agent MCP Config"
- Replace `{{context:key}}` resolution with instruction to use `mcp__wyvern__read_context`

**cli.ts** -- Add observability subcommands per REARCHITECTURE.md §11:
- `wyvern status` -- current run task states
- `wyvern history` -- past runs
- `wyvern events [--stream X]` -- raw event log
- `wyvern costs [--run N]` -- cost breakdown
- `wyvern cache-stats` -- hit rate, savings
- `wyvern timeline [--run N]` -- task execution timeline
- `wyvern replay <taskId>` -- show all events for a task
- `wyvern context` -- current context key-value pairs

All queries are SQL over the event store / projections. See §11 for the exact queries.

**Acceptance:** `npx tsx cli.ts status` runs without error against an empty DB. `npx tsx cli.ts events` returns an empty list.

---

## Gate 5 -- Cleanup + Tests (depends on Gate 4)

### T14: Delete Old Files + End-to-End Tests
**Touches:** deletes old files, creates test files
**Depends on:** T12, T13, T10, T11
**Model:** opus

**Delete** (per REARCHITECTURE.md §13):
- `engine/plan-parser.ts`
- `engine/snapshot.ts`
- `engine/file-lock.ts`
- `engine/audit.ts`
- `engine/maintenance.ts`
- `swarm/hooks/task-completed.ts`

**DO NOT delete** anything in `swarm/` that's still imported (check with grep first). Keep `swarm/dependency-graph.ts`, `swarm/types.ts`, `swarm/conventions/`.

**Update** `package.json`:
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

**Verify** `npx tsc --noEmit` passes (no type errors across the entire project).

**Run verification criteria** from REARCHITECTURE.md §16 -- at minimum:
- #1: Unit tests for event store, XState machines, manifest hashing
- #2: Integration test: MCP server → claim → complete → verify events + projections
- #8: BEFORE trigger fires on illegal direct SQL
- #13: XState rejects illegal transition AND trigger agrees
- #14: rebuildProjections matches live state
- #17: XState/trigger consistency (exhaustive enumeration)

**Acceptance:** `npx tsc --noEmit` exits 0. All verification tests pass.

---

## Summary

| Task | Gate | Model | Creates | Depends On |
|------|------|-------|---------|------------|
| T01 | 1 | sonnet | store/db.ts, store/schema.ts | -- |
| T02 | 1 | sonnet | store/events.ts | -- |
| T03 | 1 | sonnet | store/projections.ts | -- |
| T04 | 1 | sonnet | machines/task.ts | -- |
| T05 | 1 | sonnet | machines/orchestrator.ts | -- |
| T06 | 1 | sonnet | machines/registry.ts, machines/guards.ts | -- |
| T10 | 1 | sonnet | security/* (6 files) | -- |
| T11 | 1 | sonnet | isolation/worktree.ts, isolation/sandbox.ts | -- |
| T07 | 2 | **opus** | mcp/server.ts, mcp/tools.ts, mcp/types.ts | T01-T06 |
| T08 | 2 | sonnet | mcp/quality-gate.ts | T07, T10 |
| T09 | 2 | sonnet | cache/*, vcr/* | T01-T03 |
| T12 | 3 | **opus** | executor.ts (rewrite) | T07-T09, T10-T11 |
| T13 | 4 | sonnet | config.ts, prompt-builder.ts, cli.ts (modify) | T12 |
| T14 | 5 | **opus** | deletes + tests | T10-T13 |

**Total: 14 tasks across 5 gates. 8 tasks in Gate 1 (fully parallel). 27 new files. 6 deleted files. 3 modified files.**
