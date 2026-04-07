import { execSync } from 'node:child_process';
import type { SastFinding } from './types.js';

export function runSastOnModifiedFiles(
  worktreePath: string,
  modifiedFiles: string[],
  config: { rulesets: string[] },
): SastFinding[] {
  if (modifiedFiles.length === 0) return [];

  const rulesets = config.rulesets.length > 0
    ? config.rulesets
    : ['p/owasp-top-ten', 'p/security-audit'];

  const ruleArgs = rulesets.map(r => `--config=${r}`).join(' ');
  const fileArgs = modifiedFiles.join(' ');

  try {
    const output = execSync(
      `semgrep ${ruleArgs} --json --quiet ${fileArgs}`,
      { cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const result = JSON.parse(output);
    return (result.results || []).map((r: any) => ({
      file: r.path,
      line: r.start?.line,
      rule: r.check_id,
      severity: r.extra?.severity || 'warning',
      message: r.extra?.message || r.check_id,
      category: r.extra?.metadata?.category || 'security',
    }));
  } catch {
    return [];
  }
}
