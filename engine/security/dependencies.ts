import { execSync } from 'node:child_process';
import type { DependencyFinding } from './types.js';

const DEPENDENCY_FILES = [
  'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'requirements.txt', 'pyproject.toml', 'poetry.lock', 'Pipfile.lock',
];

export function shouldAuditDependencies(modifiedFiles: string[]): boolean {
  return modifiedFiles.some(f => DEPENDENCY_FILES.some(dep => f.endsWith(dep)));
}

export function auditNpmDependencies(worktreePath: string): DependencyFinding[] {
  try {
    const output = execSync('npm audit --json 2>/dev/null', {
      cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output);
    return Object.values(result.vulnerabilities || {}).map((v: any) => ({
      package: v.name,
      version: v.range,
      vulnerability: v.title || v.via?.[0]?.title || 'Unknown',
      severity: v.severity,
      fixAvailable: v.fixAvailable?.version || null,
    }));
  } catch {
    return [];
  }
}

export function auditPipDependencies(worktreePath: string): DependencyFinding[] {
  try {
    const output = execSync('pip-audit --format=json 2>/dev/null', {
      cwd: worktreePath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output);
    return (result.dependencies || [])
      .filter((d: any) => d.vulns?.length > 0)
      .flatMap((d: any) => d.vulns.map((v: any) => ({
        package: d.name,
        version: d.version,
        vulnerability: v.id,
        severity: 'high' as DependencyFinding['severity'],
        fixAvailable: v.fix_versions?.[0] || null,
      })));
  } catch {
    return [];
  }
}
