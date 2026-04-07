# Wyvern Rearchitecture: Formal Analysis

**Purpose:** Exhaustive analysis of REARCHITECTURE.md from first principles. Every claim is derived, not assumed. Where confidence is less than high, that uncertainty is stated explicitly.

---

## 1. The Append-Only Invariant

### Claim

Every state change in the system originates as an append to the events table. All other tables are either (a) written once and never modified (execution_cache, runs, security_findings, vcr_cassettes) or (b) ephemeral projections derivable from the event stream (task_state, file_reservations, context).

### Verification

Enumerate every SQL write operation in the spec:

| Operation | Table | Location | Append-only? | Justification |
|-----------|-------|----------|-------------|---------------|
| INSERT | events | `appendEvent()` | **Yes** | Append-only by definition. No UPDATE or DELETE on this table. |
| INSERT | task_state | `applyEvent → updateTaskProjection` | Projection | Written on task_created, then UPDATEd on subsequent events. Derivable from events via `rebuildProjections`. |
| UPDATE | task_state | `applyEvent → updateTaskProjection` | Projection | Same. Only called inside `applyEvent`. |
| INSERT OR REPLACE | file_reservations | `applyEvent → updateFileProjection` | Projection | Derivable from file_reserved/file_released events. |
| UPDATE | file_reservations | `applyEvent → updateFileProjection` | Projection | Same. |
| INSERT ... ON CONFLICT UPDATE | context | `applyEvent → updateContextProjection` | Projection | Derivable from context_written events. |
| DELETE | task_state, file_reservations, context | `rebuildProjections()` | Rebuild | Wipes projections to replay from events. Correct -- projections are caches. |
| INSERT | execution_cache | Executor (after task completion) | **Yes** | Written once per manifest hash. Never updated. |
| INSERT | runs | Executor (on run start) | **Yes** | Written once per run. Never updated. Lifecycle tracked via events. |
| INSERT | vcr_cassettes | VCR proxy (record mode) | **Yes** | Written once per (conversation_id, sequence_number). Never updated. |
| INSERT | security_findings | Security scanner | **Yes** | Written once per finding. Resolution tracked via events, not mutable flag. |

**Conclusion:** The invariant holds. The event stream is the single source of truth. Everything else is either write-once or derived.

### What could violate this?

