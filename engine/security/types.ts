export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  match: string;
  description: string;
}

export interface SastFinding {
  file: string;
  line: number;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  category: string;
}

export interface DependencyFinding {
  package: string;
  version: string;
  vulnerability: string;
  severity: 'critical' | 'high' | 'moderate' | 'low';
  fixAvailable: string | null;
}

export interface ContextIntegrityResult {
  passed: boolean;
  violations: string[];
}

export interface SecurityConfig {
  enabled: boolean;
  blockOnSecrets: boolean;
  blockOnSastErrors: boolean;
  blockOnCriticalDeps: boolean;
  secretScanner: 'gitleaks' | 'betterleaks' | 'auto';
  semgrepRulesets: string[];
  allowedSecretPatterns: string[];
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  enabled: true,
  blockOnSecrets: true,
  blockOnSastErrors: true,
  blockOnCriticalDeps: true,
  secretScanner: 'auto',
  semgrepRulesets: ['p/owasp-top-ten', 'p/security-audit'],
  allowedSecretPatterns: [],
};

export interface SecurityScanResult {
  passed: boolean;
  secretFindings: SecretFinding[];
  sastFindings: SastFinding[];
  dependencyFindings: DependencyFinding[];
  summary: string;
}
