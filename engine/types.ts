export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'timeout' | 'skipped';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

export interface Task {
  lineNumber: number;
  taskNumber: string;
  description: string;
  status: TaskStatus;
  gate: number;
  model: ModelTier;
  dependsOn: string[];
  promptFile?: string;
}

export interface Gate {
  number: number;
  tasks: Task[];
}

export interface ExecutionPlan {
  gates: Gate[];
  totalTasks: number;
  taskDir: string;
}

export interface LintIssue {
  rule: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface LintResult {
  file: string;
  errors: LintIssue[];
  warnings: LintIssue[];
  lineCount: number;
  valid: boolean;
}

export interface PromptSections {
  context?: string;
  goal?: string;
  filesToModify?: string[];
  specificChanges?: string;
  doNot?: string;
  verify?: string;
}

export interface TaskResult {
  task: Task;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  status: TaskStatus;
  exitCode: number | null;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  outputLogFile: string;
}

export interface AuditResult {
  timestamp: string;
  taskDir: string;
  auditType: 'diff' | 'tech-debt' | 'security';
  verdict: 'PASS' | 'PASS WITH WARNINGS' | 'NEEDS FIXES';
  riskScore?: number;
  findingsCount: number;
}

export interface WyvernConfig {
  pollInterval: number;
  killDelay: number;
  watchdogTimeout: number;
  maxPromptLines: { min: number; max: number };
  defaultModel: ModelTier;
  verifyCommands: string[];
  enableSnapshots: boolean;
  enableCostTracking: boolean;
  enableOutputCapture: boolean;
  parallelTasksPerGate: number;
  maintenanceSchedule?: string;
  mcpPort?: number;
  budgetLimitUsd?: number;
  modelConfig: Record<ModelTier, { maxPromptLines: { min: number; max: number } }>;
}

export interface MaintenanceReport {
  timestamp: string;
  pinRegenerated: boolean;
  promptsLinted: number;
  issuesFound: LintIssue[];
  auditTrend: { improving: boolean; details: string };
  recommendations: string[];
}

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  data?: Record<string, unknown>;
}

export interface ExecuteOptions {
  dryRun?: boolean;
  skipLint?: boolean;
  skipAudit?: boolean;
  skipSnapshots?: boolean;
  projectRoot?: string;
}

export interface CostRecord {
  timestamp: string;
  taskNumber: string;
  model: ModelTier;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface CostSummary {
  totalCost: number;
  taskCount: number;
  avgCostPerTask: number;
  byModel: Record<string, number>;
}

export interface BudgetEstimate {
  totalTokens: number;
  breakdown: Record<string, number>;
  warning: string | null;
}

/** Persisted execution state for crash recovery. Written after each batch. */
export interface ExecutionState {
  taskDir: string;
  startedAt: string;
  updatedAt: string;
  completedTasks: string[];
  failedTasks: string[];
  timedOutTasks: string[];
  results: Array<{
    taskNumber: string;
    status: TaskStatus;
    durationMs: number;
    costUsd?: number;
    promptTokens?: number;
    completionTokens?: number;
  }>;
}

export interface StructuralAuditResult {
  taskId: string;
  timestamp: string;
  checks: {
    filesExist: { expected: string[]; found: string[]; missing: string[] };
    exportsFound: { expected: string[]; found: string[]; missing: string[] };
    ownershipValid: boolean;
    commitFound: boolean;
    commitSha?: string;
  };
  passed: boolean; // true only if ALL checks pass
  summary: string; // human-readable one-liner
}
