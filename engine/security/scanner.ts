import type Database from 'better-sqlite3';
import { scanSecretsInDiff } from './secrets.js';
import { runSastOnModifiedFiles } from './sast.js';
import { shouldAuditDependencies, auditNpmDependencies, auditPipDependencies } from './dependencies.js';
import type { SecurityConfig, SecurityScanResult, SecretFinding, SastFinding, DependencyFinding } from './types.js';
import { appendEvent, getLastEvent } from '../store/events.js';
import { applyEvent } from '../store/projections.js';
import type { WyvernEvent } from '../store/events.js';

function nextSecuritySeq(db: Database.Database, streamId: string): { sequence: number; previousId: number | null } {
  const last = getLastEvent(db, streamId);
  return { sequence: (last?.sequence ?? 0) + 1, previousId: last?.id ?? null };
}

function persistSecurityEvent(db: Database.Database, event: Omit<WyvernEvent, 'id'>): void {
  const eventId = appendEvent(db, event);
  applyEvent(db, { ...event, id: eventId } as WyvernEvent);
}

export async function runSecurityScan(
  taskId: string,
  worktreePath: string,
  diffBase: string,
  modifiedFiles: string[],
  config: SecurityConfig,
  db: Database.Database,
): Promise<SecurityScanResult> {
  if (!config.enabled) {
    return { passed: true, secretFindings: [], sastFindings: [], dependencyFindings: [], summary: 'Security scanning disabled' };
  }

  const streamId = `security:${taskId}`;

  const secretFindings = scanSecretsInDiff(worktreePath, diffBase);
  const filteredSecrets = secretFindings.filter(f =>
    !config.allowedSecretPatterns.some(p => new RegExp(p).test(f.match))
  );

  // Persist each secret finding as an event
  for (const finding of filteredSecrets) {
    const { sequence, previousId } = nextSecuritySeq(db, streamId);
    persistSecurityEvent(db, {
      stream_id: streamId, sequence, previous_id: previousId,
      type: 'security_secret_detected',
      payload: {
        taskId, scanType: 'secrets', severity: finding.severity,
        rule: finding.rule, filePath: finding.file, lineNumber: finding.line,
        message: finding.description,
      },
      timestamp: new Date().toISOString(), actor: 'scanner',
    });
  }

  const sastFindings = runSastOnModifiedFiles(worktreePath, modifiedFiles, { rulesets: config.semgrepRulesets });
  const sastErrors = sastFindings.filter(f => f.severity === 'error');

  // Persist each SAST finding as an event
  for (const finding of sastFindings) {
    const { sequence, previousId } = nextSecuritySeq(db, streamId);
    persistSecurityEvent(db, {
      stream_id: streamId, sequence, previous_id: previousId,
      type: 'security_sast_finding',
      payload: {
        taskId, scanType: 'sast', severity: finding.severity,
        rule: finding.rule, filePath: finding.file, lineNumber: finding.line,
        message: finding.message,
      },
      timestamp: new Date().toISOString(), actor: 'scanner',
    });
  }

  let dependencyFindings: DependencyFinding[] = [];
  if (shouldAuditDependencies(modifiedFiles)) {
    const hasPackageJson = modifiedFiles.some(f => f.endsWith('package.json') || f.endsWith('package-lock.json'));
    const hasPythonDeps = modifiedFiles.some(f => f.endsWith('requirements.txt') || f.endsWith('pyproject.toml'));
    if (hasPackageJson) dependencyFindings.push(...auditNpmDependencies(worktreePath));
    if (hasPythonDeps) dependencyFindings.push(...auditPipDependencies(worktreePath));
  }
  const criticalDeps = dependencyFindings.filter(f => f.severity === 'critical');

  // Persist each dependency vulnerability as an event
  for (const finding of dependencyFindings) {
    const { sequence, previousId } = nextSecuritySeq(db, streamId);
    persistSecurityEvent(db, {
      stream_id: streamId, sequence, previous_id: previousId,
      type: 'security_dep_vulnerability',
      payload: {
        taskId, scanType: 'dependencies', severity: finding.severity,
        rule: `${finding.package}@${finding.version}`, filePath: null, lineNumber: null,
        message: `${finding.vulnerability}${finding.fixAvailable ? ` (fix: ${finding.fixAvailable})` : ''}`,
      },
      timestamp: new Date().toISOString(), actor: 'scanner',
    });
  }

  const blocked =
    (config.blockOnSecrets && filteredSecrets.length > 0) ||
    (config.blockOnSastErrors && sastErrors.length > 0) ||
    (config.blockOnCriticalDeps && criticalDeps.length > 0);

  const parts: string[] = [];
  if (filteredSecrets.length > 0) parts.push(`${filteredSecrets.length} secret(s)`);
  if (sastErrors.length > 0) parts.push(`${sastErrors.length} SAST error(s)`);
  if (criticalDeps.length > 0) parts.push(`${criticalDeps.length} critical dep vuln(s)`);

  // Persist scan summary event
  const { sequence: sumSeq, previousId: sumPrev } = nextSecuritySeq(db, streamId);
  persistSecurityEvent(db, {
    stream_id: streamId, sequence: sumSeq, previous_id: sumPrev,
    type: 'security_scan_completed',
    payload: {
      taskId, passed: !blocked,
      secretCount: filteredSecrets.length, sastCount: sastErrors.length, depCount: criticalDeps.length,
      summary: blocked ? `BLOCKED: ${parts.join(', ')}` : 'Clean',
    },
    timestamp: new Date().toISOString(), actor: 'scanner',
  });

  return {
    passed: !blocked,
    secretFindings: filteredSecrets,
    sastFindings,
    dependencyFindings,
    summary: blocked
      ? `BLOCKED: ${parts.join(', ')}`
      : parts.length > 0
        ? `PASSED with warnings: ${parts.join(', ')}`
        : 'Clean',
  };
}
