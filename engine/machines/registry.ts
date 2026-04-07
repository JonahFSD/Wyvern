import { createActor, type ActorRefFrom } from 'xstate';
import { taskMachine, type TaskContext, type TaskEvent } from './task.js';

export type TaskActor = ActorRefFrom<typeof taskMachine>;

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

export function removeTaskActor(taskId: string): void {
  const actor = actors.get(taskId);
  if (actor) {
    actor.stop();
    actors.delete(taskId);
  }
}

export function clearActors(): void {
  for (const actor of actors.values()) {
    actor.stop();
  }
  actors.clear();
}

export function eventToXState(type: string, payload: Record<string, unknown>): TaskEvent {
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

import type Database from 'better-sqlite3';

export function hydrateActors(db: Database.Database): void {
  clearActors();
  const tasks = db.prepare('SELECT * FROM task_state').all() as any[];
  for (const task of tasks) {
    const actor = getOrCreateTaskActor(task.task_id, {
      gate: task.gate,
      model: task.model,
      dependsOn: JSON.parse(task.depends_on || '[]'),
    });
    // Fast-forward actor to current state by replaying events
    const events = db.prepare(
      'SELECT * FROM events WHERE stream_id = ? ORDER BY sequence ASC'
    ).all(`task:${task.task_id}`) as any[];
    for (const evt of events) {
      const payload = JSON.parse(evt.payload);
      try {
        actor.send(eventToXState(evt.type, payload));
      } catch {
        // Skip events that don't map to XState events (e.g., task_progress)
      }
    }
  }
}
