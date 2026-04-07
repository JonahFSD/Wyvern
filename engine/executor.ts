import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type Database from 'better-sqlite3';
import { openDatabase } from './store/db.js';
import { initializeSchema } from './store/schema.js';
import { appendEvent } from './store/events.js';
import { rebuildProjections } from './store/projections.js';
import { getOrCreateTaskActor, getTaskActor, hydrateActors } from './machines/registry.js';
import { createMcpServer, startHttpServer } from './mcp/server.js';
import { persistAndProject, nextSeq, stateChanged } from './mcp/tools.js';
import { computeManifestHash, getRelevantFileHashes, computeConfigHash } from './cache/manifest.js';
import { lookupCache, writeCache } from './cache/store.js';
import { createVcrProxy } from './vcr/proxy.js';
import { createWorktree, removeWorktree } from './isolation/worktree.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createWatchdog } from './watchdog.js';
import type { WyvernConfig, ExecuteOptions } from './types.js';

export async function executeLoop(
  planSource: string,
  options: ExecuteOptions = {},
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
  const mcpPort = (config as unknown as Record<string, unknown>).mcpPort as number || 3001;
  const httpServer = await startHttpServer(mcpServer, mcpPort);
  logger.info('mcp-server-started', { port: mcpPort });

  // 3. Check for crash recovery
  const lastRun = db.prepare(
    "SELECT * FROM runs ORDER BY id DESC LIMIT 1"
  ).get() as Record<string, unknown> | undefined;

  if (lastRun) {
    // Check if there are stale non-terminal tasks from a previous run
    const staleCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM task_state WHERE status IN ('claimed', 'running', 'verifying')"
    ).get() as { cnt: number };

    if (staleCount.cnt > 0) {
      logger.info('crash-recovery', { staleTasks: staleCount.cnt });
      rebuildProjections(db);
      hydrateActors(db);

      const stale = db.prepare(
        "SELECT task_id FROM task_state WHERE status IN ('claimed', 'running', 'verifying')"
      ).all() as { task_id: string }[];

      for (const { task_id } of stale) {
        const actor = getOrCreateTaskActor(task_id, {});
        actor.send({ type: 'CANCEL' });
        const { sequence, previousId } = nextSeq(db, `task:${task_id}`);
        persistAndProject(db, {
          stream_id: `task:${task_id}`, sequence, previous_id: previousId,
          type: 'task_cancelled',
          payload: { taskId: task_id, reason: 'crash recovery' },
          timestamp: new Date().toISOString(), actor: 'executor',
        });
      }
    }
  }

  // 4. Parse DAG and populate task_state + XState actors
  let tasks: Array<{
    id: string;
    tier?: number;
    gate?: number;
    model?: string;
    description?: string;
    prompt?: string;
    blockedBy?: string[];
    dependsOn?: string[];
    touchesFiles?: string[];
  }> = [];
  try {
    const planContent = await readFile(planSource, 'utf-8');
    const plan = JSON.parse(planContent) as { tasks?: typeof tasks };
    tasks = plan.tasks || [];
  } catch {
    // If plan parsing fails, check if tasks are already in the DB
    const existingTasks = db.prepare('SELECT COUNT(*) as cnt FROM task_state').get() as { cnt: number };
    if (existingTasks.cnt > 0) {
      logger.info('using-existing-tasks', { count: existingTasks.cnt });
    } else {
      logger.error('no-plan', { planSource });
      httpServer.close();
      return;
    }
  }

  db.prepare(
    'INSERT INTO runs (started_at, config, total_tasks) VALUES (?, ?, ?)'
  ).run(new Date().toISOString(), JSON.stringify(config), tasks.length || 0);

  for (const task of tasks) {
    const existing = db.prepare('SELECT task_id FROM task_state WHERE task_id = ?').get(task.id);
    if (existing) continue;

    const fullPrompt = task.prompt || task.description || '';
    const promptHash = crypto.createHash('sha256').update(fullPrompt).digest('hex');

    persistAndProject(db, {
      stream_id: `task:${task.id}`, sequence: 1, previous_id: null,
      type: 'task_created',
      payload: {
        taskId: task.id, gate: task.tier ?? task.gate ?? 1, model: task.model ?? 'sonnet',
        description: task.description, prompt: fullPrompt,
        dependsOn: task.blockedBy ?? task.dependsOn ?? [],
        promptHash, touchesFiles: task.touchesFiles ?? [],
      },
      timestamp: new Date().toISOString(), actor: 'executor',
    });

    getOrCreateTaskActor(task.id, {
      gate: task.tier ?? task.gate ?? 1,
      model: task.model ?? 'sonnet',
      dependsOn: task.blockedBy ?? task.dependsOn ?? [],
      touchesFiles: task.touchesFiles ?? [],
    });
  }

  // 5. Track in-flight agent processes
  const inFlight = new Map<string, { proc: ChildProcess; vcrProxy: http.Server; watchdog: ReturnType<typeof createWatchdog> }>();
  const parallelLimit = config.parallelTasksPerGate ?? 4;

  // 6. Event-driven execution loop
  const trySpawn = async () => {
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
    `).all(Math.max(0, parallelLimit - inFlight.size)) as Array<Record<string, unknown>>;

    for (const task of ready) {
      const taskId = task.task_id as string;
      const taskModel = task.model as string;
      const taskDescription = task.description as string | null;
      const taskPrompt = task.prompt as string | null;
      const taskPromptHash = task.prompt_hash as string | null;
      const taskDependsOn = task.depends_on as string | null;
      const taskTouchesFiles = task.touches_files as string | null;

      // Check content-addressed cache
      const relevantFileHashes = getRelevantFileHashes(projectRoot, taskTouchesFiles ? JSON.parse(taskTouchesFiles) as string[] : []);
      const configHash = computeConfigHash(config as unknown as Record<string, unknown>);

      // Collect dependency output hashes
      const deps = JSON.parse(taskDependsOn || '[]') as string[];
      const depOutputs: Record<string, string> = {};
      for (const dep of deps) {
        const depRow = db.prepare('SELECT output_hash FROM task_state WHERE task_id = ?').get(dep) as { output_hash: string | null } | undefined;
        if (depRow?.output_hash) depOutputs[dep] = depRow.output_hash;
      }

      const manifestHash = computeManifestHash({
        promptContent: taskPromptHash || '',
        relevantFileHashes,
        model: taskModel,
        configHash,
        dependencyOutputHashes: depOutputs,
      });

      const cacheResult = lookupCache(db, manifestHash);
      if (cacheResult) {
        logger.info('cache-hit', { taskId, manifestHash });
        const actor = getOrCreateTaskActor(taskId, {});
        actor.send({ type: 'CACHE_HIT', outputHash: cacheResult.output_hash });
        const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
        persistAndProject(db, {
          stream_id: `task:${taskId}`, sequence, previous_id: previousId,
          type: 'task_cache_hit',
          payload: { taskId, manifestHash, outputHash: cacheResult.output_hash },
          timestamp: new Date().toISOString(), actor: 'executor',
        });
        continue;
      }

      // No cache hit -- spawn agent
      let worktreePath = projectRoot;
      try {
        worktreePath = createWorktree(projectRoot, taskId);
      } catch {
        logger.warn('worktree-failed', { taskId });
        // Fall back to project root
      }

      const vcrPort = 3100 + parseInt(taskId.replace(/\D/g, ''), 10);
      const vcrProxy = createVcrProxy(db, taskId, 'api.anthropic.com', 'record', vcrPort);

      // VCR proxy health monitoring — kill agent if proxy dies.
      // Without API access the agent can't function. Spec §4, line 1679.
      // The proc variable is captured by closure; it will be assigned below
      // before this handler can fire (event loop guarantees).
      vcrProxy.on('error', (err: Error) => {
        logger.error('vcr-proxy-crash', { taskId, error: err.message });
        const entry = inFlight.get(taskId);
        if (entry) {
          entry.proc.kill('SIGTERM');
          setTimeout(() => { try { entry.proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
        }
      });

      const mcpConfigPath = join(worktreePath, '.wyvern-mcp.json');
      await writeFile(mcpConfigPath, JSON.stringify({
        mcpServers: {
          wyvern: { type: 'http', url: `http://127.0.0.1:${mcpPort}/mcp` },
        },
      }));

      const prompt = taskPrompt || taskDescription || `Complete task ${taskId}`;
      const modelArgs = taskModel !== 'opus' ? ['--model', `claude-${taskModel}-4-6`] : [];
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
          WYVERN_TASK_ID: taskId,
          WYVERN_WORKTREE: worktreePath,
        },
      });

      // Pre-claim and start via XState
      const actor = getOrCreateTaskActor(taskId, {});
      actor.send({ type: 'CLAIM', workerId: `proc:${proc.pid}` });
      const { sequence: s1, previousId: p1 } = nextSeq(db, `task:${taskId}`);
      persistAndProject(db, {
        stream_id: `task:${taskId}`, sequence: s1, previous_id: p1,
        type: 'task_claimed', payload: { taskId, workerId: `proc:${proc.pid}` },
        timestamp: new Date().toISOString(), actor: 'executor',
      });

      actor.send({ type: 'START' });
      const { sequence: s2, previousId: p2 } = nextSeq(db, `task:${taskId}`);
      persistAndProject(db, {
        stream_id: `task:${taskId}`, sequence: s2, previous_id: p2,
        type: 'task_started', payload: { taskId },
        timestamp: new Date().toISOString(), actor: 'executor',
      });

      // Capture agent output for diagnostics
      let stderrBuf = '';
      let stdoutBuf = '';
      proc.stdout!.on('data', (d: Buffer) => { stdoutBuf += d.toString(); });
      proc.stderr!.on('data', (d: Buffer) => {
        const line = d.toString();
        stderrBuf += line;
        logger.warn('agent-stderr', { taskId, line: line.trim() });
      });

      proc.stdin!.write(prompt);
      proc.stdin!.end();

      // Watchdog
      const watchdog = createWatchdog(config.watchdogTimeout * 1000, worktreePath);
      watchdog.onTimeout(() => {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* already dead */ } }, 5000);
      });
      watchdog.start(proc.pid!);

      inFlight.set(taskId, { proc, vcrProxy, watchdog });

      // Clean up on process exit
      proc.on('exit', (code) => {
        logger.info('agent-exited', { taskId, code, stderr: stderrBuf.slice(-500), stdout: stdoutBuf.slice(-500) });
        const entry = inFlight.get(taskId);
        if (entry) {
          entry.vcrProxy.close();
          entry.watchdog.stop();
          inFlight.delete(taskId);
        }

        // Ensure task reaches terminal state
        const taskRow = db.prepare('SELECT status FROM task_state WHERE task_id = ?').get(taskId) as { status: string } | undefined;
        if (taskRow && !['completed', 'failed', 'timeout', 'cancelled'].includes(taskRow.status)) {
          const taskActor = getTaskActor(taskId);
          if (taskActor) {
            const reason = code === null
              ? 'Agent process killed (signal)'
              : code === 0
                ? 'Agent exited without calling complete_task or fail_task'
                : `Agent process exited with code ${code}`;
            taskActor.send({ type: 'FAIL', reason });
            const { sequence, previousId } = nextSeq(db, `task:${taskId}`);
            persistAndProject(db, {
              stream_id: `task:${taskId}`, sequence, previous_id: previousId,
              type: 'task_failed', payload: { taskId, reason },
              timestamp: new Date().toISOString(), actor: 'executor',
            });
          }
        }

        try { removeWorktree(projectRoot, taskId); } catch { /* already cleaned */ }
      });
    }
  };

  // Initial spawn
  await trySpawn();

  // Event-driven loop
  await new Promise<void>((resolve) => {
    const onStateChange = async () => {
      const remaining = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_state WHERE status NOT IN ('completed', 'failed', 'cancelled', 'timeout')"
      ).get() as { cnt: number };

      if (remaining.cnt === 0) {
        stateChanged.off('change', onStateChange);
        resolve();
        return;
      }

      const inFlightCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_state WHERE status IN ('claimed', 'running', 'verifying')"
      ).get() as { cnt: number };

      if (inFlightCount.cnt === 0 && remaining.cnt > 0) {
        await trySpawn();
        const newInFlight = db.prepare(
          "SELECT COUNT(*) as cnt FROM task_state WHERE status IN ('claimed', 'running', 'verifying')"
        ).get() as { cnt: number };
        if (newInFlight.cnt === 0) {
          logger.error('execution-stalled', { remaining: remaining.cnt });
          stateChanged.off('change', onStateChange);
          resolve();
          return;
        }
      }

      await trySpawn();
    };

    stateChanged.on('change', onStateChange);
  });

  // 7. Finalize
  const failedCount = (db.prepare("SELECT COUNT(*) as cnt FROM task_state WHERE status = 'failed'").get() as { cnt: number }).cnt;
  const completedCount = (db.prepare("SELECT COUNT(*) as cnt FROM task_state WHERE status = 'completed'").get() as { cnt: number }).cnt;
  const totalCost = (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM task_state WHERE status = 'completed'").get() as { total: number }).total;
  const finalStatus = failedCount > 0 ? 'completed_with_failures' : 'completed';

  const { sequence: runSeq, previousId: runPrev } = nextSeq(db, 'orchestrator');
  persistAndProject(db, {
    stream_id: 'orchestrator', sequence: runSeq, previous_id: runPrev,
    type: finalStatus === 'completed' ? 'run_completed' : 'run_failed',
    payload: { completedTasks: completedCount, failedTasks: failedCount, totalCostUsd: totalCost },
    timestamp: new Date().toISOString(), actor: 'executor',
  });

  httpServer.close();
  logger.info('run-complete', { status: finalStatus });
  await logger.close();
}
