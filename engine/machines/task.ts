import { setup, assign } from 'xstate';

export interface TaskContext {
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

export type TaskEvent =
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
    input: {} as TaskContext,
  },
  guards: {
    canRetry: ({ context }) => {
      return context.retryCount < context.maxRetries;
    },
  },
  actions: {
    assignWorker: assign({
      workerId: ({ event }) => {
        if (event.type === 'CLAIM') return event.workerId;
        return null;
      },
    }),
    incrementRetry: assign({
      retryCount: ({ context }) => context.retryCount + 1,
    }),
    setFailureReason: assign({
      failureReason: ({ event }) => {
        if (event.type === 'FAIL' || event.type === 'VERIFICATION_FAILED') return event.reason;
        return null;
      },
    }),
  },
}).createMachine({
  id: 'task',
  context: ({ input }) => ({ ...input }),
  initial: 'pending',
  states: {
    pending: {
      on: {
        CLAIM: {
          target: 'claimed',
          actions: ['assignWorker'],
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
          actions: ['setFailureReason'],
        },
      },
    },
    running: {
      on: {
        VERIFICATION_STARTED: { target: 'verifying' },
        FAIL: {
          target: 'failed',
          actions: ['setFailureReason'],
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
            guard: 'canRetry',
            target: 'running',
            actions: ['incrementRetry'],
          },
          {
            target: 'failed',
            actions: ['setFailureReason'],
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
