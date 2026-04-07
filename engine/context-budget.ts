import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, BudgetEstimate } from './types.js';

const CHARS_PER_TOKEN = 4;
const WARNING_THRESHOLD = 30_000;
const DRIVER_OVERHEAD_TOKENS = 500;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export async function estimateDriverPromptBudget(
  task: Task,
  taskDir: string,
  agentsDir: string,
): Promise<BudgetEstimate> {
  const initDir = join(agentsDir, 'initialization');
  const breakdown: Record<string, number> = {};

  const claudeMd = await safeRead(join(initDir, 'CLAUDE.md'));
  breakdown['CLAUDE.md'] = estimateTokens(claudeMd);

  const pin = await safeRead(join(initDir, 'README.md'));
  breakdown['pin (README.md)'] = estimateTokens(pin);

  const context = await safeRead(join(taskDir, 'context.md'));
  breakdown['context.md'] = estimateTokens(context);

  let promptTokens = 0;
  if (task.promptFile) {
    const prompt = await safeRead(task.promptFile);
    promptTokens = estimateTokens(prompt);
  }
  breakdown['prompt'] = promptTokens;

  breakdown['driver overhead'] = DRIVER_OVERHEAD_TOKENS;

  const totalTokens = Object.values(breakdown).reduce((a, b) => a + b, 0);

  let warning: string | null = null;
  if (totalTokens > WARNING_THRESHOLD) {
    warning = `Driver prompt estimated at ~${totalTokens.toLocaleString()} tokens (threshold: ${WARNING_THRESHOLD.toLocaleString()}). ` +
      `Consider trimming initialization files or splitting the task.`;
  }

  return { totalTokens, breakdown, warning };
}

export function formatBudget(estimate: BudgetEstimate): string {
  const lines = ['Token Budget Estimate', '-'.repeat(30)];

  for (const [source, tokens] of Object.entries(estimate.breakdown)) {
    const bar = '█'.repeat(Math.ceil(tokens / 500));
    lines.push(`  ${source.padEnd(20)} ${tokens.toLocaleString().padStart(7)} tokens ${bar}`);
  }

  lines.push('-'.repeat(30));
  lines.push(`  ${'TOTAL'.padEnd(20)} ${estimate.totalTokens.toLocaleString().padStart(7)} tokens`);

  if (estimate.warning) {
    lines.push(`\n⚠ ${estimate.warning}`);
  }

  return lines.join('\n');
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}
