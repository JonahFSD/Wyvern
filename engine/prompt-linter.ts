import { readFile, readdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { WyvernConfig, LintResult, LintIssue, ModelTier } from './types.js';
import { parsePromptSections } from './prompt-builder.js';
import { parsePlan } from './plan-parser.js';

const DISCOVERY_TERMS = [
  /\bfind\s+(the|a|all|any|where)\b/i,
  /\bsearch\s+(for|through|the)\b/i,
  /\blook\s+(for|at|through|into)\b/i,
  /\binvestigate\b/i,
  /\bexplore\b/i,
  /\bdiscover\b/i,
  /\bfigure\s+out\b/i,
];

const REQUIRED_SECTIONS = ['context', 'goal', 'verify'];

export async function lintPrompt(
  promptFile: string,
  config: WyvernConfig,
  model?: ModelTier,
): Promise<LintResult> {
  const content = await readFile(promptFile, 'utf-8');
  const lines = content.split('\n');
  const lineCount = lines.filter((l: string) => l.trim().length > 0).length;
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const sections = parsePromptSections(content);
  const limits = model
    ? config.modelConfig[model]?.maxPromptLines ?? config.maxPromptLines
    : config.maxPromptLines;

  // Check line count
  if (lineCount < limits.min) {
    errors.push({
      rule: 'line-count-min',
      message: `Prompt has ${lineCount} non-empty lines, minimum is ${limits.min}. Too sparse for reliable execution.`,
      severity: 'error',
    });
  }
  if (lineCount > limits.max) {
    warnings.push({
      rule: 'line-count-max',
      message: `Prompt has ${lineCount} non-empty lines, recommended max is ${limits.max}. Model may drop requirements.`,
      severity: 'warning',
    });
  }

  // Check required sections
  for (const section of REQUIRED_SECTIONS) {
    const value = sections[section as keyof typeof sections];
    if (!value || (typeof value === 'string' && value.replace(/<!--.*?-->/gs, '').trim().length === 0)) {
      errors.push({
        rule: `missing-section-${section}`,
        message: `Required section "${section}" is missing or empty.`,
        severity: 'error',
      });
    }
  }

  // Check Files to Modify section
  if (!sections.filesToModify || sections.filesToModify.length === 0) {
    warnings.push({
      rule: 'missing-files-to-modify',
      message: '"Files to Modify" section is missing or empty. Agent may touch unexpected files.',
      severity: 'warning',
    });
  } else {
    const fileReferences = sections.filesToModify.filter(filePath => !isNonFileReference(filePath));

    // Verify referenced files exist
    const projectRoot = findProjectRoot(promptFile);
    for (const filePath of fileReferences) {
      if (filePath.startsWith('<!--') || filePath.length === 0) continue;
      const absPath = join(projectRoot, filePath);
      try {
        await access(absPath);
      } catch {
        warnings.push({
          rule: 'file-not-found',
          message: `Referenced file "${filePath}" does not exist on disk.`,
          severity: 'warning',
        });
      }
    }

    if (fileReferences.length > 3) {
      warnings.push({
        rule: 'too-many-files',
        message: `${fileReferences.length} files listed. Recommended max is 3. Consider splitting the task.`,
        severity: 'warning',
      });
    }
  }

  // Check for discovery language
  for (const pattern of DISCOVERY_TERMS) {
    const match = content.match(pattern);
    if (match) {
      warnings.push({
        rule: 'discovery-language',
        message: `Found discovery language: "${match[0]}". Execution prompts should specify exact locations, not search.`,
        severity: 'warning',
      });
    }
  }

  // Check verify block has actual commands
  if (sections.verify) {
    const verifyClean = sections.verify.replace(/<!--.*?-->/gs, '').trim();
    const hasCodeBlock = verifyClean.includes('```') || /^\s*[$>]\s/m.test(verifyClean);
    const hasCommand = /\b(npm|npx|node|bun|pnpm|yarn|tsc|eslint|jest|vitest|pytest|cargo|go|make)\b/.test(verifyClean);
    if (!hasCodeBlock && !hasCommand) {
      warnings.push({
        rule: 'verify-no-commands',
        message: 'Verify block does not appear to contain runnable commands.',
        severity: 'warning',
      });
    }
  }

  return {
    file: promptFile,
    errors,
    warnings,
    lineCount,
    valid: errors.length === 0,
  };
}

export async function lintAllPrompts(
  taskDir: string,
  config: WyvernConfig,
): Promise<LintResult[]> {
  const files = await readdir(taskDir);
  const promptFiles = files.filter((f: string) =>
    f.endsWith('.md') &&
    f.startsWith('prompt-') &&
    f !== 'PLAN.md' &&
    f !== 'context.md'
  );

  const modelsByTaskNumber = await getTaskModels(taskDir);
  const results: LintResult[] = [];
  for (const file of promptFiles) {
    const taskNumber = extractTaskNumber(file);
    const result = await lintPrompt(
      join(taskDir, file),
      config,
      taskNumber ? modelsByTaskNumber.get(taskNumber) : undefined,
    );
    results.push(result);
  }

  return results;
}

export function formatLintResults(results: LintResult[]): string {
  if (results.length === 0) return 'No prompt files found to lint.';

  const lines: string[] = ['Prompt Lint Results', '='.repeat(40)];
  let totalErrors = 0;
  let totalWarnings = 0;

  for (const result of results) {
    const icon = result.valid ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    lines.push(`\n${icon} ${result.file} (${result.lineCount} lines)`);

    for (const err of result.errors) {
      lines.push(`  \x1b[31mERROR\x1b[0m [${err.rule}] ${err.message}`);
      totalErrors++;
    }
    for (const warn of result.warnings) {
      lines.push(`  \x1b[33mWARN\x1b[0m  [${warn.rule}] ${warn.message}`);
      totalWarnings++;
    }

    if (result.errors.length === 0 && result.warnings.length === 0) {
      lines.push('  No issues found.');
    }
  }

  lines.push(`\n${results.length} file(s), ${totalErrors} error(s), ${totalWarnings} warning(s)`);
  return lines.join('\n');
}

function findProjectRoot(fromPath: string): string {
  let dir = dirname(fromPath);
  let packageCandidate: string | null = null;

  while (true) {
    if (existsSync(join(dir, '.git'))) {
      return dir;
    }
    if (existsSync(join(dir, 'package.json'))) {
      packageCandidate = dir;
    }

    if (dir === '/' || dir === '.') {
      return packageCandidate ?? dir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return packageCandidate ?? dir;
    }
    dir = parent;
  }
}

function isNonFileReference(filePath: string): boolean {
  return /^(none|n\/a)\b/i.test(filePath);
}

function extractTaskNumber(filename: string): string | null {
  const match = filename.match(/(\d+)/);
  return match ? match[1].padStart(2, '0') : null;
}

async function getTaskModels(taskDir: string): Promise<Map<string, ModelTier>> {
  const modelByTaskNumber = new Map<string, ModelTier>();

  try {
    const plan = await parsePlan(join(taskDir, 'PLAN.md'), taskDir);
    for (const gate of plan.gates) {
      for (const task of gate.tasks) {
        modelByTaskNumber.set(task.taskNumber, task.model);
      }
    }
  } catch {
    // Best-effort only; linting still works without PLAN metadata.
  }

  return modelByTaskNumber;
}
