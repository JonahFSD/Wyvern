#!/usr/bin/env node
/**
 * TaskCompleted Enforcement Gate
 *
 * Comprehensive quality gate for Wyvern Loop task completion.
 * Validates configured verification commands, file ownership, single commit,
 * commit format, and task ID reference.
 *
 * Exit codes:
 *   0 = allow (all checks passed)
 *   2 = reject (one or more checks failed)
 *
 * Environment variables (optional, set by launcher):
 *   WYVERN_DOMAIN - current domain (e.g., "frontend", "backend", "admin")
 *   WYVERN_TASK_START_SHA - SHA of HEAD when task started
 *   WYVERN_TASK_ID - task ID (e.g., "T01", "T15")
 *   WYVERN_WORKTREE - absolute or repo-relative worktree path
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../../engine/config.js';
import { getVerifyCommands } from '../../engine/verification.js';

interface Domain {
  name: string;
  ownedPaths: string[];
}

interface Plan {
  domains: Domain[];
}

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

const PROJECT_ROOT = resolveProjectRoot();
const EXECUTION_ROOT = resolveExecutionRoot();
const PLAN_FILE = resolve(PROJECT_ROOT, '.swarm/plan.json');
const SWARM_ENABLED = existsSync(PLAN_FILE);

const WYVERN_DOMAIN = process.env.WYVERN_DOMAIN;
const WYVERN_TASK_START_SHA = process.env.WYVERN_TASK_START_SHA;
const WYVERN_TASK_ID = process.env.WYVERN_TASK_ID;

const checks: CheckResult[] = [];

function resolveProjectRoot(): string {
  const hookPath = fileURLToPath(import.meta.url);
  return resolve(dirname(hookPath), '../../../../..');
}

function resolveExecutionRoot(): string {
  return resolve(PROJECT_ROOT, process.env.WYVERN_WORKTREE ?? '.');
}

function readPlan(): Plan | null {
  if (!SWARM_ENABLED) return null;

  try {
    const content = readFileSync(PLAN_FILE, 'utf-8');
    return JSON.parse(content) as Plan;
  } catch {
    console.error(`Failed to read plan file: ${PLAN_FILE}`);
    return null;
  }
}

function matchGlob(pattern: string, filepath: string): boolean {
  const normPattern = pattern.replace(/\\/g, '/');
  const normPath = filepath.replace(/\\/g, '/');

  if (normPattern === normPath) {
    return true;
  }

  if (normPattern.endsWith('/')) {
    return normPath.startsWith(normPattern);
  }

  let regexStr = '';
  const parts = normPattern.split('/');

  for (let i = 0; i < parts.length; i++) {
    const segment = parts[i];

    if (i > 0) regexStr += '/';

    if (segment === '**') {
      regexStr += i === parts.length - 1 ? '.*' : '(?:.*/)?';
      continue;
    }

    if (segment.includes('*')) {
      const placeholder = '\x00STAR\x00';
      const escaped = segment
        .replace(/\*/g, placeholder)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(new RegExp(placeholder.replace(/\x00/g, '\\x00'), 'g'), '[^/]*');
      regexStr += escaped;
      continue;
    }

    regexStr += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }

  return new RegExp(`^${regexStr}$`).test(normPath);
}

function getDomainOwnedPaths(): string[] | null {
  if (!SWARM_ENABLED || !WYVERN_DOMAIN) {
    return null;
  }

  const plan = readPlan();
  if (!plan) return null;

  const domain = plan.domains.find(entry => entry.name === WYVERN_DOMAIN);
  if (!domain) {
    console.error(`Domain not found in plan: ${WYVERN_DOMAIN}`);
    return null;
  }

  return domain.ownedPaths;
}

function runCommand(command: string): { success: boolean; output: string } {
  try {
    const output = execSync(command, { cwd: EXECUTION_ROOT, encoding: 'utf-8' });
    return { success: true, output };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      output: (execError.stdout || '') + (execError.stderr || '') + (execError.message || ''),
    };
  }
}

function getDiffBase(): string {
  return WYVERN_TASK_START_SHA?.trim() || 'HEAD~1';
}

