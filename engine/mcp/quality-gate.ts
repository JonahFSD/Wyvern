import { execSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import type { WyvernConfig } from '../types.js';
import type { QualityGateResult } from './types.js';
import { runSecurityScan } from '../security/scanner.js';
import { DEFAULT_SECURITY_CONFIG } from '../security/types.js';

export async function runQualityGates(
  taskId: string,
  db: Database.Database,
  config: WyvernConfig,
): Promise<QualityGateResult> {
  const checks: QualityGateResult['checks'] = [];

  // 1. Run verification commands
  for (const cmd of (config.verifyCommands ?? [])) {
    try {
      execSync(cmd, { cwd: (config as any).projectRoot ?? process.cwd(), stdio: 'pipe' });
      checks.push({ name: `verify: ${cmd}`, passed: true, message: 'passed' });
    } catch {
      checks.push({ name: `verify: ${cmd}`, passed: false, message: 'command failed' });
      return { passed: false, reason: `Verification failed: ${cmd}`, checks };
    }
  }

  // 2. File ownership — compare declared files against actual changes
  const task = db.prepare('SELECT * FROM task_state WHERE task_id = ?').get(taskId) as any;
  const worktreePath = process.env.WYVERN_WORKTREE ?? (config as any).projectRoot ?? process.cwd();
  const diffBase = process.env.WYVERN_TASK_START_SHA ?? 'HEAD~1';

  let modifiedFiles: string[] = [];
  try {
    modifiedFiles = execSync(`git diff --name-only ${diffBase}..HEAD`, {
      cwd: worktreePath, encoding: 'utf-8',
    }).trim().split('\n').filter(Boolean);
  } catch {
    // No git diff available
  }

  // 3. touchesFiles validation
  if (modifiedFiles.length > 0) {
    const declaredFiles = db.prepare(
      'SELECT file_path FROM file_reservations WHERE task_id = ? AND released_at IS NULL'
    ).all(taskId).map((r: any) => r.file_path);

    const undeclaredFiles = modifiedFiles.filter(f => !declaredFiles.includes(f));
    if (undeclaredFiles.length > 0 && declaredFiles.length > 0) {
      checks.push({
        name: 'touchesFiles',
        passed: false,
        message: `Agent modified undeclared files: ${undeclaredFiles.join(', ')}`,
      });
      return { passed: false, reason: `Undeclared files modified: ${undeclaredFiles.join(', ')}`, checks };
    }
    checks.push({ name: 'touchesFiles', passed: true, message: 'all modified files declared' });
  }

  // 4-7. Security scanning
  const securityConfig = (config as any).security ?? DEFAULT_SECURITY_CONFIG;
  const securityResult = await runSecurityScan(
    taskId, worktreePath, diffBase, modifiedFiles, securityConfig, db,
  );

  checks.push({
    name: 'Secret Scan',
    passed: securityResult.secretFindings.length === 0 || !securityConfig.blockOnSecrets,
    message: securityResult.secretFindings.length === 0
      ? 'no secrets detected'
      : `${securityResult.secretFindings.length} finding(s)`,
  });

  checks.push({
    name: 'SAST',
    passed: securityResult.sastFindings.filter(f => f.severity === 'error').length === 0 || !securityConfig.blockOnSastErrors,
    message: securityResult.sastFindings.length === 0
      ? 'no issues'
      : `${securityResult.sastFindings.length} finding(s)`,
  });

  checks.push({
    name: 'Dependency Audit',
    passed: securityResult.dependencyFindings.filter(f => f.severity === 'critical').length === 0 || !securityConfig.blockOnCriticalDeps,
    message: securityResult.dependencyFindings.length === 0
      ? 'no vulnerabilities'
      : `${securityResult.dependencyFindings.length} finding(s)`,
  });

  const failed = checks.filter(c => !c.passed);
  return {
    passed: failed.length === 0,
    reason: failed.length > 0 ? failed.map(c => `${c.name}: ${c.message}`).join('; ') : '',
    checks,
  };
}
