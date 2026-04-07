import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AuditResult, WyvernConfig, StructuralAuditResult } from './types.js';
import type { SwarmPlan } from '../swarm/types.js';

const AUDIT_PROMPTS: Record<string, string> = {
  diff: 'diff-audit.md',
  'tech-debt': 'tech-debt-audit.md',
  security: 'security-audit.md',
};

export async function runAudit(
  taskDir: string,
  auditType: 'diff' | 'tech-debt' | 'security',
  agentsDir: string,
  config: WyvernConfig,
): Promise<AuditResult> {
  const timestamp = formatTimestamp();
  const initDir = join(agentsDir, 'initialization');
  const reusableDir = join(agentsDir, 'reusable');
  const auditsDir = join(agentsDir, 'audits');
  const reportFile = join(auditsDir, `${auditType}-audit-${timestamp}.md`);

  await mkdir(auditsDir, { recursive: true });

  const auditPromptFile = join(reusableDir, AUDIT_PROMPTS[auditType]);
  const auditPrompt = await safeRead(auditPromptFile, '(audit prompt not found)');
  const claudeMd = await safeRead(join(initDir, 'CLAUDE.md'), '(no CLAUDE.md)');
  const pin = await safeRead(join(initDir, 'README.md'), '(no pin)');
  const plan = await safeRead(join(taskDir, 'PLAN.md'), '(no PLAN.md)');

  const driverPrompt = `You are an audit agent in the Wyvern Loop. You are READ-ONLY. You cannot and should not modify any code. Your job is to find problems, not fix them.

## Project Conventions (audit against these)
${claudeMd}

## Codebase Index
${pin}

## Task That Was Executed
${plan}

## Audit Instructions
${auditPrompt}

## Output
Write your complete audit report to: ${reportFile}

Format: Use the structure defined in the audit prompt above. Include file paths and line numbers for every finding. End with one of:
- PASS — No issues found. Safe to commit.
- PASS WITH WARNINGS — Minor issues. Human judgment call.
- NEEDS FIXES — Issues that should be fixed before committing.`;

  const exitCode = await runClaudeWithPrompt(driverPrompt);

  // Parse the report for verdict
  const report = await safeRead(reportFile, '');
  if (exitCode === 124) {
    throw new Error('Audit agent timed out after 10 minutes');
  }
  if (exitCode !== 0) {
    throw new Error(`Audit agent exited with code ${exitCode}`);
  }
  if (report.trim().length === 0) {
    throw new Error('Audit report was empty');
  }
  const verdict = parseVerdict(report);
  const riskScore = parseRiskScore(report);
  const findingsCount = countFindings(report);

  return {
    timestamp,
    taskDir,
    auditType,
    verdict,
    riskScore,
    findingsCount,
  };
}

function parseVerdict(report: string): AuditResult['verdict'] {
  if (report.trim().length === 0) return 'NEEDS FIXES';
  const lower = report.toLowerCase();
  if (lower.includes('needs fixes')) return 'NEEDS FIXES';
  if (lower.includes('pass with warnings')) return 'PASS WITH WARNINGS';
  return 'PASS';
}