function getModifiedFiles(): string[] | null {
  try {
    const output = execSync(`git diff --name-only ${getDiffBase()}..HEAD`, {
      cwd: EXECUTION_ROOT,
      encoding: 'utf-8',
    });
    return output
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
  } catch {
    return null;
  }
}

function checkVerification(commands: string[]): void {
  for (const command of commands) {
    const result = runCommand(`(${command}) 2>&1`);
    if (!result.success) {
      console.log('\nVERIFICATION FAILED — task cannot be marked complete.');
      console.log(`Command failed: ${command}`);
      if (result.output.trim().length > 0) {
        console.log(result.output.trim());
      }
      checks.push({
        name: `Verify: ${command}`,
        passed: false,
        message: 'command failed',
      });
      return;
    }

    checks.push({
      name: `Verify: ${command}`,
      passed: true,
      message: 'passed',
    });
  }
}

function checkFileOwnership(): void {
  if (!SWARM_ENABLED) {
    checks.push({
      name: 'File Ownership',
      passed: true,
      message: 'skipped (swarm not enabled)',
    });
    return;
  }

  if (!WYVERN_DOMAIN) {
    checks.push({
      name: 'File Ownership',
      passed: true,
      message: 'skipped (WYVERN_DOMAIN not set)',
    });
    return;
  }

  const ownedPaths = getDomainOwnedPaths();
  if (!ownedPaths) {
    checks.push({
      name: 'File Ownership',
      passed: false,
      message: `Failed to resolve owned paths for domain: ${WYVERN_DOMAIN ?? '(unset)'}`,
    });
    return;
  }

  const modifiedFiles = getModifiedFiles();
  if (!modifiedFiles) {
    checks.push({
      name: 'File Ownership',
      passed: false,
      message: `Failed to read git diff from ${getDiffBase()}..HEAD.`,
    });
    return;
  }

  for (const file of modifiedFiles) {
    const matches = ownedPaths.some(pattern => matchGlob(pattern, file));
    if (matches) continue;

    console.log('\nFILE OWNERSHIP VIOLATION — task cannot be marked complete.');
    console.log(`File '${file}' is outside domain '${WYVERN_DOMAIN}'s ownership.`);
    console.log(`Owned paths: ${ownedPaths.join(', ')}`);
    checks.push({
      name: 'File Ownership',
      passed: false,
      message: `File '${file}' outside domain ownership`,
    });
    return;
  }

  checks.push({
    name: 'File Ownership',
    passed: true,
    message: `${modifiedFiles.length} files verified`,
  });
}

function checkSingleCommit(): void {
  if (!SWARM_ENABLED || !WYVERN_TASK_START_SHA) {
    checks.push({
      name: 'Single Commit',
      passed: true,
      message: 'skipped (task tracking not enabled)',
    });
    return;
  }

  try {
    const output = execSync(`git rev-list --count ${WYVERN_TASK_START_SHA}..HEAD`, {
      cwd: EXECUTION_ROOT,
      encoding: 'utf-8',
    });
    const count = parseInt(output.trim(), 10);

    if (count !== 1) {
      console.log('\nSINGLE COMMIT VIOLATION — task cannot be marked complete.');
      console.log(`Expected exactly 1 commit, found ${count}.`);
      console.log('Each task must produce exactly one atomic commit.');
      checks.push({
        name: 'Single Commit',
        passed: false,
        message: `Found ${count} commits (expected 1)`,
      });
      return;
    }

    checks.push({
      name: 'Single Commit',
      passed: true,
      message: 'exactly 1 commit found',
    });
  } catch {
    checks.push({
      name: 'Single Commit',
      passed: false,
      message: 'Failed to count commits. Invalid WYVERN_TASK_START_SHA?',
    });
  }
}

