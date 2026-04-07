import { readdir, stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WyvernConfig, MaintenanceReport, LintIssue } from './types.js';
import { generatePin } from '../profiles/pin-generator.js';
import { lintAllPrompts } from './prompt-linter.js';
import { getAuditTrend, formatTrendReport } from './audit.js';
import { createLogger } from './logger.js';

export async function runMaintenance(
  projectRoot: string,
  agentsDir: string,
  config: WyvernConfig,
): Promise<MaintenanceReport> {
  const logsDir = join(agentsDir, 'logs');
  const logger = createLogger(logsDir);
  const timestamp = new Date().toISOString();

  logger.info('maintenance-start', { projectRoot });

  // Step 1: Regenerate the pin
  let pinRegenerated = false;
  try {
    const pinFile = join(agentsDir, 'initialization', 'README.md');
    await generatePin(projectRoot, pinFile);
    pinRegenerated = true;
    logger.info('pin-regenerated', { output: pinFile });
  } catch (err) {
    logger.error('pin-regeneration-failed', { error: String(err) });
  }

  // Step 2: Lint all active prompts
  const allIssues: LintIssue[] = [];
  let promptsLinted = 0;
  const taskDirs = await findActiveTaskDirs(agentsDir);

  for (const taskDir of taskDirs) {
    try {
      const results = await lintAllPrompts(taskDir, config);
      for (const result of results) {
        promptsLinted++;
        allIssues.push(...result.errors, ...result.warnings);
      }
    } catch (err) {
      logger.warn('lint-failed', { taskDir, error: String(err) });
    }
  }
  logger.info('prompts-linted', { count: promptsLinted, issues: allIssues.length });

  // Step 3: Read audit trend
  const trendFile = join(logsDir, 'audit-trend.csv');
  const trend = await getAuditTrend(trendFile);
  const trendReport = formatTrendReport(trend);

  const recent = trend.slice(-5);
  const passRate = recent.length > 0
    ? recent.filter(r => r.verdict === 'PASS').length / recent.length
    : 1;

  const improving = passRate >= 0.6;

  // Step 4: Check for stale context.md files
  const recommendations: string[] = [];
  const staleThreshold = 7 * 24 * 60 * 60 * 1000; // 7 days

  for (const taskDir of taskDirs) {
    const contextFile = join(taskDir, 'context.md');
    try {
      const stats = await stat(contextFile);
      const age = Date.now() - stats.mtime.getTime();
      if (age > staleThreshold) {
        recommendations.push(
          `Stale context.md in ${taskDir} (${Math.floor(age / 86400000)} days old). Consider archiving this task.`
        );
      }
    } catch {
      // No context.md
    }
  }

  // Step 5: Check CLAUDE.md exists and has content
  try {
    const claudeMd = await readFile(join(agentsDir, 'initialization', 'CLAUDE.md'), 'utf-8');
    if (claudeMd.includes('<!-- Update this section')) {
      recommendations.push('CLAUDE.md contains unfilled template sections. Update with actual project conventions.');
    }
  } catch {
    recommendations.push('No CLAUDE.md found in initialization/. Create one with project conventions.');
  }

  // Generate recommendations from lint issues
  const errorCount = allIssues.filter(i => i.severity === 'error').length;
  if (errorCount > 0) {
    recommendations.push(`${errorCount} prompt lint errors found. Fix before next run.`);
  }

  if (!improving && trend.length >= 3) {
    recommendations.push('Audit pass rate declining. Review recent prompt quality and task scope.');
  }

  const report: MaintenanceReport = {
    timestamp,
    pinRegenerated,
    promptsLinted,
    issuesFound: allIssues,
    auditTrend: { improving, details: trendReport },
    recommendations,
  };

  // Write report
  const reportContent = formatMaintenanceReport(report);
  const auditsDir = join(agentsDir, 'audits');
  const reportTimestamp = timestamp.replace(/[:.]/g, '').slice(0, 15);
  const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('node:fs/promises');
  await mkdirAsync(auditsDir, { recursive: true });
  await writeFileAsync(
    join(auditsDir, `maintenance-${reportTimestamp}.md`),
    reportContent,
    'utf-8',
  );

  logger.info('maintenance-complete', {
    pinRegenerated,
    promptsLinted,
    issues: allIssues.length,
    recommendations: recommendations.length,
  });

  await logger.close();
  return report;
}

async function findActiveTaskDirs(agentsDir: string): Promise<string[]> {
  const dirs: string[] = [];

  try {
    const items = await readdir(agentsDir, { withFileTypes: true });
    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (['initialization', 'reusable', 'archive', 'audits', 'logs'].includes(item.name)) continue;

      const taskDir = join(agentsDir, item.name);
      try {
        await stat(join(taskDir, 'PLAN.md'));
        dirs.push(taskDir);
      } catch {
        // Not a task directory
      }
    }
  } catch {
    // agents dir doesn't exist
  }

  return dirs;
}

function formatMaintenanceReport(report: MaintenanceReport): string {
  const lines = [
    `# Maintenance Report — ${report.timestamp.slice(0, 10)}`,
    '',
    '## Summary',
    '',
    `- Pin regenerated: ${report.pinRegenerated ? 'Yes' : 'No'}`,
    `- Prompts linted: ${report.promptsLinted}`,
    `- Issues found: ${report.issuesFound.length}`,
    `- Recommendations: ${report.recommendations.length}`,
    '',
  ];

  if (report.issuesFound.length > 0) {
    lines.push('## Lint Issues', '');
    const errors = report.issuesFound.filter(i => i.severity === 'error');
    const warnings = report.issuesFound.filter(i => i.severity === 'warning');

    if (errors.length > 0) {
      lines.push(`### Errors (${errors.length})`, '');
      for (const err of errors) {
        lines.push(`- **[${err.rule}]** ${err.message}`);
      }
      lines.push('');
    }

    if (warnings.length > 0) {
      lines.push(`### Warnings (${warnings.length})`, '');
      for (const warn of warnings) {
        lines.push(`- **[${warn.rule}]** ${warn.message}`);
      }
      lines.push('');
    }
  }

  lines.push('## Audit Trend', '', report.auditTrend.details, '');

  if (report.recommendations.length > 0) {
    lines.push('## Recommendations', '');
    for (const rec of report.recommendations) {
      lines.push(`- ${rec}`);
    }
    lines.push('');
  }

  lines.push(`## Verdict`, '');
  lines.push(
    report.issuesFound.filter(i => i.severity === 'error').length > 0
      ? 'NEEDS ATTENTION'
      : report.recommendations.length > 0
        ? 'PASS WITH RECOMMENDATIONS'
        : 'PASS',
  );

  return lines.join('\n');
}
