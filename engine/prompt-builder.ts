import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Task, PromptSections } from './types.js';

const BASE_PATTERN = /\{\{base:(.+?)\}\}/g;
const CONTEXT_REF_PATTERN = /\{\{context:(.+?)\}\}/g;

export async function buildDriverPrompt(
  task: Task,
  taskDir: string,
  agentsDir: string,
): Promise<string> {
  const initDir = join(agentsDir, 'initialization');
  const contextFile = join(taskDir, 'context.md');

  const claudeMd = await safeRead(join(initDir, 'CLAUDE.md'), '(no CLAUDE.md found)');
  const pin = await safeRead(join(initDir, 'README.md'), '(no pin found)');
  const context = await safeRead(contextFile, '(no context yet)');

  let promptContent = '(no prompt file found)';
  if (task.promptFile) {
    promptContent = await readFile(task.promptFile, 'utf-8');
    promptContent = await resolveBaseTemplates(promptContent, join(agentsDir, 'reusable'));
    promptContent = await resolveContextRefs(promptContent, contextFile);
  }

  return `You are an execution agent in the Wyvern Loop. You have one task. Do it, verify it, and check the PLAN.md box.

## Project Conventions
${claudeMd}

## Codebase Index
${pin}

## Inter-Task Notes
${context}

## Your Task
${promptContent}

## When Done
1. Run all verify commands.
2. Call mcp__wyvern__complete_task with your taskId and workerId.
3. If you learned something the next task should know, call mcp__wyvern__write_context.
4. Stop. The process will be killed after completion is confirmed.

## If Something Goes Wrong
1. Call mcp__wyvern__fail_task with the reason.
2. Stop.`;
}

async function resolveBaseTemplates(content: string, reusableDir: string): Promise<string> {
  const matches = [...content.matchAll(BASE_PATTERN)];
  if (matches.length === 0) return content;

  let resolved = content;
  for (const match of matches) {
    const baseFile = match[1].trim();
    const basePath = join(reusableDir, baseFile);
    const baseContent = await safeRead(basePath, `(base template "${baseFile}" not found)`);
    const baseSections = parsePromptSections(baseContent);
    const overrideSections = parsePromptSections(resolved.replace(match[0], ''));
    resolved = mergePromptSections(baseSections, overrideSections);
  }

  return resolved;
}

async function resolveContextRefs(content: string, contextFile: string): Promise<string> {
  const contextContent = await safeRead(contextFile, '');
  if (!contextContent) return content;

  const contextMap = new Map<string, string>();
  for (const line of contextContent.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0 && !line.startsWith('#') && !line.startsWith('<!--')) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      if (key && value) contextMap.set(key, value);
    }
  }

  return content.replace(CONTEXT_REF_PATTERN, (_, key: string) => {
    const value = contextMap.get(key.trim().toLowerCase());
    return value ?? `(context key "${key.trim()}" not found)`;
  });
}

export function parsePromptSections(content: string): PromptSections {
  const sections: PromptSections = {};
  const sectionPattern = /^###\s+(.+)$/gm;
  const matches = [...content.matchAll(sectionPattern)];

  for (let i = 0; i < matches.length; i++) {
    const name = matches[i][1].trim().toLowerCase();
    const start = matches[i].index! + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : content.length;
    const body = content.slice(start, end).trim();

    if (name === 'context') sections.context = body;
    else if (name === 'goal') sections.goal = body;
    else if (name.includes('files to modify')) {
      sections.filesToModify = body
        .split('\n')
        .map(l => l.replace(/^[-*]\s*/, '').replace(/`/g, '').trim())
        .filter(l => l.length > 0 && !l.startsWith('<!--'));
    }
    else if (name.includes('specific change')) sections.specificChanges = body;
    else if (name.includes('do not') || name === 'don\'t') sections.doNot = body;
    else if (name === 'verify') sections.verify = body;
  }

  return sections;
}

function mergePromptSections(base: PromptSections, overrides: PromptSections): string {
  const merged: PromptSections = { ...base };

  if (overrides.context) merged.context = overrides.context;
  if (overrides.goal) merged.goal = overrides.goal;
  if (overrides.filesToModify) merged.filesToModify = overrides.filesToModify;
  if (overrides.specificChanges) merged.specificChanges = overrides.specificChanges;
  if (overrides.doNot) {
    merged.doNot = [base.doNot, overrides.doNot].filter(Boolean).join('\n');
  }
  if (overrides.verify) {
    merged.verify = [base.verify, overrides.verify].filter(Boolean).join('\n');
  }

  const lines: string[] = [];
  if (merged.context) lines.push(`### Context\n\n${merged.context}`);
  if (merged.goal) lines.push(`### Goal\n\n${merged.goal}`);
  if (merged.filesToModify) {
    lines.push(`### Files to Modify\n\n${merged.filesToModify.map(f => `- \`${f}\``).join('\n')}`);
  }
  if (merged.specificChanges) lines.push(`### Specific Changes\n\n${merged.specificChanges}`);
  if (merged.doNot) lines.push(`### DO NOT\n\n${merged.doNot}`);
  if (merged.verify) lines.push(`### Verify\n\n${merged.verify}`);

  return lines.join('\n\n');
}

async function safeRead(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return fallback;
  }
}
