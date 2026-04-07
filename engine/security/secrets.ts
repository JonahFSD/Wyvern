import { execSync } from 'node:child_process';
import type { SecretFinding } from './types.js';

export function scanSecretsInDiff(
  worktreePath: string,
  diffBase: string,
): SecretFinding[] {
  try {
    const output = execSync(
      `gitleaks detect --source="${worktreePath}" --log-opts="${diffBase}..HEAD" --report-format=json --no-banner --exit-code=0`,
      { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const findings = JSON.parse(output || '[]');
    return findings.map((f: any) => ({
      file: f.File,
      line: f.StartLine,
      rule: f.RuleID,
      severity: mapGitleaksSeverity(f.RuleID),
      match: f.Match ? redact(f.Match) : '',
      description: f.Description || f.RuleID,
    }));
  } catch {
    try {
      const output = execSync(
        `betterleaks scan --diff="${diffBase}..HEAD" --format=json`,
        { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      return JSON.parse(output || '[]');
    } catch {
      return [];
    }
  }
}

function redact(match: string): string {
  if (match.length <= 8) return '***';
  return match.slice(0, 4) + '...' + match.slice(-4);
}

function mapGitleaksSeverity(ruleId: string): SecretFinding['severity'] {
  if (/private.key|aws-secret|database-url|password/i.test(ruleId)) return 'critical';
  if (/api.key|token|secret/i.test(ruleId)) return 'high';
  return 'medium';
}