function parseRiskScore(report: string): number | undefined {
  const match = report.match(/Risk\s+Score:\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : undefined;
}

function countFindings(report: string): number {
  const matches = report.match(/###\s+(CRITICAL|HIGH|MEDIUM|LOW|PASS|WARNING|ISSUE):/gi);
  return matches?.length ?? 0;
}

/** Default audit timeout: 10 minutes. Prevents runaway audit agents. */
const AUDIT_TIMEOUT_MS = 10 * 60 * 1000;

function runClaudeWithPrompt(prompt: string, timeoutMs: number = AUDIT_TIMEOUT_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['--dangerously-skip-permissions', '-p', '-'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {}
      // Escalate to SIGKILL after 5s
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
      }, 5000);
    }, timeoutMs);

    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(124); // Convention: 124 = timeout (like GNU timeout)
      } else {
        resolve(code ?? 0);
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function appendAuditTrend(
  result: AuditResult,
  trendFile: string,
): Promise<void> {
  await mkdir(dirname(trendFile), { recursive: true });

  let needsHeader = false;
  try {
    await readFile(trendFile);
  } catch {
    needsHeader = true;
  }

  let line = '';
  if (needsHeader) {
    line = 'timestamp,taskDir,auditType,verdict,riskScore,findingsCount\n';
  }

  line += [
    result.timestamp,
    result.taskDir,
    result.auditType,
    `"${result.verdict}"`,
    result.riskScore ?? '',
    result.findingsCount,
  ].join(',') + '\n';

  await appendFile(trendFile, line, 'utf-8');
}

export async function getAuditTrend(
  trendFile: string,
  limit = 20,
): Promise<AuditResult[]> {
  let content: string;
  try {
    content = await readFile(trendFile, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.trim().split('\n').slice(1); // skip header
  const results: AuditResult[] = lines.slice(-limit).map(line => {
    const parts = line.split(',');
    return {
      timestamp: parts[0],
      taskDir: parts[1],
      auditType: parts[2] as AuditResult['auditType'],
      verdict: parts[3].replace(/"/g, '') as AuditResult['verdict'],
      riskScore: parts[4] ? parseInt(parts[4], 10) : undefined,
      findingsCount: parseInt(parts[5], 10) || 0,
    };
  });

  return results;
}

export function formatTrendReport(results: AuditResult[]): string {
  if (results.length === 0) return 'No audit history found.';

  const lines = ['Audit Trend', '='.repeat(50)];

  for (const r of results) {
    const icon = r.verdict === 'PASS' ? '✓' : r.verdict === 'NEEDS FIXES' ? '✗' : '⚠';
    const risk = r.riskScore !== undefined ? ` risk:${r.riskScore}` : '';
    lines.push(
      `  ${r.timestamp.slice(0, 10)} ${icon} ${r.auditType.padEnd(10)} ${r.verdict.padEnd(20)} ${r.findingsCount} findings${risk}`
    );
  }

  // Trend analysis
  const recent = results.slice(-5);
  const passRate = recent.filter(r => r.verdict === 'PASS').length / recent.length;
  const avgFindings = recent.reduce((s, r) => s + r.findingsCount, 0) / recent.length;

  lines.push('');
  lines.push(`Last ${recent.length} audits: ${(passRate * 100).toFixed(0)}% pass rate, avg ${avgFindings.toFixed(1)} findings`);

  if (passRate >= 0.8) lines.push('Trend: IMPROVING');
  else if (passRate >= 0.5) lines.push('Trend: STABLE');
  else lines.push('Trend: DEGRADING — review prompt quality and task scope');

  return lines.join('\n');
}

function formatTimestamp(): string {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
    '-',
    String(d.getHours()).padStart(2, '0'),
    String(d.getMinutes()).padStart(2, '0'),
    String(d.getSeconds()).padStart(2, '0'),
  ].join('');
}

async function safeRead(path: string, fallback: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return fallback;
  }
}

/**
 * Runs deterministic structural checks against a task in the swarm plan.
 * Zero LLM calls, pure TypeScript validation.
 */
export async function runStructuralAudit(
  taskId: string,
  planFile: string,
  projectRoot: string,
): Promise<StructuralAuditResult> {
  const timestamp = formatTimestamp();

  // Read the swarm plan
  let plan: SwarmPlan;
  try {
    const planContent = await readFile(planFile, 'utf-8');
    plan = JSON.parse(planContent);
  } catch (error) {
    return {
      taskId,
      timestamp,
      checks: {
        filesExist: { expected: [], found: [], missing: [] },
        exportsFound: { expected: [], found: [], missing: [] },
        ownershipValid: false,
        commitFound: false,
      },
      passed: false,
      summary: `Failed to read plan file: ${String(error)}`,
    };
  }

  // Find the task
  const task = plan.tasks.find(t => t.id === taskId);
  if (!task) {
    return {
      taskId,
      timestamp,
      checks: {
        filesExist: { expected: [], found: [], missing: [] },
        exportsFound: { expected: [], found: [], missing: [] },
        ownershipValid: false,
        commitFound: false,
      },
      passed: false,
      summary: `Task ${taskId} not found in plan`,
    };
  }

  // Find the domain
  const domain = plan.domains.find(d => d.name === task.domain);
  if (!domain) {
    return {
      taskId,
      timestamp,
      checks: {
        filesExist: { expected: [], found: [], missing: [] },
        exportsFound: { expected: [], found: [], missing: [] },
        ownershipValid: false,
        commitFound: false,
      },
      passed: false,
      summary: `Domain ${task.domain} not found in plan`,
    };
  }

  // 1. Check file existence
  const filesExistResult = checkFilesExist(projectRoot, task.touchesFiles);

  // 2. Check exports
  const exportsFoundResult = await checkExportsFound(projectRoot, task.touchesFiles, task.exports);

  // 3. Check ownership (belt-and-suspenders)
  const ownershipValid = checkOwnership(projectRoot, domain.ownedPaths, task.touchesFiles);

  // 4. Check commit reference
  const { commitFound, commitSha } = checkCommitReference(projectRoot, taskId);

  // Determine overall pass/fail
  const passed =
    filesExistResult.missing.length === 0 &&
    exportsFoundResult.missing.length === 0 &&
    ownershipValid &&
    commitFound;

  // Build summary
  let summary = '';
  if (passed) {
    summary = `All checks passed. Files: ${filesExistResult.found.length}/${filesExistResult.expected.length}, Exports: ${exportsFoundResult.found.length}/${exportsFoundResult.expected.length}`;
  } else {
    const issues: string[] = [];
    if (filesExistResult.missing.length > 0) issues.push(`Missing ${filesExistResult.missing.length} files`);
    if (exportsFoundResult.missing.length > 0) issues.push(`Missing exports: ${exportsFoundResult.missing.join(', ')}`);
    if (!ownershipValid) issues.push('Ownership violation');
    if (!commitFound) issues.push('No commit found');
    summary = issues.join('; ');
  }

  return {
    taskId,
    timestamp,
    checks: {
      filesExist: filesExistResult,
      exportsFound: exportsFoundResult,
      ownershipValid,
      commitFound,
      commitSha,
    },
    passed,
    summary,
  };
}

/**
 * Check file existence for all files touched by the task.
 */
function checkFilesExist(
  projectRoot: string,
  touchesFiles: string[],
): { expected: string[]; found: string[]; missing: string[] } {
  const found: string[] = [];
  const missing: string[] = [];

  for (const file of touchesFiles) {
    const fullPath = join(projectRoot, file);
    if (existsSync(fullPath)) {
      found.push(file);
    } else {
      missing.push(file);
    }
  }

  return { expected: touchesFiles, found, missing };
}

/**
 * Check that exported names are present in the files.
 * Regex-based check for common export patterns.
 */
async function checkExportsFound(
  projectRoot: string,
  touchesFiles: string[],
  exports: string[],
): Promise<{ expected: string[]; found: string[]; missing: string[] }> {
  const found: string[] = [];
  const missing: string[] = [];

  for (const exportName of exports) {
    let found_export = false;

    // Check in each touched file
    for (const file of touchesFiles) {
      const fullPath = join(projectRoot, file);
      if (!existsSync(fullPath)) continue;

      try {
        const content = await readFile(fullPath, 'utf-8');
        // Check for common export patterns
        const patterns = [
          new RegExp(`export\\s+function\\s+${exportName}\\s*\\(`, 'g'),
          new RegExp(`export\\s+const\\s+${exportName}\\s*[=:]`, 'g'),
          new RegExp(`export\\s+let\\s+${exportName}\\s*[=:]`, 'g'),
          new RegExp(`export\\s+class\\s+${exportName}\\s*[{({]`, 'g'),
          new RegExp(`export\\s+default\\s+${exportName}`, 'g'),
          new RegExp(`export\\s+\\{[^}]*${exportName}[^}]*\\}`, 'g'),
          new RegExp(`export\\s*\\(.*${exportName}.*\\)`, 'g'),
        ];

        if (patterns.some(p => p.test(content))) {
          found_export = true;
          break;
        }
      } catch {
        // Skip unreadable files
        continue;
      }
    }

    if (found_export) {
      found.push(exportName);
    } else {
      missing.push(exportName);
    }
  }

  return { expected: exports, found, missing };
}

/**
 * Check that all files belong to the domain's owned paths.
 */
function checkOwnership(
  projectRoot: string,
  ownedPaths: string[],
  touchesFiles: string[],
): boolean {
  for (const file of touchesFiles) {
    let isOwned = false;

    for (const ownedPath of ownedPaths) {
      // Normalize paths for comparison
      const normalized = ownedPath.replace(/\/$/, '');
      const filePath = file.replace(/\/$/, '');

      // Check if file is under the owned path
      if (filePath === normalized || filePath.startsWith(normalized + '/')) {
        isOwned = true;
        break;
      }
    }

    if (!isOwned) {
      return false;
    }
  }

  return true;
}

/**
 * Check that at least one commit references this task.
 * Multiple commits are acceptable (fix-ups, follow-ups, etc.).
 * Returns the SHA of the most recent matching commit.
 */
function checkCommitReference(projectRoot: string, taskId: string): { commitFound: boolean; commitSha?: string } {
  try {
    const output = execSync(`cd "${projectRoot}" && git log --oneline --all --grep="Refs: ${taskId}" 2>/dev/null || echo ""`, {
      encoding: 'utf-8',
    }).trim();

    if (!output) {
      return { commitFound: false };
    }

    const lines = output.split('\n').filter(l => l.length > 0);
    if (lines.length >= 1) {
      // Return the most recent (first listed) commit SHA
      const sha = lines[0].split(' ')[0];
      return { commitFound: true, commitSha: sha };
    }

    return { commitFound: false };
  } catch {
    return { commitFound: false };
  }
}

/**
 * Run structural audit for all tasks in a domain.
 */
export async function runDomainAudit(
  domainName: string,
  planFile: string,
  projectRoot: string,
): Promise<StructuralAuditResult[]> {
  let plan: SwarmPlan;
  try {
    const planContent = await readFile(planFile, 'utf-8');
    plan = JSON.parse(planContent);
  } catch {
    return [];
  }

  const domainTasks = plan.tasks.filter(t => t.domain === domainName);
  const results: StructuralAuditResult[] = [];

  for (const task of domainTasks) {
    const result = await runStructuralAudit(task.id, planFile, projectRoot);
    results.push(result);
  }

  return results;
}

/**
 * Format structural audit results as a human-readable report.
 */
export function formatStructuralReport(results: StructuralAuditResult[]): string {
  if (results.length === 0) {
    return 'No audit results.';
  }

  const lines: string[] = [];
  lines.push(`STRUCTURAL AUDIT — ${results.length} tasks`);
  lines.push('='.repeat(60));
  lines.push('');

  let passCount = 0;
  for (const result of results) {
    const status = result.passed ? 'PASS' : 'FAIL';
    const icon = result.passed ? '✓' : '✗';

    lines.push(`${icon} ${result.taskId.padEnd(6)} ${status.padEnd(6)} ${result.summary}`);

    if (!result.passed) {
      // Show details for failures
      const checks = result.checks;
      if (checks.filesExist.missing.length > 0) {
        lines.push(`         Missing files: ${checks.filesExist.missing.join(', ')}`);
      }
      if (checks.exportsFound.missing.length > 0) {
        lines.push(`         Missing exports: ${checks.exportsFound.missing.join(', ')}`);
      }
      if (!checks.ownershipValid) {
        lines.push(`         Ownership violation detected`);
      }
      if (!checks.commitFound) {
        lines.push(`         Commit not found`);
      }
    } else {
      passCount++;
    }
  }

  lines.push('');
  lines.push('='.repeat(60));
  lines.push(`RESULT: ${passCount}/${results.length} tasks passed.${passCount === results.length ? ' All clear.' : ` ${results.length - passCount} FAILURE(S).`}`);

  return lines.join('\n');
}
