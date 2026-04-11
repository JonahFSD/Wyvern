# Wyvern
https://www.youtube.com/watch?v=vc0o1eFAhtQ
> `make` for AI agents.

Edit - this is an attempt at solving a very, very difficult problem that nobody has done yet. I have not tested if it actually works. All of this is theory. 
Wyvern is a TypeScript engine that coordinates multiple AI agents working in parallel on a codebase. You give it a plan -- a structured list of tasks, their dependencies, and what files each one will touch -- and it handles everything else: scheduling, isolation, quality checking, crash recovery, caching, and audit logging.

Right now, if you want multiple AI agents to build something together, you're babysitting terminal windows and praying they don't overwrite each other's files. Wyvern fixes that. Each agent gets its own isolated copy of the repo, a state machine enforces what they're allowed to do and when, an event log captures everything that happens, and a content-addressed cache means re-runs only redo the work that actually changed. The result: you write a plan, run one command, and walk away.

---

## Table of Contents

- [The Problem](#the-problem)
- [What Wyvern Is](#what-wyvern-is)
- [Design Philosophy](#design-philosophy)
- [The Foundational Idea: Event Sourcing](#the-foundational-idea-event-sourcing)
- [The Single Doorway: persistAndProject()](#the-single-doorway-persistandproject)
- [How Agents Communicate with Wyvern](#how-agents-communicate-with-wyvern)
- [The State Machine](#the-state-machine)
- [What Happens When You Run Wyvern](#what-happens-when-you-run-wyvern)
- [The 8 Layers](#the-8-layers)
- [Quickstart](#quickstart)
- [Writing Plans](#writing-plans)
- [Task Decomposition](#task-decomposition)
- [The touchesFiles Contract](#the-touchesfiles-contract)
- [Context Flow Between Tasks](#context-flow-between-tasks)
- [Configuration](#configuration)
- [Profiles](#profiles)
- [The Swarm](#the-swarm)
- [CLI Reference](#cli-reference)
- [Debugging Failed Runs](#debugging-failed-runs)
- [When NOT to Use Wyvern](#when-not-to-use-wyvern)
- [File Layout](#file-layout)
- [Architecture Deep Dive](#architecture-deep-dive)

---

## The Problem

Let's say you have a software project with 14 components to build. A single AI agent working sequentially would take 14 × (time per component). But many of these components are independent -- they don't depend on each other. Components 1 through 8 could all be built simultaneously by different agents, cutting the wall-clock time from hours to minutes.

So you spin up 8 agents. And immediately, you have five problems that didn't exist when there was only one.

**File conflicts.** Agent A is building the database layer. Agent B is building the API layer. Both need to edit `types.ts` to add their type definitions. Agent A writes its version. Agent B writes its version a minute later. Agent B's version overwrites Agent A's work. Agent A's changes are gone. Neither agent knows this happened.

**Dependencies.** Component 12 depends on Components 7, 8, and 9. You can't build 12 until all three are done. But how does Agent 12 know when to start? Do you sit there watching 8 terminal windows, waiting to manually launch the next one? What if Component 8 fails -- does Component 12 wait forever?

**Crash recovery.** AI agents crash. API rate limits get hit. Network connections drop. Processes get killed when memory runs low. When this happens to a human developer, they remember where they left off. When it happens to an AI agent, all its in-memory state is gone. It would have to start over from scratch -- unless something external kept a record of what was already accomplished.

**Observability.** After 8 agents run for 20 minutes and all report "done," how do you know what actually happened? Which agent modified which files? Did any of them introduce security vulnerabilities? How much did the API calls cost? If there's a bug, which agent introduced it, and when?

**Wasted work.** You discover a bug in one component and need to re-run the pipeline. But 12 of 14 components are perfectly fine -- only 2 need to be rebuilt. Without a system that can tell which inputs have changed and which haven't, you re-run all 14, wasting time, compute, and API credits on work that's already been done correctly.

These aren't hypothetical. They're the immediate, practical reality of multi-agent AI development. Wyvern exists to solve all five.

---

## What Wyvern Is

Wyvern is a TypeScript program that coordinates multiple AI agents working in parallel on a codebase. You give it a **plan** -- a structured list of tasks, their dependencies, and what files each one will touch -- and it handles everything else.

The analogy: a **general contractor** building a house. The general contractor doesn't lay bricks or wire outlets -- they decide who works on what, in what order, make sure the electrician doesn't show up before the framer is done, make sure two plumbers don't both try to connect to the same pipe, and keep a record of every decision. If the power goes out at lunch, the general contractor knows exactly where every worker left off.

Wyvern is the general contractor for AI agents.

The `make` analogy is also useful. `make` solved three problems for compilation: dependency-ordered execution, incremental rebuilds (skip what hasn't changed), and reproducibility. Before `make`, you recompiled everything and prayed. After `make`, builds were correct, fast, and debuggable.

That's the same gap between "Claude Code can do things" and "Claude Code reliably ships production software." The DAG is the Makefile. The MCP server is the build runtime. The event store is the build log. Content-addressed caching is `make`'s timestamp comparison (but content-based, so it's actually correct). Deterministic replay is what `make` never had -- the ability to reproduce any historical build exactly, API responses and all.

The core architectural move: **agents don't touch state directly. They declare intentions through a typed API, and the orchestrator decides whether to accept them.** This inverts the typical control model (agents modify files, orchestrator polls and infers) into an explicit, enforceable, recordable system.

---

## Design Philosophy

Three principles shape every design decision in Wyvern.

### Principle 1: Trust nothing

AI agents are powerful but unreliable. They hallucinate. They make mistakes. They silently overwrite each other's work. They claim to be done when they aren't. They introduce security vulnerabilities without noticing.

Wyvern's response: **verify everything, trust nothing**. When an agent says "I'm done," Wyvern doesn't take its word for it -- it runs a battery of automated checks. When an agent says "I only edited the files I was supposed to," Wyvern independently verifies that by diffing the actual file system. When an agent passes data to a future agent, Wyvern scans that data for hidden instructions (prompt injection). The system is designed for a world where every participant might be wrong, confused, or compromised.

This extends to Wyvern's own code. The state machine enforces valid transitions, but the database *independently* enforces the same rules via SQL triggers. If one layer has a bug, the other layer catches the violation. This is **defense in depth** -- multiple independent enforcement mechanisms, so no single point of failure can corrupt the system.

### Principle 2: Record everything, delete nothing

The most common failure mode in software systems is losing information. A status field gets overwritten. A log gets rotated away. A checkpoint file gets corrupted. After a crash, you're left guessing what happened.

Wyvern's response: **append-only event sourcing**. Every state change is recorded as a new entry in an immutable log. Nothing is ever updated or deleted. If you want to know what happened -- last run, last month, ever -- it's all there. If the system crashes, it restarts by replaying the log. No guessing. No reconstruction. No data loss.

This isn't just a logging strategy. It's the fundamental architectural decision that everything else is built on.

### Principle 3: Make the right thing automatic and the wrong thing impossible

Many systems rely on developers following conventions: "remember to check dependencies before starting a task," "don't forget to log the result," "make sure you don't edit files someone else is working on." These conventions break under pressure, under complexity, and especially when the "developers" are AI agents that don't read conventions documents.

Wyvern's response: **enforce constraints in code, not in documentation**. The state machine physically prevents illegal transitions. The database physically prevents event mutation. The filesystem sandbox physically prevents agents from accessing files outside their workspace. The pre-flight guards physically prevent a task from starting if its dependencies aren't met. There is no code path that allows the wrong thing. It's not a matter of discipline -- it's a matter of architecture.

---

## The Foundational Idea: Event Sourcing

This is the single most important concept in Wyvern. If you understand this, the rest of the system will make sense. If you don't, nothing else will click.

**Every state change is recorded as an append to an immutable log.**

**"Every state change"** -- not just "task completed." Every transition: task created, task claimed by an agent, agent started working, file reserved, progress reported, quality check failed, security vulnerability found, task completed, task failed. All of it.

**"Recorded as an append"** -- written to the end of a list. Not "the status field gets updated." A new entry gets added to the end. The old entries are never touched.

**"Immutable log"** -- once an entry is written, it can never be modified or deleted. Not by the application, not by a bug, not by an administrator. This is enforced at the database level with SQL triggers -- rules wired into the database itself that automatically run when someone tries to modify or delete data. Even if the application code had a bug that tried to modify an event, the database would reject it.

### The bank ledger analogy

Think about how a bank works. Your bank doesn't store "your balance is $1,247.52" and update that number every time money moves. Instead, it stores a ledger -- a list of every transaction that ever happened:

```
+$3,000.00  Payroll deposit     Jan 15
-$1,200.00  Rent payment        Jan 16
-$47.23     Grocery store       Jan 17
-$505.25    Utilities           Jan 18
```

Your "balance" isn't stored anywhere. It's *computed* by adding up all the transactions. If the bank's computer crashes, they don't lose your money -- they recompute the balance from the ledger.

This is exactly how Wyvern works. The event log is the ledger. The "current status" of each task is computed from the events -- not stored directly. What that buys you:

**Crash recovery is free.** If Wyvern's process dies -- power outage, OS kill, unhandled exception -- it restarts, replays the event log, and reconstructs exactly where everything was. No "what state was I in?" problem. No corrupted checkpoints. No manual intervention.

**Debugging is trivial.** Something went wrong? Read the event log. Every decision, every transition, every failure is there, in chronological order, with timestamps and actors. The difference between having security camera footage and trying to piece together what happened from memory.

**You can never lose information.** Events are append-only. There is no operation in the entire system that removes information. The worst that can happen is you add a "correction" event -- but the original event is still there for the record.

**Auditability is automatic.** Want to know exactly what happened during a run three weeks ago? It's all there. Every event, every agent, every quality check result, every security finding. You never have to implement "audit logging" as a feature -- it's the foundation everything runs on.

The pattern is called **event sourcing**. It's the same idea behind Git (which is a log of commits, not a database of file states), bank ledgers, and distributed systems at companies like LinkedIn and Netflix.

**The mantra: events are the truth. Everything else is a projection.**

A **projection** is a view computed from events. Your bank balance is a projection of your transaction history. The current status of each Wyvern task is a projection of the event stream. Projections exist for convenience -- you don't want to replay 10,000 events every time you check a task's status. But they're always rebuildable from scratch. If a projection ever gets corrupted or out of sync, one function (`rebuildProjections()`) wipes all projections and replays every event to regenerate them. The events are the source of truth. The projections are just a cache.

---

## The Single Doorway: `persistAndProject()`

In many software systems, state gets updated from lots of different places. Function A writes to the database here. Function B updates a cache there. Function C logs something over there. Over time, these paths drift apart -- the database says one thing, the cache says another, the log is missing entries.

Wyvern has exactly **one function** that changes system state. It's called `persistAndProject()`. Every tool call, every state transition, every event in the entire system flows through this single function. It does three things, always in this order:

1. **Append the event** to the immutable events table
2. **Update projections** by applying the event to the relevant queryable tables
3. **Emit a signal** (`stateChanged`) so the executor knows something happened

If step 1 fails, steps 2 and 3 don't run -- so projections and events can never disagree. If the process crashes between step 1 and step 2, the projections will be stale on restart -- but `rebuildProjections()` replays all events and brings them back in sync. The event is always written first, so you can always recover.

This means **you only have to trust one code path**. If `persistAndProject()` is correct, the entire system's state management is correct. If you're debugging a state inconsistency, there's exactly one place to look.

---

## How Agents Communicate with Wyvern

Agents don't read or write Wyvern's database directly. They talk to it through an API using **MCP** (Model Context Protocol) -- a standard created by Anthropic for giving AI agents access to tools.

Wyvern runs a local HTTP server on your machine (not in the cloud -- everything stays on your laptop). Each agent gets access to 9 tools:

| Tool | What the agent is saying | When they call it |
|------|--------------------------|-------------------|
| `claim_task` | "I'm taking this task" | At startup |
| `start_task` | "I've set up and I'm beginning work" | After initialization |
| `complete_task` | "I'm done -- please check my work" | After finishing |
| `fail_task` | "I couldn't do it, here's why" | On failure |
| `report_progress` | "Here's a status update" | Periodically |
| `read_context` | "What did previous tasks discover?" | When needing info from dependencies |
| `write_context` | "Future tasks should know this" | When discovering something useful |
| `reserve_file` | "I need exclusive access to this file" | Before editing shared files |
| `query_cache` | "Has this exact task been done before?" | Optimization check |

Every single one of these calls flows through `persistAndProject()`. When an agent calls `claim_task`, that produces a `task_claimed` event. When it calls `write_context`, that produces a `context_written` event. The event is the record. The tool call is just the trigger.

### What happens when an agent says "I'm done"

When an agent calls `complete_task`, Wyvern doesn't just trust it. It runs a series of **quality gates** -- automated checks that must all pass before the task is accepted:

1. **Does the code compile?** Runs the configured verification commands (like `tsc --noEmit` for TypeScript or `python -m py_compile` for Python).
2. **Did the agent only touch files it was supposed to?** Compares the actual file changes (via `git diff`) against the files the task declared it would touch. If an agent edited something it wasn't supposed to, the gate fails.
3. **Are there hardcoded secrets?** Runs gitleaks to scan for API keys, passwords, and tokens accidentally left in code.
4. **Are there security vulnerabilities?** Runs semgrep with OWASP rulesets -- static analysis that reads code without running it, looking for patterns known to cause security problems.
5. **Are there vulnerable dependencies?** Runs `npm audit` / `pip-audit` to check whether third-party packages have known security issues.

If any gate fails and the task has retries remaining, the agent gets sent back to fix the problem -- with the specific failure details included so it knows what to fix. If retries are exhausted, the task is permanently marked as failed. Either way, every result -- pass or fail, every finding -- is recorded as an event.

---

## The State Machine

What prevents a task from going directly from "not started" to "completed" without anyone doing the work? What prevents two agents from both claiming the same task? What prevents a failed task from magically becoming completed?

A **state machine**. Every Wyvern task has exactly 8 possible states:

```
pending → claimed → running → verifying → completed
                                        ↘ failed (retry → running)
                            ↘ failed
                            ↘ timeout
                            ↘ cancelled
```

These transitions are implemented using **XState v5**, a library that turns state machine definitions into running code. The state machine isn't a diagram that developers try to follow -- it's code that *enforces* the rules at runtime. If an agent tries to call `complete_task` on a task that's still in `pending` state, the state machine rejects it. There is no code path that bypasses this check. The invalid transition simply cannot happen.

And in keeping with Principle 1, there's a *second* layer of enforcement: a SQL trigger in the database that independently validates every transition. The state machine (running in application memory) and the database trigger (running inside SQLite) both check the transition. Both must agree. If one has a bug, the other catches it.

Four states are **terminal**: `completed`, `failed`, `timeout`, `cancelled`. Once a task enters one of these, it can never leave. There is no "un-fail." There is no "un-complete." History is permanent.

### Pre-flight guards

Three database-backed checks run *before* a task can be claimed:

- **dependenciesMet**: are all the tasks this one depends on completed?
- **withinBudget**: has the total API spend exceeded the configured limit?
- **filesAvailable**: are the files this task needs currently free (not locked by another task)?

If any guard fails, the claim is rejected with a specific reason ("Task T07 is not yet completed," "Budget limit of $50 reached," "File executor.ts is locked by task T03"). The agent knows exactly why it can't proceed.

---

## What Happens When You Run Wyvern

The full lifecycle, from command to completion.

**You type `npx tsx cli.ts run plan.json`.** The plan file describes every task: its ID, description, model, files it touches, and dependencies.

**Wyvern reads the plan and builds a dependency graph.** Tasks with no dependencies are immediately eligible. Tasks with unmet dependencies wait.

**For each eligible task, Wyvern checks the cache.** It computes a fingerprint of the task's inputs: the prompt, the content hashes of the files the task will touch, the model, the config, and the outputs of its dependency tasks. If a previous run produced the same fingerprint, the task is served from cache. No agent is spawned.

**For tasks that aren't cached, Wyvern creates an isolated workspace.** Each agent gets its own git worktree -- a lightweight, independent copy of the entire repository. Agent A and Agent B can both edit files without interfering with each other.

**Wyvern spawns a Claude Code agent** in the worktree, connected to Wyvern's MCP server. The agent receives its prompt and begins working.

**The agent works autonomously**, calling MCP tools as it goes. Every call produces an event. Every event updates the projections. The executor watches for state changes.

**When the agent calls `complete_task`, quality gates run.** If something fails and retries remain, the agent is told what went wrong and tries again.

**When a task completes, the executor immediately fires.** It checks: did this completion unblock any downstream tasks? The latency from "Task A completes" to "dependent Task B starts" is under 100 milliseconds.

**If an agent crashes**, the event log records every state change up to the crash. On restart, Wyvern replays the log, rebuilds the state, identifies stale tasks, and can re-launch them.

**When all tasks are complete**, Wyvern reports the final status. Every event, every quality gate result, every security finding, every cost -- all queryable from the CLI.

---

## The 8 Layers

Wyvern is built bottom-up in 8 layers. Each layer provides guarantees that the layers above depend on.

### Layer 0: The Event Store -- "What happened?"

A SQLite database with one sacred table: `events`. Every state change begins as an INSERT into this table. SQL triggers physically prevent any UPDATE or DELETE.

Why SQLite? Because Wyvern runs on your laptop. SQLite is embedded (no separate database server), fast for single-process writes (no network round-trips), and supports concurrent reads through WAL mode. For a single-machine orchestrator, SQLite is simpler, faster, and more reliable than any client-server database.

On top of the events table sit projection tables: `task_state`, `file_reservations`, `context`, `security_findings`, `execution_cache`. These are the "bank balance" to the event log's "transaction history." If they ever get corrupted, `rebuildProjections()` wipes and regenerates them from the event stream.

**Where it lives:** `engine/store/`

### Layer 1: State Machines -- "What's allowed?"

XState v5 actors that govern task and run lifecycles. When a task is created, an actor is spawned in memory. Events are sent to it. It transitions (if legal) or rejects (if not). Actors are rebuilt from the event stream on restart.

This layer also contains the pre-flight guards: `dependenciesMet`, `withinBudget`, `filesAvailable`.

**Where it lives:** `engine/machines/`

### Layer 2: The MCP Server -- "How do agents talk to us?"

A local HTTP server that speaks the MCP standard. Each of the 9 tools follows the same pattern: validate input (Zod), run pre-flight guards, send event to XState actor, call `persistAndProject()` if accepted, return structured error if rejected.

This is where the quality gate lives: the server-side verification that runs when an agent calls `complete_task`.

**Where it lives:** `engine/mcp/`

### Layer 3: Content-Addressed Cache -- "Has this been done before?"

Before spawning an agent, Wyvern computes a manifest hash -- a fingerprint of the task's inputs. The manifest includes: the prompt text, content hashes of the files the task will touch (via `git ls-tree`), the model, config values, and output hashes of dependency tasks.

If a previous run produced the same manifest hash, the task is served from cache. Same idea as `make`, but using content hashes instead of timestamps -- so it can't be fooled by touching a file without changing it.

**Where it lives:** `engine/cache/`

### Layer 4: VCR Recording/Replay -- "Can we replay this exactly?"

Every API call an agent makes gets routed through a local HTTP proxy. In `record` mode, each request/response pair is saved with a sequence number. In `replay` mode, the proxy serves recorded responses in order.

Why sequence numbers instead of content matching? In a multi-turn AI conversation, each request contains the conversation history. If anything changes slightly, content-based matching cascades into total failure. Sequence-based matching avoids this.

**Where it lives:** `engine/vcr/`

### Layer 5: Filesystem Isolation -- "How do we prevent agents from interfering?"

Each agent gets its own git worktree. On task completion, the worktree is merged back via `git merge --no-ff` (preserving which commits came from which task).

On macOS, agents also run inside a `sandbox-exec` profile that restricts filesystem access at the OS kernel level. An agent literally cannot read or write files outside its workspace.

**Where it lives:** `engine/isolation/`

### Layer 6: The Executor -- "Who runs when?"

The orchestration brain. Event-driven (not polling) -- `persistAndProject()` emits a `stateChanged` signal whenever anything happens. The executor responds immediately: "A task just completed. Are any downstream tasks now unblocked? Spawn them."

On startup: parse plan, initialize SQLite, rebuild projections (crash recovery), rehydrate XState actors, cancel stale tasks, start the MCP server.

**Where it lives:** `engine/executor.ts`

### Layer 7: Observability -- "What's happening?"

CLI commands that query the event store and projections. Because of event sourcing, these aren't special features -- they're just different queries over the event log. The observability layer is almost trivially simple because Layer 0 already captured everything.

**Where it lives:** `cli.ts`

### Layer 8: Security -- "Is any of this dangerous?"

Four scanning subsystems integrated into the quality gate: secret scanning (gitleaks), static analysis (semgrep + OWASP), dependency audit (npm/pip audit), and context integrity (prompt injection detection on `write_context`).

Every finding is persisted as an individual event. You can query the full security audit trail for any task, any run, ever.

**Where it lives:** `engine/security/`

---

## Quickstart

### Requirements

- **Node.js 18+** (for native `fetch`, `crypto.randomUUID`)
- **TypeScript** (run via `npx tsx`)
- **macOS** (for `sandbox-exec` -- Linux support planned)
- **Git** (for worktrees)
- **Claude Code CLI** (for spawning agents)
- Optional: `gitleaks` or `betterleaks` (secret scanning), `semgrep` (SAST)

### Install

```bash
npm install
```

### Initialize in your project

```bash
# In your project's root directory:
npx tsx /path/to/wyvern/cli.ts init web-app
# or
npx tsx /path/to/wyvern/cli.ts init research-pipeline
```

This creates a `wyvern.config.json` in your project root.

### Create a plan

A plan is a JSON file describing every task, its dependencies, and what it touches:

```json
{
  "tasks": [
    {
      "id": "T01",
      "description": "Create the database schema module",
      "model": "sonnet",
      "touchesFiles": ["src/db/schema.ts", "src/db/connection.ts"],
      "dependsOn": [],
      "prompt": "Create the database module. Use SQLite with WAL mode...",
      "retries": 2
    },
    {
      "id": "T02",
      "description": "Create the API route handlers",
      "model": "sonnet",
      "touchesFiles": ["src/routes/api.ts"],
      "dependsOn": ["T01"],
      "prompt": "Create REST API handlers. T01 created the DB schema...",
      "retries": 2
    }
  ]
}
```

Required fields per task: `id`, `description`, `model`, `touchesFiles`, `dependsOn`, `prompt`. Optional: `retries` (default 2).

### Run it

```bash
npx tsx /path/to/wyvern/cli.ts run plan.json
```

### Watch and inspect

```bash
npx tsx cli.ts status          # Current state of every task
npx tsx cli.ts events          # Full event stream
npx tsx cli.ts replay T07      # Events for a specific task
npx tsx cli.ts cache-stats     # Cache hit rate
npx tsx cli.ts context         # Inter-agent context
npx tsx cli.ts history         # Past runs
npx tsx cli.ts costs           # API spend
```

---

## Writing Plans

This is the most important skill for using Wyvern well. A plan is a JSON file that describes the task DAG. For a real example, see [`examples/SELF-BUILD-PLAN.md`](examples/SELF-BUILD-PLAN.md).

### Plan structure

```json
{
  "tasks": [
    {
      "id": "T01",
      "description": "What this task does (one sentence)",
      "model": "sonnet",
      "touchesFiles": ["path/to/file1.ts", "path/to/file2.ts"],
      "dependsOn": [],
      "prompt": "Complete instructions for the agent...",
      "retries": 2
    }
  ]
}
```

### Acceptance criteria

Every task should include acceptance criteria in its prompt -- a way to verify the task worked. Without it, the quality gate can only check that the code compiles and has no security issues. With it, you can verify behavior:

```
Acceptance: npx tsx -e "import { authenticate } from './src/auth.js'; console.log(typeof authenticate)"
```

---

## Task Decomposition

The principles that make the difference between a plan that works and a plan that fails:

**One logical unit per task.** A task should do one coherent thing: "create the database schema," "implement the MCP tool handlers," "write the executor main loop." If you can't describe a task in one sentence, it's probably too broad. If you need to describe what order things happen *within* a task, it's definitely too broad.

**1–3 files per task.** A task that touches 1 file is clean. 2–3 files is fine if they're tightly coupled (a module and its types file). A task that touches 6+ files is almost always too broad -- split it. The `touchesFiles` declaration is a contract: the quality gate will fail the task if the agent edits files outside this list.

**Tasks that can run in parallel must not share files.** If T01 and T02 both need to edit `types.ts`, they cannot be parallel -- one must depend on the other. Alternatively, split the shared concern into its own task (T00 creates `types.ts`, both T01 and T02 depend on T00). This is the most common decomposition mistake.

**Dependencies should form a DAG, not a chain.** If every task depends on the previous one (T01 → T02 → T03 → T04...), you've built a sequential pipeline and Wyvern can't parallelize anything. The ideal shape is wide at the bottom (many independent foundation tasks) narrowing toward the top (integration tasks that bring pieces together):

```
T01 ──┐
T02 ──┼──→ T07 ──→ T08 ──┐
T03 ──┘                    ├──→ T12 ──→ T13 ──→ T14
T04 ──┐                    │
T05 ──┼──→ T09 ────────────┘
T06 ──┘
```

**Prompts should be self-contained.** Each agent only sees its own prompt plus context from `read_context`. It does NOT see other tasks' prompts. Include everything the agent needs: which spec sections to reference, which files to read for patterns, what the acceptance criteria are. The agent should be able to complete its task without asking questions.

---

## The touchesFiles Contract

`touchesFiles` is both a cache key input and a safety boundary:

- **Cache**: Only these files' content hashes go into the manifest hash. If T01 touches `schema.ts` and T02 touches `executor.ts`, changing `executor.ts` doesn't invalidate T01's cache.
- **Quality gate**: After the agent says "done," Wyvern runs `git diff` and checks which files actually changed. If the agent edited a file not in `touchesFiles`, the gate fails.
- **File reservation**: When a task is claimed, its `touchesFiles` are locked. Other tasks cannot claim those files until this task completes or fails.

When declaring `touchesFiles`, list every file the agent will create or modify. It's better to over-declare than under-declare -- an unused declaration is harmless, but a missing one causes a quality gate failure.

---

## Context Flow Between Tasks

Agents communicate across tasks using `write_context` and `read_context`. These are key-value pairs stored in the event log.

**What to write as context:**

- Interface contracts: "The auth module exports `authenticate(token: string): Promise<User>`"
- Decisions: "Used JWT instead of session tokens because the spec requires stateless auth"
- Discovery: "The existing codebase uses snake_case for database columns"
- Warnings: "The `users` table has a unique constraint on email -- downstream tasks must handle conflicts"

**What NOT to write as context:**

- Entire file contents (the downstream agent can read files directly)
- Debugging logs or internal reasoning
- Anything the prompt already says

Context is scanned for prompt injection (Layer 8 security). If an agent writes something that looks like hidden instructions to a downstream agent, the write is rejected and a security event is emitted.

---

## Configuration

Wyvern reads `wyvern.config.json` from your project root.

```json
{
  "profile": "web-app",
  "pollInterval": 5,
  "killDelay": 3,
  "watchdogTimeout": 900,
  "defaultModel": "sonnet",
  "verifyCommands": ["npx tsc --noEmit", "npm test -- --passWithNoTests"],
  "enableSnapshots": true,
  "enableCostTracking": true,
  "enableOutputCapture": true,
  "parallelTasksPerGate": 4,
  "modelConfig": {
    "opus": { "maxPromptLines": { "min": 8, "max": 80 } },
    "sonnet": { "maxPromptLines": { "min": 8, "max": 120 } },
    "haiku": { "maxPromptLines": { "min": 4, "max": 60 } }
  }
}
```

Key fields:

- **profile**: Which project-type adapter to use (`web-app` or `research-pipeline`).
- **watchdogTimeout**: Seconds before a running task is killed for taking too long.
- **parallelTasksPerGate**: Max concurrent agents. Lower for memory-hungry tasks, higher for lightweight ones.
- **verifyCommands**: Run after each task completes. `${file}` interpolates to the task's touched files.
- **defaultModel**: Which Claude model agents use. Override per-task in the plan.
- **budgetLimitUsd**: Optional hard cap on total API spend per run.

See [`examples/wyvern.config.json`](examples/wyvern.config.json) for a complete example.

---

## Profiles

Profiles make Wyvern project-agnostic. A profile answers four questions:

1. **How do I verify a task succeeded?** (default verify commands)
2. **How do I generate context for workers?** (the "pin" -- a codebase index injected into prompts)
3. **What additional lint rules apply?** (project-specific checks)
4. **What are the default config values?** (timeouts, concurrency, model)

Two built-in profiles ship with Wyvern:

- **`web-app`**: React/Next.js/FastAPI projects. Verifies with `tsc --noEmit` + `npm test`. Scans for routes, exports, and components.
- **`research-pipeline`**: Python/ML projects. Verifies with `python -m py_compile` + script execution. Scans for Python modules, data sources, and artifact directories.

To create a new profile: implement the `WyvernProfile` interface from `profiles/profile.ts` and add a case to `loadProfile()`.

---

## The Swarm

The swarm layer (`swarm/`) sits on top of the core engine and adds multi-domain coordination -- parsing structured spec files, identifying domains, generating task DAGs with cost estimates, and producing launch scripts for Agent Teams (Claude's parallel agent feature).

```bash
wyvern swarm plan docs/spec.md       # Parse spec, show plan + cost estimate
wyvern swarm validate docs/spec.md   # Validate dependency graph
wyvern swarm run docs/spec.md        # Generate launch script
wyvern swarm cost docs/spec.md       # Detailed cost breakdown
```

The swarm is a deterministic parser -- it doesn't call Claude or any LLM. The intelligence lives in the spec format and the conventions docs (`swarm/conventions/`), not in the code.

---

## CLI Reference

```bash
# Core operations
wyvern run <plan.json> [options]    # Execute a plan
wyvern lint <task-dir>              # Lint prompts
wyvern new <task-name> <n>          # Scaffold a new task with N prompts
wyvern audit <task-dir> [type]      # Standalone audit (diff|tech-debt|security)
wyvern maintain                     # Run the maintenance agent
wyvern pin                          # Regenerate the codebase index
wyvern init <profile>               # Initialize for a project

# Inspection
wyvern status                       # Current task states
wyvern history                      # Past runs
wyvern events [--stream X]          # Raw event log
wyvern replay <taskId>              # Events for a specific task
wyvern context                      # Context key-value pairs
wyvern cache-stats                  # Cache statistics
wyvern costs [--summary]            # Cost tracking data
wyvern trend                        # Audit trend

# Swarm
wyvern swarm plan <spec>            # Parse spec, show plan
wyvern swarm validate <spec>        # Validate dependency graph
wyvern swarm run <spec> [--dry-run] # Generate launch script
wyvern swarm cost <spec>            # Detailed cost breakdown

# Run options
--dry-run         Show plan without executing
--skip-lint       Skip prompt linting
--skip-audit      Skip post-execution audit
--skip-snapshots  Skip git checkpoints
```

---

## Debugging Failed Runs

```bash
# 1. See what state everything is in
wyvern status

# 2. Find the failed task's events
wyvern replay T07

# 3. Read the full event stream to see ordering
wyvern events

# 4. Check cache stats (was this a re-run or fresh?)
wyvern cache-stats

# 5. Check inter-agent context
wyvern context
```

**Common failure patterns:**

- **Quality gate: file ownership** -- Agent edited a file not in `touchesFiles`. Fix: add the file to the plan's `touchesFiles` list, or restructure so the task doesn't need that file.
- **Quality gate: compilation** -- Agent's code doesn't compile. If retries remain, the agent gets the error and tries again automatically.
- **Quality gate: secrets detected** -- Agent hardcoded an API key or token. Never put secrets in code.
- **Dependency deadlock** -- Two tasks each depend on the other. The DAG validator catches this at plan load time.
- **Budget exceeded** -- Total API spend hit the limit. Check `budgetLimitUsd` in config.
- **Timeout** -- Task ran longer than `watchdogTimeout`. Increase the timeout or split the task.

---

## When NOT to Use Wyvern

Wyvern is for parallel multi-task builds. Don't use it for:

- **Single-file changes** -- just edit the file directly.
- **Exploratory work** where you don't know the task structure yet -- use a single Claude session to explore, then decompose once you understand the shape.
- **Bug fixes that touch one module** -- overkill. Fix it directly.

Use Wyvern when: you have 3+ independent tasks, the work naturally decomposes into phases with clear dependencies, or you need the audit trail and quality gates.

---

## File Layout

```
wyvern/
├── cli.ts                          # CLI entry point (Layer 7)
├── engine/
│   ├── store/                      # Layer 0: Event store
│   │   ├── db.ts                   #   SQLite connection (WAL mode, pragmas)
│   │   ├── schema.ts               #   Table DDL + immutability triggers
│   │   ├── events.ts               #   appendEvent, replayStream, replayAll
│   │   └── projections.ts          #   applyEvent, rebuildProjections
│   ├── machines/                   # Layer 1: State machines
│   │   ├── task.ts                 #   8-state task lifecycle (XState v5)
│   │   ├── orchestrator.ts         #   Run lifecycle machine
│   │   ├── registry.ts             #   Actor registry: create, lookup, rehydrate
│   │   └── guards.ts               #   dependenciesMet, withinBudget, filesAvailable
│   ├── mcp/                        # Layer 2: MCP server
│   │   ├── server.ts               #   Streamable HTTP server
│   │   ├── tools.ts                #   9 tool handlers + persistAndProject
│   │   ├── quality-gate.ts         #   Verification, file ownership, security
│   │   └── types.ts                #   Zod schemas for tool inputs
│   ├── cache/                      # Layer 3: Execution cache
│   │   ├── manifest.ts             #   Content-addressed hashing
│   │   └── store.ts                #   Cache lookup and write
│   ├── vcr/                        # Layer 4: API recording/replay
│   │   ├── proxy.ts                #   HTTP intercept proxy
│   │   └── cassette.ts             #   Cassette storage
│   ├── isolation/                  # Layer 5: Filesystem isolation
│   │   ├── worktree.ts             #   Git worktree create/merge/cleanup
│   │   └── sandbox.ts              #   macOS sandbox-exec profiles
│   ├── security/                   # Layer 8: Security scanning
│   │   ├── scanner.ts              #   Orchestrator (runs all scans)
│   │   ├── secrets.ts              #   gitleaks integration
│   │   ├── sast.ts                 #   semgrep + OWASP rulesets
│   │   ├── dependencies.ts         #   npm audit / pip-audit
│   │   ├── context-integrity.ts    #   Prompt injection detection
│   │   └── types.ts                #   SecurityFinding, ScanResult interfaces
│   ├── executor.ts                 # Layer 6: Event-driven executor
│   ├── config.ts                   # Config loader
│   ├── logger.ts                   # Structured JSON logging
│   ├── watchdog.ts                 # Task timeout enforcement
│   ├── prompt-builder.ts           # Agent prompt construction
│   └── types.ts                    # Shared TypeScript types
├── profiles/                       # Project-type adapters
│   ├── profile.ts                  #   WyvernProfile interface + loadProfile
│   ├── web-app.ts                  #   React/Next.js/FastAPI
│   ├── research-pipeline.ts        #   Python/ML/research
│   └── pin-generator.ts            #   Codebase index generator
├── swarm/                          # Multi-domain coordination
│   ├── wyvern.ts                   #   Spec parser → SwarmPlan
│   ├── cli.ts                      #   Swarm CLI commands
│   ├── types.ts                    #   SwarmPlan, SwarmTask, Domain
│   ├── dependency-graph.ts         #   DAG validation + critical path
│   ├── agent-teams-adapter.ts      #   Agent Teams launch script generator
│   ├── hooks/                      #   Task lifecycle hooks
│   └── conventions/                #   Domain and swarm convention docs
├── docs/
│   ├── SPEC.md                     #   Complete executable spec (2,947 lines)
│   └── ANALYSIS.md                 #   Formal analysis: invariants, failure modes
├── examples/
│   ├── SELF-BUILD-PLAN.md          #   The 14-task plan that built Wyvern
│   └── wyvern.config.json          #   Example configuration
├── package.json
└── tsconfig.json
```

---

## Architecture Deep Dive

For a complete understanding of the internals:

- **[`docs/SPEC.md`](docs/SPEC.md)** -- The complete executable specification. 2,947 lines. Every TypeScript code block is the actual implementation. This is the authoritative source for how every piece works.
- **[`docs/ANALYSIS.md`](docs/ANALYSIS.md)** -- Formal analysis from first principles. State space enumeration, invariant proofs, failure mode analysis, transition matrix, Bayesian confidence ratings.
- **[`examples/SELF-BUILD-PLAN.md`](examples/SELF-BUILD-PLAN.md)** -- A 14-task parallel build plan. Serves as a concrete example of what a real Wyvern plan looks like.

### Key concepts cheatsheet

| Concept | One-liner | Where |
|---------|-----------|-------|
| persistAndProject | The single doorway all state changes pass through | `mcp/tools.ts` |
| Event sourcing | Append-only log is truth; everything else is derived | `store/events.ts` |
| Projections | Queryable views computed from events, rebuildable on crash | `store/projections.ts` |
| Task state machine | 8 states, enforced transitions, terminal states are absorbing | `machines/task.ts` |
| Defense in depth | XState rejects bad transitions AND SQL triggers reject bad writes | `machines/` + `store/schema.ts` |
| Pre-flight guards | DB-backed checks before XState sees the event | `machines/guards.ts` |
| Manifest hash | Content-addressed task fingerprint (prompt + file hashes + deps) | `cache/manifest.ts` |
| VCR replay | Sequence-keyed API recording for deterministic re-execution | `vcr/proxy.ts` |
| Git worktrees | Each agent gets an independent repo copy | `isolation/worktree.ts` |
| sandbox-exec | macOS kernel-level filesystem restriction per agent | `isolation/sandbox.ts` |
| stateChanged | EventEmitter signal that drives the executor (no polling) | `executor.ts` |
| Quality gate | Server-side verification before accepting task completion | `mcp/quality-gate.ts` |

---

## License

MIT
