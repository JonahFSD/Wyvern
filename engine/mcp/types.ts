export interface QualityGateResult {
  passed: boolean;
  reason: string;
  checks: Array<{ name: string; passed: boolean; message: string }>;
}
