#!/usr/bin/env node

/**
 * cli.ts — Wyvern entry point.
 *
 * Loads the project profile from wyvern.config.json, then delegates
 * to the universal engine. The CLI itself has no project-type knowledge.
 */

import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadProfile } from './profiles/profile.js';
import type { WyvernProfile } from './profiles/profile.js';

const USAGE = `
wyvern — Deterministic AI task orchestrator

Usage:
  wyvern run <task-dir> [options]     Execute the loop
  wyvern lint <task-dir>              Lint all prompts in a task
  wyvern new <task-name> <n>          Scaffold a new task with N prompts
  wyvern audit <task-dir> [type]      Run a standalone audit (diff|tech-debt|security)
  wyvern maintain                     Run the maintenance agent
  wyvern costs [--summary]            Show cost tracking data
  wyvern trend                        Show audit trend
  wyvern pin                          Regenerate the codebase index
  wyvern init <profile>               Initialize wyvern for a project
  wyvern profiles                     List available profiles

  wyvern status                       Current task states
  wyvern history                      Past runs
  wyvern events [--stream X]          Raw event log
  wyvern replay <taskId>              Events for a task
  wyvern context                      Context key-value pairs
  wyvern cache-stats                  Cache statistics

  wyvern swarm plan <spec>            Parse spec, show plan + cost estimate
  wyvern swarm validate <spec>        Validate dependency graph
  wyvern swarm run <spec> [--dry-run] Generate launch script for Agent Teams
  wyvern swarm cost <spec>            Detailed cost breakdown

Run Options:
  --dry-run         Show plan without executing
  --skip-lint       Skip prompt linting
  --skip-audit      Skip post-execution audit
  --skip-snapshots  Skip git checkpoints

Profiles:
  web-app              React/Next.js/FastAPI with npm pipelines
  research-pipeline    ML/research with Python scripts and artifacts

Examples:
  wyvern init research-pipeline
  wyvern new retrieval-pipeline 5
  wyvern lint AGENTS/retrieval-pipeline
  wyvern run AGENTS/retrieval-pipeline
  wyvern pin
  wyvern swarm plan docs/spec.md
`.trim();

