import { setup, assign } from 'xstate';

export interface OrchestratorContext {
  runId: number;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  cacheHits: number;
}

export type OrchestratorEvent =
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
    input: {} as OrchestratorContext,
  },
  guards: {
    allTasksFinished: ({ context }) => {
      return (context.completedTasks + context.failedTasks + context.cacheHits) >= context.totalTasks;
    },
    hasFailures: ({ context }) => context.failedTasks > 0,
  },
}).createMachine({
  id: 'orchestrator',
  context: ({ input }) => ({ ...input }),
  initial: 'planning',
  states: {
    planning: {
      on: {
        PLAN_PARSED: {
          target: 'executing',
          actions: assign({ totalTasks: ({ event }) => event.totalTasks }),
        },
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
    },
    draining: {
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