function getLatestCommitMessage(): string | null {
  try {
    return execSync('git log -1 --format=%B', {
      cwd: EXECUTION_ROOT,
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

function checkCommitFormat(): void {
  if (!SWARM_ENABLED) {
    checks.push({
      name: 'Commit Format',
      passed: true,
      message: 'skipped (swarm not enabled)',
    });
    return;
  }

  const commitMessage = getLatestCommitMessage();
  if (!commitMessage) {
    checks.push({
      name: 'Commit Format',
      passed: false,
      message: 'Failed to read latest commit message',
    });
    return;
  }

  const firstLine = commitMessage.split('\n')[0];
  const format = /^(feat|fix|chore|refactor|style|perf|test|docs)\([a-z-]+\):\s.+/;

  if (!format.test(firstLine)) {
    console.log('\nCOMMIT FORMAT VIOLATION — task cannot be marked complete.');
    console.log(`Current message: "${firstLine}"`);
    console.log('Required format: type(scope): description');
    checks.push({
      name: 'Commit Format',
      passed: false,
      message: 'Does not match required format',
    });
    return;
  }

  if (firstLine.length > 72) {
    console.log('\nCOMMIT FORMAT VIOLATION — task cannot be marked complete.');
    console.log(`First line is ${firstLine.length} characters (max 72).`);
    checks.push({
      name: 'Commit Format',
      passed: false,
      message: `First line too long (${firstLine.length} > 72 chars)`,
    });
    return;
  }

  checks.push({
    name: 'Commit Format',
    passed: true,
    message: 'valid format',
  });
}

function checkTaskIdReference(): void {
  if (!SWARM_ENABLED || !WYVERN_TASK_ID) {
    checks.push({
      name: 'Task ID Reference',
      passed: true,
      message: 'skipped (task tracking not enabled)',
    });
    return;
  }

  const commitMessage = getLatestCommitMessage();
  if (!commitMessage) {
    checks.push({
      name: 'Task ID Reference',
      passed: false,
      message: 'Failed to read commit message',
    });
    return;
  }

  const refPattern = new RegExp(`Refs:\\s*${WYVERN_TASK_ID}`);
  if (!refPattern.test(commitMessage)) {
    console.log('\nTASK ID REFERENCE MISSING — task cannot be marked complete.');
    console.log(`Commit must reference task ID: ${WYVERN_TASK_ID}`);
    checks.push({
      name: 'Task ID Reference',
      passed: false,
      message: `Missing 'Refs: ${WYVERN_TASK_ID}'`,
    });
    return;
  }

  checks.push({
    name: 'Task ID Reference',
    passed: true,
    message: `references ${WYVERN_TASK_ID}`,
  });
}

function checkStrayFiles(): void {
  try {
    const status = execSync('git status --porcelain', {
      cwd: EXECUTION_ROOT,
      encoding: 'utf-8',
    });
    const lines = status
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length > 0) {
      console.log('\nWARNING: Uncommitted changes detected:');
      lines.forEach(line => console.log(`  ${line}`));
      checks.push({
        name: 'Stray Files',
        passed: false,
        message: `${lines.length} uncommitted file(s) detected`,
      });
      return;
    }

    checks.push({
      name: 'Stray Files',
      passed: true,
      message: 'no uncommitted changes',
    });
  } catch {
    checks.push({
      name: 'Stray Files',
      passed: true,
      message: 'warning (could not check)',
    });
  }
}

function printSummary(): void {
  console.log('\n========================================');
  console.log('Quality Gate Summary');
  console.log('========================================');

  let allPassed = true;
  for (const check of checks) {
    const status = check.passed ? '✓' : '✗';
    const color = check.passed ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    console.log(`${color}${status}${reset} ${check.name}: ${check.message}`);
    if (!check.passed) allPassed = false;
  }

  console.log('========================================');
  console.log(allPassed ? '\x1b[32m✓ All checks passed\x1b[0m' : '\x1b[31m✗ Quality gate failed\x1b[0m');
  console.log('========================================');

  process.exit(allPassed ? 0 : 2);
}

async function main(): Promise<void> {
  const config = await loadConfig(PROJECT_ROOT);
  const verifyCommands = getVerifyCommands(config);

  console.log('=== Quality Gate: Task Completed ===');
  console.log('Running comprehensive validation...\n');

  console.log(`Running verification in ${EXECUTION_ROOT}...`);
  checkVerification(verifyCommands);

  if (SWARM_ENABLED) {
    console.log('Running file ownership validation...');
    checkFileOwnership();

    console.log('Running single commit validation...');
    checkSingleCommit();

    console.log('Running commit format validation...');
    checkCommitFormat();

    console.log('Running task ID reference validation...');
    checkTaskIdReference();
  }

  console.log('Running stray files check...');
  checkStrayFiles();

  printSummary();
}

main().catch((error) => {
  console.error(String(error));
  process.exit(2);
});