async function getProfile(projectRoot: string): Promise<WyvernProfile | null> {
  try {
    const configPath = join(projectRoot, 'wyvern.config.json');
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw);
    if (config.profile) {
      return await loadProfile(config.profile);
    }
  } catch { /* no config or no profile field */ }
  return null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const command = args[0];
  const projectRoot = resolve('.');

  switch (command) {
    case 'profiles': {
      console.log('Available profiles:');
      console.log('  web-app              React/Next.js/FastAPI with npm pipelines');
      console.log('  research-pipeline    ML/research with Python scripts and artifacts');
      break;
    }

    case 'init': {
      const profileName = args[1];
      if (!profileName) {
        console.error('Usage: wyvern init <profile>');
        console.error('Run "wyvern profiles" to see available profiles.');
        process.exit(1);
      }
      const profile = await loadProfile(profileName);

      // Write config
      const config = {
        profile: profile.name,
        ...profile.defaults,
        verifyCommands: profile.defaultVerifyCommands,
      };
      const { writeFile, mkdir } = await import('node:fs/promises');
      await writeFile(
        join(projectRoot, 'wyvern.config.json'),
        JSON.stringify(config, null, 2) + '\n',
        'utf-8',
      );

      // Create AGENTS directory structure
      const agentsDir = join(projectRoot, 'AGENTS');
      await mkdir(join(agentsDir, 'templates'), { recursive: true });
      await mkdir(join(agentsDir, 'audits'), { recursive: true });
      await mkdir(join(agentsDir, 'logs'), { recursive: true });

      console.log(`Initialized wyvern with profile: ${profile.name}`);
      console.log(`  Config: wyvern.config.json`);
      console.log(`  Agents: AGENTS/`);
      console.log(`\nNext steps:`);
      console.log(`  1. Review wyvern.config.json`);
      console.log(`  2. Ensure CLAUDE.md exists at project root (for AI worker context)`);
      console.log(`  3. Run "wyvern pin" to generate the codebase index`);
      console.log(`  4. Run "wyvern new <task-name> <n>" to create your first task`);
      break;
    }

    case 'run': {
      const planSource = resolveArg(args[1], 'plan source');
      const { executeLoop } = await import('./engine/executor.js');
      await executeLoop(planSource, {
        skipLint: args.includes('--skip-lint'),
        skipAudit: args.includes('--skip-audit'),
        skipSnapshots: args.includes('--skip-snapshots'),
        projectRoot,
      });
      console.log('Run complete. Use "wyvern status" for details.');
      break;
    }

    case 'lint': {
      const taskDir = resolveArg(args[1], 'task directory');
      const { lintAllPrompts, formatLintResults } = await import('./engine/prompt-linter.js');
      const { loadConfig } = await import('./engine/config.js');
      const config = await loadConfig(projectRoot);
      const results = await lintAllPrompts(taskDir, config);
      console.log(formatLintResults(results));
      const hasErrors = results.some(r => !r.valid);
      process.exit(hasErrors ? 1 : 0);
    }

    case 'new': {
      const taskName = args[1];
      const numPrompts = parseInt(args[2], 10);
      if (!taskName || isNaN(numPrompts) || numPrompts < 1) {
        console.error('Usage: wyvern new <task-name> <num-prompts>');
        process.exit(1);
      }
      const agentsDir = resolve('AGENTS');
      const { scaffoldTask, formatScaffoldResult } = await import('./engine/scaffold.js');
      const taskDir = await scaffoldTask(agentsDir, taskName, numPrompts);
      console.log(formatScaffoldResult(taskDir, taskName, numPrompts));
      break;
    }

    case 'audit': {
      const taskDir = resolveArg(args[1], 'task directory');
      const auditType = (args[2] ?? 'diff') as 'diff' | 'tech-debt' | 'security';
      const agentsDir = resolve(taskDir, '..');
      const { runAudit, appendAuditTrend } = await import('./engine/audit.js');
      const { loadConfig } = await import('./engine/config.js');
      const config = await loadConfig(projectRoot);
      const logsDir = join(agentsDir, 'logs');
      const trendFile = join(logsDir, 'audit-trend.csv');
      const result = await runAudit(taskDir, auditType, agentsDir, config);
      await appendAuditTrend(result, trendFile);
      console.log(`Audit complete: ${result.verdict} (${result.findingsCount} findings)`);
      break;
    }

    case 'maintain': {
      const agentsDir = resolve('AGENTS');
      const { runMaintenance } = await import('./engine/maintenance.js');
      const { loadConfig } = await import('./engine/config.js');
      const config = await loadConfig(projectRoot);
      const report = await runMaintenance(projectRoot, agentsDir, config);
      console.log(`Maintenance complete:`);
      console.log(`  Pin regenerated: ${report.pinRegenerated}`);
      console.log(`  Prompts linted: ${report.promptsLinted}`);
      console.log(`  Issues: ${report.issuesFound.length}`);
      break;
    }

    case 'costs': {
      const logsDir = resolve('AGENTS/logs');
      const costFile = join(logsDir, 'cost-tracking.jsonl');
      const { getCostSummary, formatCostSummary } = await import('./engine/cost-tracker.js');
      const summary = await getCostSummary(costFile);
      console.log(formatCostSummary(summary));
      break;
    }

    case 'trend': {
      const logsDir = resolve('AGENTS/logs');
      const trendFile = join(logsDir, 'audit-trend.csv');
      const { getAuditTrend, formatTrendReport } = await import('./engine/audit.js');
      const results = await getAuditTrend(trendFile);
      console.log(formatTrendReport(results));
      break;
    }

    case 'pin': {
      const profile = await getProfile(projectRoot);
      if (profile) {
        const pin = await profile.generatePin(projectRoot);
        const { writeFile, mkdir } = await import('node:fs/promises');
        const pinFile = resolve('AGENTS/pin.md');
        await mkdir(resolve('AGENTS'), { recursive: true });
        await writeFile(pinFile, pin, 'utf-8');
        console.log(`Pin regenerated using ${profile.name} profile: ${pinFile}`);
      } else {
        // Fallback to legacy pin generator
        const pinFile = resolve('AGENTS/pin.md');
        const { generatePin } = await import('./profiles/pin-generator.js');
        await generatePin(projectRoot, pinFile);
        console.log(`Pin regenerated (no profile): ${pinFile}`);
      }
      break;
    }

    case 'status': {
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const rows = db.prepare('SELECT task_id, status, model, duration_ms, cost_usd FROM task_state ORDER BY task_id').all() as any[];
      if (rows.length === 0) {
        console.log('No tasks found.');
      } else {
        console.log('Task Status:');
        for (const r of rows) {
          const dur = r.duration_ms ? `${(r.duration_ms / 1000).toFixed(0)}s` : '-';
          const cost = r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '-';
          console.log(`  ${r.task_id}  ${r.status.padEnd(12)} ${r.model.padEnd(8)} ${dur.padStart(6)}  ${cost}`);
        }
      }
      db.close();
      break;
    }

    case 'history': {
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 10').all() as any[];
      if (runs.length === 0) {
        console.log('No runs found.');
      } else {
        console.log('Recent Runs:');
        for (const r of runs) {
          console.log(`  Run #${r.id}  started: ${r.started_at}  tasks: ${r.total_tasks}`);
        }
      }
      db.close();
      break;
    }

    case 'events': {
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const streamFilter = args.find(a => a.startsWith('--stream='))?.split('=')[1];
      let events: any[];
      if (streamFilter) {
        events = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY id DESC LIMIT 50').all(streamFilter);
      } else {
        events = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50').all();
      }
      if (events.length === 0) {
        console.log('No events found.');
      } else {
        for (const e of events) {
          console.log(`  #${e.id} [${e.timestamp}] ${e.type} (${e.stream_id})`);
        }
      }
      db.close();
      break;
    }

    case 'replay': {
      const taskId = args[1];
      if (!taskId) { console.error('Usage: wyvern replay <taskId>'); process.exit(1); }
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const events = db.prepare('SELECT * FROM events WHERE stream_id = ? ORDER BY sequence ASC').all(`task:${taskId}`) as any[];
      if (events.length === 0) {
        console.log(`No events for task ${taskId}.`);
      } else {
        console.log(`Events for task ${taskId}:`);
        for (const e of events) {
          console.log(`  seq ${e.sequence}: ${e.type} at ${e.timestamp}`);
          console.log(`    ${e.payload}`);
        }
      }
      db.close();
      break;
    }

    case 'context': {
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const rows = db.prepare('SELECT * FROM context ORDER BY key').all() as any[];
      if (rows.length === 0) {
        console.log('No context entries.');
      } else {
        for (const r of rows) {
          console.log(`  ${r.key} = ${r.value} (by ${r.written_by}, v${r.version})`);
        }
      }
      db.close();
      break;
    }

    case 'cache-stats': {
      const { openDatabase } = await import('./engine/store/db.js');
      const { initializeSchema } = await import('./engine/store/schema.js');
      const { getCacheStats } = await import('./engine/cache/store.js');
      const dbPath = join(projectRoot, '.wyvern', 'wyvern.db');
      const db = openDatabase(dbPath);
      initializeSchema(db);
      const stats = getCacheStats(db);
      console.log(`Cache Stats:`);
      console.log(`  Entries: ${stats.totalEntries}`);
      console.log(`  Hits: ${stats.totalHits}`);
      console.log(`  Savings: $${stats.savingsUsd.toFixed(4)}`);
      db.close();
      break;
    }

    case 'swarm': {
      const swarmArgs = args.slice(1);
      const { handleSwarmCommand } = await import('./swarm/cli.js');
      await handleSwarmCommand(swarmArgs, projectRoot);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
}

function resolveArg(arg: string | undefined, label: string): string {
  if (!arg) {
    console.error(`Missing required argument: ${label}`);
    process.exit(1);
  }
  return resolve(arg);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
