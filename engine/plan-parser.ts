import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, Gate, ExecutionPlan, ModelTier, TaskStatus } from './types.js';
import { lockedUpdate } from './file-lock.js';

const GATE_PATTERN = /^##\s+Gate\s+(\d+)/i;
const TASK_PATTERN = /^- \[([ x])\]\s+Task\s+(\d+)\s*[—–-]\s*(.+)$/;
const MODEL_PATTERN = /@(opus|sonnet|haiku)\b/i;
const DEPENDS_PATTERN = /depends?:\s*([\d,\s]+)/i;

export async function parsePlan(planFile: string, taskDir: string): Promise<ExecutionPlan> {
  const content = await readFile(planFile, 'utf-8');
  const lines = content.split('\n');

  let currentGate = 1;
  const gates = new Map<number, Task[]>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const gateMatch = line.match(GATE_PATTERN);
    if (gateMatch) {
      currentGate = parseInt(gateMatch[1], 10);
      continue;
    }

    const taskMatch = line.match(TASK_PATTERN);
    if (taskMatch) {
      const checked = taskMatch[1] === 'x';
      const taskNumber = taskMatch[2];
      const description = taskMatch[3].trim();

      const modelMatch = description.match(MODEL_PATTERN);
      const model: ModelTier = modelMatch
        ? (modelMatch[1].toLowerCase() as ModelTier)
        : 'opus';

      const dependsMatch = description.match(DEPENDS_PATTERN);
      const dependsOn = dependsMatch
        ? dependsMatch[1].split(',').map((d: string) => d.trim().padStart(2, '0'))
        : [];

      const promptFile = await findPromptFile(taskDir, taskNumber);

      const task: Task = {
        lineNumber: i + 1,
        taskNumber: taskNumber.padStart(2, '0'),
        description: description
          .replace(MODEL_PATTERN, '')
          .replace(DEPENDS_PATTERN, '')
          .trim(),
        status: checked ? 'completed' : 'pending',
        gate: currentGate,
        model,
        dependsOn,
        promptFile,
      };

      const gateTasks = gates.get(currentGate) || [];
      gateTasks.push(task);
      gates.set(currentGate, gateTasks);
    }
  }

  const sortedGates: Gate[] = Array.from(gates.entries())
    .sort(([a], [b]) => a - b)
    .map(([number, tasks]) => ({ number, tasks }));

  return {
    gates: sortedGates,
    totalTasks: sortedGates.reduce((sum, g) => sum + g.tasks.length, 0),
    taskDir,
  };
}

async function findPromptFile(taskDir: string, taskNumber: string): Promise<string | undefined> {
  const padded = taskNumber.padStart(2, '0');
  try {
    const files = await readdir(taskDir);
    const match = files.find((f: string) =>
      f.endsWith('.md') &&
      f !== 'PLAN.md' &&
      f !== 'context.md' &&
      (f.includes(`-${padded}`) || f.includes(`-${padded}.`))
    );
    return match ? join(taskDir, match) : undefined;
  } catch {
    return undefined;
  }
}

export async function markTaskComplete(planFile: string, lineNumber: number): Promise<void> {
  await lockedUpdate(planFile, (content) => {
    const lines = content.split('\n');
    const idx = lineNumber - 1;

    if (idx >= 0 && idx < lines.length) {
      lines[idx] = lines[idx].replace('- [ ]', '- [x]');
    }

    return lines.join('\n');
  });
}

export function getNextPendingTasks(plan: ExecutionPlan): Task[] {
  const completedTasks = new Set<string>();

  for (const gate of plan.gates) {
    for (const task of gate.tasks) {
      if (task.status === 'completed') {
        completedTasks.add(task.taskNumber);
      }
    }
  }

  for (const gate of plan.gates) {
    const pending = gate.tasks.filter(t => {
      if (t.status !== 'pending') return false;
      return t.dependsOn.every(dep => completedTasks.has(dep));
    });

    if (pending.length > 0) return pending;

    const allDone = gate.tasks.every(
      t => t.status === 'completed' || t.status === 'skipped'
    );
    if (!allDone) return [];
  }

  return [];
}

export function formatPlan(plan: ExecutionPlan): string {
  const lines: string[] = ['Execution Plan', '='.repeat(40)];

  for (const gate of plan.gates) {
    lines.push(`\nGate ${gate.number}:`);
    for (const task of gate.tasks) {
      const status = task.status === 'completed' ? '[x]' : '[ ]';
      const model = task.model !== 'opus' ? ` @${task.model}` : '';
      const deps = task.dependsOn.length > 0 ? ` (depends: ${task.dependsOn.join(', ')})` : '';
      const prompt = task.promptFile ? ' ✓' : ' ✗ no prompt';
      lines.push(`  ${status} Task ${task.taskNumber} — ${task.description}${model}${deps}${prompt}`);
    }
  }

  lines.push(`\nTotal: ${plan.totalTasks} tasks across ${plan.gates.length} gate(s)`);
  return lines.join('\n');
}