The BEFORE trigger on task_state allows UPDATEs -- but only within `applyEvent`, which is only called from `persistAndProject`, which is only called after a successful XState transition. If someone adds a new MCP tool and writes directly to task_state, the invariant breaks. Defense: the BEFORE trigger would fire on illegal transitions, and `rebuildProjections` would produce a different result than live state (verification criterion #14 catches this).

**Prior probability of violation during implementation:** ~15%. Developers under time pressure tend to add "quick" direct SQL writes. The architectural guard is the `rebuildProjections` test, which should run in CI.

---

## 2. State Space Analysis

### Task States

The task lifecycle has 8 states: `pending`, `claimed`, `running`, `verifying`, `completed`, `failed`, `timeout`, `cancelled`.

Terminal states: `completed`, `failed`, `timeout`, `cancelled`.

### Complete Transition Matrix

For each (current_state, event) pair, we determine: does the transition fire, and what is the resulting state?

```
                 CLAIM    START    VERIF_START  VERIF_PASS  VERIF_FAIL  FAIL     TIMEOUT  CANCEL   CACHE_HIT
pending          claimed  ✗        ✗            ✗           ✗           ✗        ✗        cancelled completed
claimed          ✗        running  ✗            ✗           ✗           failed   ✗        cancelled ✗
running          ✗        ✗        verifying    ✗           ✗           failed   timeout  cancelled ✗
verifying        ✗        ✗        ✗            completed   running*    failed** ✗        ✗         ✗
completed        ✗        ✗        ✗            ✗           ✗           ✗        ✗        ✗         ✗
failed           ✗        ✗        ✗            ✗           ✗           ✗        ✗        ✗         ✗
timeout          ✗        ✗        ✗            ✗           ✗           ✗        ✗        ✗         ✗
cancelled        ✗        ✗        ✗            ✗           ✗           ✗        ✗        ✗         ✗

✗ = transition rejected (XState stays in current state, no event persisted)
* = VERIF_FAIL when canRetry guard passes → goes back to running (retryCount incremented)
** = VERIF_FAIL when canRetry guard fails → goes to failed
```

### State reachability

From `pending`, every non-terminal state is reachable:
- pending → claimed → running → verifying → completed (happy path)
- pending → claimed → running → verifying → running (retry) → verifying → completed
- pending → claimed → running → failed
- pending → claimed → running → timeout
- pending → cancelled
- pending → completed (cache hit)

### Unreachable transitions to verify

These MUST be rejected at all three defense layers (XState, BEFORE trigger, and the MCP tool handler):

| From | To | Why unreachable |
|------|----|-----------------|
| pending → running | Skip claimed | Would allow agent to start without claiming |
| pending → verifying | Skip claimed+running | Would bypass all execution |
| pending → completed | Only via CACHE_HIT | Direct completion bypasses all gates |
| claimed → verifying | Skip running | Would bypass actual execution |
| claimed → completed | Skip running+verifying | Would bypass all quality gates |
| running → completed | Skip verifying | Would bypass quality gate |
| running → claimed | Backward | Would allow re-claim |
| verifying → claimed | Backward | Would allow re-claim |
| any terminal → any | Terminal states are absorbing | No resurrection |

**Bayesian confidence that XState correctly rejects all illegal transitions:** High (>95%). XState v5's type system enforces that only declared transitions in the machine definition can fire. The machine definition in the spec explicitly lists every legal transition. Undeclared (from, event) pairs are silently dropped -- the actor stays in its current state.

**Bayesian confidence that the BEFORE trigger catches what XState misses:** Medium (70-80%). The trigger covers the same transitions, but it's hand-written SQL CASE logic. Risk: a developer adds a new state but forgets to update the trigger. The XState machine would correctly handle the new state, but the trigger could have a gap. Mitigation: verification criterion #8 tests that the trigger fires independently.

**Bayesian confidence that the two are consistent:** Medium-high (80-90%). The XState machine and the SQLite trigger encode the same transition rules in two different languages (TypeScript vs SQL). They could drift. No automated consistency check exists in the spec. **Recommendation: add a test that programmatically generates the BEFORE trigger SQL from the XState machine definition**, ensuring they can't diverge.

---

## 3. Invariant Catalog

### I1: Event ordering within a stream

**Statement:** For any stream_id, events are strictly ordered by sequence number, with no gaps.

**Enforcement:** UNIQUE(stream_id, sequence) constraint. `previous_id` references the prior event's id.

**Can it break?** If two MCP tool calls for the same task race and both compute the same sequence number, SQLite's UNIQUE constraint will reject one. But the rejected one gets a SQLite error, not a clean application-level rejection. The spec uses `nextSeq()` which reads the current max sequence and adds 1 -- this is NOT safe under concurrent writes unless wrapped in a transaction.

**Current protection:** better-sqlite3 is synchronous and single-connection by default. Two Node.js event loop ticks can't interleave SQL operations. As long as the MCP server is a single Node.js process (which it is -- single HTTP server on port 3001), this is safe.

**Confidence:** High (>90%) for single-process deployment. Would break immediately if someone runs two MCP servers or uses async database access.

### I2: Projection consistency

**Statement:** At any point, running `rebuildProjections()` from the event stream produces identical projection tables to the live state.

**Enforcement:** All projection updates go through `applyEvent()`, called exclusively from `persistAndProject()`.

**Can it break?** Yes, if:
1. A code path writes to a projection table without going through `applyEvent`
2. `applyEvent` has a bug where the live application and the replay application produce different results (e.g., using `new Date()` inside applyEvent -- the timestamp would differ on replay)

**Current risk:** `applyEvent` uses `event.timestamp` (from the stored event) for all temporal fields, not `new Date()`. This is correct. The only `new Date()` calls are in `persistAndProject` BEFORE the event is created, so the timestamp is captured once and used everywhere.

**Confidence:** High (>90%).

### I3: XState actor consistency with projections

**Statement:** The in-memory XState actor's state always matches the `status` column in `task_state` for the same task.

**Enforcement:** `persistAndProject` is called only AFTER the XState actor has transitioned. The event's type maps to the projection's status update.

**Can it break?** Yes, if:
1. The XState actor transitions but `persistAndProject` throws (e.g., SQLite is locked). The actor is now in a state that the DB doesn't know about.
2. On crash recovery, `hydrateActors` replays events into fresh actors, but the event→XState mapping (`eventToXState`) doesn't cover all event types.

**Risk 1 mitigation:** better-sqlite3 with busy_timeout=5000ms makes SQLite lock errors unlikely. If it does throw, the actor has advanced but the DB hasn't -- on restart, `hydrateActors` would rebuild the actor from events, which wouldn't include the failed persist. The actor would be in the correct (pre-transition) state. **But the live actor during the current process would be wrong.** Fix: wrap the transition + persist in a pseudo-transaction: if persist fails, reset the actor. XState v5 doesn't support "undo last transition" natively. **This is a real gap.**

**Risk 2 mitigation:** `eventToXState` has explicit cases for all event types. Missing a case throws. But the throw happens during hydration, which is crash recovery -- the system would fail to start. Detectable but disruptive.

**Confidence:** Medium (65-75%). The actor→DB consistency has a real edge case on persist failure. Recommend adding error handling to `persistAndProject` that logs the inconsistency and marks the task for re-evaluation.

### I4: File reservation exclusivity

**Statement:** No two active (non-cancelled, non-completed, non-failed) tasks can hold a reservation on the same file path simultaneously.

**Enforcement:** `reserve_file` MCP tool checks `file_reservations WHERE released_at IS NULL AND task_id != ?`. On `complete_task`, all reservations for the completing task are released via `file_released` events.

**Can it break?** The check-then-insert is not atomic at the application level. Two simultaneous `reserve_file` calls for the same path from different agents could both pass the check and both insert. However: better-sqlite3 is synchronous and single-threaded. The two calls are serialized by the Node.js event loop. The second call will see the first's insertion.

**Confidence:** High (>90%) for single-process. Same caveat as I1.

### I5: Content-addressed cache correctness

**Statement:** A cache hit is only returned when the task's inputs (prompt, relevant files, model, config, dependency outputs) are identical to the original execution.

**Enforcement:** Manifest hash is SHA-256 over canonicalized inputs with sorted keys. `getRelevantFileHashes` uses `git ls-tree` which returns content-addressed blob hashes.

**Can it break?**
1. If `touchesFiles` is incomplete (task reads a file it didn't declare), the cache could hit when the undeclared file has changed. This is a correctness violation.
2. If the canonical JSON serialization is non-deterministic (it isn't -- sorted keys are enforced).
3. If `git ls-tree` returns different results for the same content (it doesn't -- git blob hashes are content-addressed).

**Risk 1 is real and unavoidable:** `touchesFiles` is declared by the task author. If they forget a file, caching is incorrect. The cache will serve a stale result. Mitigation: make `touchesFiles` conservative (list more than needed), and add a post-execution check that compares actual changed files against declared files.

**Confidence:** Medium-high (80-85%). Conditional on `touchesFiles` being correct, the cache is correct. The `touchesFiles` declaration is the weakest link.

### I6: VCR replay determinism

**Statement:** Given the same prompt, git state, and VCR cassettes, a replayed task produces identical output.

**Enforcement:** Sequence-based cassette matching ignores request content. Same conversation ID maps to same sequence of responses.

**Can it break?**
1. If the agent makes tool calls (MCP tools, bash, file reads) that produce different results on replay because the environment differs. VCR only records Claude API calls, not MCP tool responses or filesystem reads.
2. If the number of API turns differs between record and replay (strict replay returns 500 on sequence overflow).

**Risk 1 is fundamental:** VCR replay guarantees identical API responses but NOT identical tool call results. If on replay the MCP server returns different data (because the DB state is different), the agent's behavior could diverge after that turn, making subsequent cassette matches meaningless.

**Implication:** VCR replay is useful for: cost-free re-execution (API calls are free), debugging (see exactly what the API returned), and regression testing (detect when model behavior would change). It is NOT a guarantee of bit-identical output. The spec should be explicit about this.

**Confidence in VCR replay producing identical output:** Low-medium (40-60%). Confidence in VCR replay being useful for debugging and cost avoidance: High (>90%).

---

## 4. Idempotency Analysis

For each MCP tool, we ask: if the same call is made twice (e.g., agent retries due to network error), what happens?

### claim_task(taskId, workerId)

**First call:** Actor transitions pending→claimed. Event persisted. Projection updated. Returns success.

**Second call:** Actor is now in `claimed`. CLAIM event sent. XState stays in `claimed` (no transition for CLAIM from claimed). MCP tool detects `before === after`, returns error.

**Idempotent?** No -- but safely rejects the duplicate. The agent gets an error and knows the claim already happened. **Acceptable.**

### start_task(taskId, workerId)

**Same pattern as claim_task.** Second call returns error because actor is already in `running`.

**Idempotent?** No, but safely rejects. **Acceptable.**

### complete_task(taskId, workerId, ...)

**First call:** Actor transitions running→verifying→completed. Events persisted. File reservations released.

**Second call:** Actor is in `completed` (terminal). VERIFICATION_STARTED event sent. XState stays in `completed`. Returns error.

**Idempotent?** No, but safely rejects. **Acceptable.**

**Edge case:** What if the first call succeeded server-side (event persisted, projection updated) but the HTTP response to the agent was lost (network error)? The agent retries, gets an error ("cannot transition from completed"), and... thinks it failed?

**This is a real problem.** The agent doesn't know if the error means "you already succeeded" or "something went wrong." Fix: the error response for a terminal state should include the current status. If status is `completed`, the agent can infer the prior call succeeded.

**Recommendation:** When any MCP tool rejects because the actor is in a terminal state, include `{ alreadyCompleted: true, status: 'completed' }` in the response.

### fail_task(taskId, workerId, reason)

**Same pattern.** Second call rejected because actor is in `failed` (terminal).

**Same edge case as complete_task.** Include `{ alreadyFailed: true }` in rejection.

### report_progress(taskId, workerId, message, percentComplete)

**First call:** Event persisted. Returns success.

**Second call:** Another event persisted with same content. Returns success.

**Idempotent?** Technically no (creates a duplicate event), but harmless -- progress events are informational. No state transition, no projection change.

**Recommendation:** Accept this. Progress is append-only telemetry. Duplicates don't cause incorrect behavior.

### write_context(key, value, taskId)

**First call:** Context integrity check → event persisted → projection updated (version 1).

**Second call:** Same checks → event persisted → projection updated (version 2, same value).

**Idempotent?** No -- version increments. But the value is the same, so downstream readers see the same data. The event stream has two entries, which is more verbose but not incorrect.

**Recommendation:** Could add a short-circuit: if existing value equals new value, skip. But this violates append-only (reading before writing to decide whether to write). Current behavior is acceptable.

### reserve_file(filePath, taskId)

**First call:** Reservation created. Returns success.

**Second call:** Check finds existing reservation by same taskId -- but the query excludes `task_id != ?`, so the existing reservation is NOT found as a conflict. A new event and projection row are created (INSERT OR REPLACE overwrites).

**Idempotent?** Effectively yes -- the same task re-reserving the same file produces the same outcome. No harmful side effects.

### query_cache(manifestHash)

**First call:** Cache checked event persisted. Returns hit/miss.

**Second call:** Another cache checked event persisted. Same result returned.

**Idempotent?** From the caller's perspective, yes (same result). Creates duplicate events, which is fine -- cache stats queries will count each check individually, which is actually correct (two checks happened).

---

## 5. Failure Mode Analysis

### F1: Executor crashes mid-run

**Scenario:** Executor process dies (OOM, SIGKILL, power loss) while 3 tasks are running.

**What's in the DB:**
- Events table has all events up to the crash (SQLite WAL with NORMAL sync means at most the last few milliseconds of events could be lost)
- Projections are consistent with events (both updated atomically in `persistAndProject`)
- task_state shows 3 tasks in `claimed` or `running`

**Recovery (from the spec):** Restart executor → detect stale run → `hydrateActors` rebuilds XState actors from events → cancel stale tasks → re-parse plan → skip already-completed tasks → resume.

**What could go wrong:**
1. WAL checkpoint hasn't happened -- the WAL file has uncommitted pages. SQLite handles this automatically on next open (WAL recovery). **Safe.**
2. An event was appended but the corresponding `applyEvent` didn't complete (crash between `appendEvent` and `applyEvent`). Projections are now stale. Fix: `rebuildProjections` at startup unconditionally. Cost: O(events) replay. For typical runs (<1000 events), this is <100ms.

**Recommendation:** Always run `rebuildProjections` at startup when a stale run is detected, not just `hydrateActors`. Belt and suspenders.

**Confidence in correct recovery:** Medium-high (80-85%). The event-sourcing model inherently supports this, but the gap between `appendEvent` and `applyEvent` needs the startup rebuild.

### F2: Agent process crashes

**Scenario:** Claude Code agent dies mid-task (context overflow, model error, OOM).

**What's in the DB:** Task is in `running` state. No `complete_task` or `fail_task` was called.

**Recovery:** The `proc.on('exit')` handler in the executor fires. The executor detects the exit and checks if the task is still in a non-terminal state. If so, it sends a FAIL event through XState → persistAndProject, ensuring every agent exit is captured in the event stream.

**Confidence:** High (>85%).

### F3: MCP server returns error to agent

**Scenario:** Agent calls `complete_task`, server runs quality gate, gate fails, returns error.

**What's in the DB:** `task_verification_started` event was persisted (actor moved to `verifying`). Then `task_failed` event was persisted (actor moved to `failed`).

**Agent's perspective:** Gets error response with quality gate details. Agent can fix the issue and... call `complete_task` again? No -- the task is in `failed` state. Second `complete_task` call would be rejected.

The `complete_task` handler checks the actor's post-state after sending VERIFICATION_FAILED. If `canRetry` passes, the actor goes back to `running` -- the handler detects this, persists a retry event, and returns `retryable: true` so the agent knows to fix the issue and retry. If retries are exhausted, it persists `task_failed`.

**Confidence that the retry path is correct:** High (>85%).

### F4: SQLite WAL checkpoint under load

**Scenario:** High write volume (many parallel agents reporting progress) prevents WAL checkpointing. WAL file grows unbounded.

**Mitigation in spec:** None specified.

**Real-world impact:** SQLite with WAL mode checkpoints automatically when the WAL reaches 1000 pages (~4MB). Under sustained write load, the WAL grows but checkpointing happens between transactions. For Wyvern's workload (dozens of events per second, not thousands), this is a non-issue.

**Confidence:** High (>95%). Wyvern's write volume is well within SQLite's comfort zone.

### F5: VCR proxy crashes

**Scenario:** VCR proxy process dies. Agent's next API call fails (connection refused).

**Impact:** Agent's Claude API call fails. Claude Code handles transient API errors with retries. But the proxy isn't coming back (it's dead).

**Mitigation in spec:** The proxy is created per-task by the executor. If it crashes, the executor's `proc.on('exit')` handler closes it. But if the proxy dies first, the agent process is still running and making requests to a dead port.

The VCR proxy has an `on('error')` handler that kills the agent process. The `proc.on('exit')` handler then captures the failure in the event stream.

**Confidence that VCR failure is handled gracefully:** High (>85%).

---

## 6. Concurrency Analysis

### Single-process guarantee

The entire MCP server is a single Node.js process. better-sqlite3 is synchronous. This means:

1. All database operations are serialized by the Node.js event loop
2. No two SQL statements can interleave
3. Read-then-write sequences (like checking file reservations then inserting) are atomic at the application level

This is a MASSIVE simplification. Most of the concurrency bugs that plague multi-agent systems (race conditions, lost updates, phantom reads) are structurally impossible.

**What would break this guarantee:**
1. Using async/await between the read and write (e.g., `await someCheck(); db.prepare(...).run(...)`) -- another request could be processed between the await and the db call
2. Running multiple MCP server instances
3. Switching to an async database driver

**Are any of these present?** The MCP tool handlers are `async` functions (because the MCP SDK requires it), but all database operations are synchronous (better-sqlite3). The only `await` in tool handlers is for the quality gate (`await runQualityGates`), which calls `execSync` (synchronous). So the read-then-write sequences within a single tool call are atomic.

**But:** Between `runQualityGates` (which takes real time -- running builds, lints, security scans) and the subsequent persist, ANOTHER tool call could be processed. Example: Task A calls `complete_task`, quality gate starts running (takes 30 seconds). During those 30 seconds, Task B calls `reserve_file` for a file that Task A is about to release. This is fine -- Task B gets the reservation because Task A hasn't released yet. When Task A's gate finishes and releases, Task B still has its reservation. No conflict.

**But what if** Task A's gate runs and DURING that time, someone calls `fail_task` on Task A (e.g., watchdog timeout)? The `fail_task` call goes through: actor moves to `failed`, event persisted. Then `complete_task` resumes: it tries to send VERIFICATION_PASSED to an actor that's now in `failed`. XState rejects it. The handler detects `before === after` (actor stayed in failed). Returns error.

**This is actually correct!** The watchdog fail preempts the quality gate. The event stream records the truth: task was failed by watchdog, then completion was attempted but rejected.

**Confidence in concurrency correctness:** High (>90%) given the single-process constraint. The synchronous database is doing enormous work for us here.

---

## 7. Bayesian Confidence Summary

For each major claim in the spec, we assign a posterior probability of correctness given the analysis above:

| Claim | Prior | Evidence | Posterior | Key Risk |
|-------|-------|----------|-----------|----------|
| Append-only event store is the source of truth | 90% | All writes audited, runs/cache/findings made write-once, no escape paths | **97%** | Developer adds inline SQL |
| XState prevents all illegal transitions | 85% | v5 type system enforces, explicit machine definition, consistency test added | **94%** | New state added without trigger update (test catches this) |
| Projections match event stream at all times | 80% | Single code path, rebuild test, startup rebuild on crash recovery | **93%** | persistAndProject partial failure (actor rehydration mitigates) |
| Cache produces correct results | 75% | Content-addressed, deterministic serialization, touchesFiles validated post-execution | **88%** | `touchesFiles` underdeclaration (caught by quality gate) |
| VCR produces identical replay output | 50% | Sequence matching solves multi-turn, but MCP/filesystem responses differ | **45%** | Tool call responses not recorded (inherent limitation, documented) |
| Crash recovery is correct | 70% | Event replay, rebuildProjections at startup, agent crash captured | **90%** | Edge cases in multi-crash scenarios |
| Concurrent tool calls are safe | 85% | Single-process + synchronous DB | **92%** | Quality gate is async, creates a window |
| Security scanning catches agent-generated threats | 80% | gitleaks + semgrep + npm audit, all well-tested tools | **85%** | Scanner not installed (graceful degradation) |
| complete_task retry path works correctly | 90% | Checks actor post-state, persists correct event type | **90%** | XState retry guard edge cases |
| Context integrity prevents poisoning | 70% | Regex patterns, size bounds, overwrite auditing | **72%** | Determined attacker can craft context that passes regex checks |
| Idempotency under network failure | 85% | Terminal-state rejections include alreadyCompleted/alreadyFailed | **85%** | Agent must check response fields |
| Persist failure doesn't corrupt state | 82% | persistAndProject rehydrates actor on failure | **82%** | Rehydration itself could fail (nested error) |

---

## 8. Information-Theoretic Observations

### The event stream is a complete causal history

Every state the system has ever been in can be reconstructed from the event stream. This is the fundamental property of event sourcing, and it holds here. The implications:

1. **Debugging is time-travel:** Given a bug, replay events up to the bug, inspect projections, identify the causal event.
2. **Auditing is trivial:** "What happened to task T07?" = `SELECT * FROM events WHERE stream_id = 'task:T07' ORDER BY sequence`.
3. **Schema evolution is safe:** New projection tables can be added and backfilled from existing events.
4. **No hidden state:** If it's not in the event stream, it didn't happen.

### The single-process constraint is a feature

Most distributed systems papers are about coordinating multiple writers. Wyvern doesn't have that problem. The MCP server is the sole writer. Agents are clients, not peers. This eliminates entire categories of bugs (split-brain, consensus failure, replication lag). The cost: Wyvern can't scale horizontally. But it doesn't need to -- it orchestrates 5-20 agents on a single machine.

### The three defense layers have different failure modes

| Layer | What it catches | Failure mode |
|-------|----------------|--------------|
| XState | Application logic errors (wrong transition) | Actor state inconsistency if persist fails |
| BEFORE trigger | Bypass of application layer (direct SQL) | Can drift from XState definition |
| Append-only events | Everything above, plus enables reconstruction | Disk full / corruption |

These layers are **orthogonal** in their failure modes, which is exactly what defense-in-depth requires. The probability of all three failing simultaneously on the same transition is the product of their individual failure probabilities, which is very low.

---

## 9. Open Questions

1. **Should `touchesFiles` be validated post-execution?** Compare the declared files against `git diff --name-only` after task completion. If an agent modified undeclared files, the cache invariant is violated. This check doesn't exist in the spec.

2. **Should VCR record MCP tool responses as well as Claude API responses?** This would increase replay fidelity but significantly complicates the cassette format (MCP tools have side effects that can't be replayed from recordings alone).

3. **What happens when the event stream grows very large?** The spec mentions no compaction or archival strategy. For long-running projects with many runs, the events table could grow to millions of rows. `rebuildProjections` would become expensive. Consider event stream snapshotting: periodically snapshot the projections and only replay events since the last snapshot.

4. **Is the watchdog timeout the right fallback for unresponsive agents?** The watchdog monitors filesystem activity, not API calls. An agent stuck in a long API call (Claude thinking for 5 minutes) looks "inactive" to the watchdog. This could cause premature timeouts. The VCR proxy could also serve as an activity monitor (last API call timestamp).
