import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CostRecord, CostSummary, TaskResult } from './types.js';

const TOKEN_PATTERNS = [
  /Total\s+tokens?:\s*([\d,]+)/i,
  /tokens?\s+used:\s*([\d,]+)/i,
  /input[:\s]+([\d,]+)\s+tokens?/i,
];

const COST_PATTERN = /\$\s*([\d.]+)/;

const OUTPUT_TOKEN_PATTERNS = [
  /output[:\s]+([\d,]+)\s+tokens?/i,
  /completion[:\s]+([\d,]+)\s+tokens?/i,
];

const PROMPT_TOKEN_PATTERNS = [
  /input[:\s]+([\d,]+)\s+tokens?/i,
  /prompt[:\s]+([\d,]+)\s+tokens?/i,
];

export async function parseCostFromOutput(
  outputFile: string,
): Promise<{ promptTokens: number; completionTokens: number; costUsd: number } | null> {
  let content: string;
  try {
    content = await readFile(outputFile, 'utf-8');
  } catch {
    return null;
  }

  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;

  for (const pattern of PROMPT_TOKEN_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      promptTokens = parseInt(match[1].replace(/,/g, ''), 10);
      break;
    }
  }

  for (const pattern of OUTPUT_TOKEN_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      completionTokens = parseInt(match[1].replace(/,/g, ''), 10);
      break;
    }
  }

  // Fallback: total tokens split roughly 70/30
  if (promptTokens === 0 && completionTokens === 0) {
    for (const pattern of TOKEN_PATTERNS) {
      const match = content.match(pattern);
      if (match) {
        const total = parseInt(match[1].replace(/,/g, ''), 10);
        promptTokens = Math.round(total * 0.7);
        completionTokens = total - promptTokens;
        break;
      }
    }
  }

  const costMatch = content.match(COST_PATTERN);
  if (costMatch) {
    costUsd = parseFloat(costMatch[1]);
  }

  if (promptTokens === 0 && completionTokens === 0 && costUsd === 0) {
    return null;
  }

  return { promptTokens, completionTokens, costUsd };
}

export async function appendCostRecord(
  result: TaskResult,
  logFile: string,
): Promise<void> {
  const record: CostRecord = {
    timestamp: new Date().toISOString(),
    taskNumber: result.task.taskNumber,
    model: result.task.model,
    promptTokens: result.promptTokens ?? 0,
    completionTokens: result.completionTokens ?? 0,
    costUsd: result.costUsd ?? 0,
    durationMs: result.durationMs,
  };

  await mkdir(dirname(logFile), { recursive: true });
  await appendFile(logFile, JSON.stringify(record) + '\n', 'utf-8');
}

export async function getCostSummary(logFile: string): Promise<CostSummary> {
  let content: string;
  try {
    content = await readFile(logFile, 'utf-8');
  } catch {
    return { totalCost: 0, taskCount: 0, avgCostPerTask: 0, byModel: {} };
  }

  const records = content
    .trim()
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as CostRecord);

  if (records.length === 0) {
    return { totalCost: 0, taskCount: 0, avgCostPerTask: 0, byModel: {} };
  }

  const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);
  const byModel: Record<string, number> = {};

  for (const record of records) {
    byModel[record.model] = (byModel[record.model] ?? 0) + record.costUsd;
  }

  return {
    totalCost,
    taskCount: records.length,
    avgCostPerTask: totalCost / records.length,
    byModel,
  };
}

export function formatCostSummary(summary: CostSummary): string {
  const lines = ['Cost Summary', '='.repeat(30)];

  lines.push(`Total cost:     $${summary.totalCost.toFixed(4)}`);
  lines.push(`Total tasks:    ${summary.taskCount}`);
  lines.push(`Avg per task:   $${summary.avgCostPerTask.toFixed(4)}`);

  if (Object.keys(summary.byModel).length > 0) {
    lines.push('\nBy model:');
    for (const [model, cost] of Object.entries(summary.byModel)) {
      lines.push(`  ${model.padEnd(10)} $${cost.toFixed(4)}`);
    }
  }

  return lines.join('\n');
}
