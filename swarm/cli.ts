/**
 * swarm/cli.ts — Entry point for `wyvern swarm` commands.
 * Wires Wyvern's spec parsing to Agent Teams execution.
 *
 * Commands:
 *   wyvern swarm plan <spec-path>     Parse spec, show the plan, estimate cost
 *   wyvern swarm validate <spec-path> Validate the spec's dependency graph
 *   wyvern swarm run <spec-path>      Generate plan and launch the agent team
 *   wyvern swarm cost <spec-path>     Show detailed cost breakdown
 *   wyvern swarm audit <domain>       Run structural audit for a domain
 */

import { resolve } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { generateSwarmPlan, formatSwarmPlan, parseTasks } from './wyvern.js';
import { validateGraph, formatGraph } from './dependency-graph.js';
import { generateTeamScript, generateHooksConfig } from './agent-teams-adapter.js';
import { loadConfig } from '../engine/config.js';
import { runDomainAudit, formatStructuralReport } from '../engine/audit.js';
import type { SwarmPlan } from './types.js';

export async function handleSwarmCommand(args: string[], projectRoot: string): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case 'plan': {
      const specPath = resolveSpecPath(args[1]);
      const plan = await generateSwarmPlan(specPath);
      console.log(formatSwarmPlan(plan));
      break;
    }

    case 'validate': {
      const specPath = resolveSpecPath(args[1]);
      const raw = await readFile(resolve(specPath), 'utf-8');
      const { body } = splitFrontmatterQuick(raw);
      const tasks = parseTasks(body);
      const result = validateGraph(tasks);

      if (result.valid) {
        console.log('\x1b[32m✓\x1b[0m Dependency graph is valid');
        console.log(`  ${tasks.length} tasks, no cycles, no file conflicts`);
      } else {
        console.log('\x1b[31m✗\x1b[0m Dependency graph has errors:');
        for (const error of result.errors) {
          console.log(`  - ${error}`);
        }
        process.exit(1);
      }

      console.log('\n' + formatGraph(tasks));
      break;
    }

    case 'run': {
      const specPath = resolveSpecPath(args[1]);
      const dryRun = args.includes('--dry-run');

      console.log('Parsing spec...');
      const plan = await generateSwarmPlan(specPath);

      console.log(formatSwarmPlan(plan));
      console.log('');

      if (dryRun) {
        console.log('DRY RUN — generating team script without executing\n');
      }

      const config = await loadConfig(projectRoot);

      // Generate the Agent Teams launch script
      const script = generateTeamScript(plan, projectRoot, config.verifyCommands);
      const hooksConfig = generateHooksConfig(projectRoot);

      // Write artifacts
      const swarmDir = resolve(projectRoot, '.swarm');
      await mkdir(swarmDir, { recursive: true });

      const scriptPath = resolve(swarmDir, 'launch.md');
      await writeFile(scriptPath, script, 'utf-8');
      console.log(`Team launch script: ${scriptPath}`);

      const hooksPath = resolve(swarmDir, 'hooks.json');
      await writeFile(hooksPath, JSON.stringify(hooksConfig, null, 2), 'utf-8');
      console.log(`Hooks config: ${hooksPath}`);

      // Write the plan as JSON for programmatic access
      const planPath = resolve(swarmDir, 'plan.json');
      await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf-8');
      console.log(`Plan data: ${planPath}`);

      if (!dryRun) {
        console.log('\n' + '='.repeat(60));
        console.log('READY TO LAUNCH');
        console.log('='.repeat(60));
        console.log('');
        console.log('To start the swarm:');
        console.log('');
        console.log('  1. Enable Agent Teams:');
        console.log('     Add CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 to settings');
        console.log('');
        console.log('  2. Start Claude Code and paste the launch script:');
        console.log(`     cat ${scriptPath}`);
        console.log('');
        console.log('  3. Claude will create the team, spawn domain leads,');
        console.log('     and start executing the task graph.');
        console.log('');
        console.log(`Estimated cost: $${plan.estimatedCost.toFixed(2)}`);
        console.log(`Estimated time: ~${plan.stats.estimatedMinutes} min on critical path`);
      }

      break;
    }

    case 'cost': {
      const specPath = resolveSpecPath(args[1]);
      const plan = await generateSwarmPlan(specPath);
      printCostBreakdown(plan);
      break;
    }

    case 'audit': {
      const domainName = args[1];
      if (!domainName) {
        console.error('Missing required argument: domain name');
        console.log(SWARM_USAGE);
        process.exit(1);
      }

      const planPath = findPlanFile(args, projectRoot);
      if (!planPath) {
        console.error('Could not find .swarm/plan.json. Run `wyvern swarm run` first to generate the plan.');
        process.exit(1);
      }

      console.log(`Running structural audit for domain: ${domainName}`);
      console.log('');

      const results = await runDomainAudit(domainName, planPath, projectRoot);

      if (results.length === 0) {
        console.log(`No tasks found for domain: ${domainName}`);
        process.exit(0);
      }

      console.log(formatStructuralReport(results));
      console.log('');

      // Exit with failure if any task failed
      const allPassed = results.every(r => r.passed);
      if (!allPassed) {
        process.exit(1);
      }

      break;
    }

    default:
      console.log(SWARM_USAGE);
      if (subcommand && subcommand !== '--help' && subcommand !== '-h') {
        console.error(`Unknown swarm command: ${subcommand}`);
        process.exit(1);
      }
  }
}

const SWARM_USAGE = `
wyvern swarm — Multi-domain orchestration via Agent Teams

Usage:
  wyvern swarm plan <spec-path>              Parse spec, show plan + cost estimate
  wyvern swarm validate <spec-path>          Validate dependency graph (cycles, conflicts)
  wyvern swarm run <spec-path> [--dry-run]   Generate launch script (and optionally execute)
  wyvern swarm cost <spec-path>              Detailed cost breakdown by domain + tier
  wyvern swarm audit <domain> [--plan PATH]  Run structural audit for a domain

Spec format:
  YAML frontmatter with project name, domain definitions, and model config.
  Markdown body with Foundations, Entities, and Tasks sections.
  See cmdctrl/wyvern/src/swarm/swarm-conventions.md for full spec format.

Examples:
  wyvern swarm plan docs/spec.md
  wyvern swarm validate docs/spec.md
  wyvern swarm run docs/spec.md --dry-run
  wyvern swarm cost docs/spec.md
  wyvern swarm audit frontend
  wyvern swarm audit backend --plan .swarm/plan.json
`.trim();

function resolveSpecPath(arg: string | undefined): string {
  if (!arg) {
    console.error('Missing required argument: spec path');
    console.log(SWARM_USAGE);
    process.exit(1);
  }
  return resolve(arg);
}

function findPlanFile(args: string[], projectRoot: string): string | null {
  // Check for --plan flag
  const planIndex = args.indexOf('--plan');
  if (planIndex !== -1 && planIndex + 1 < args.length) {
    const path = resolve(args[planIndex + 1]);
    return existsSync(path) ? path : null;
  }

  // Default location
  const defaultPath = resolve(projectRoot, '.swarm/plan.json');
  return existsSync(defaultPath) ? defaultPath : null;
}

/** Quick frontmatter split without full YAML parse. */
function splitFrontmatterQuick(raw: string): { body: string } {
  const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return { body: match ? match[1] : raw };
}

function printCostBreakdown(plan: SwarmPlan): void {
  console.log('COST BREAKDOWN');
  console.log('='.repeat(50));

  // By model tier
  const modelCosts: Record<string, { tasks: number; estimated: number }> = {};
  for (const task of plan.tasks) {
    if (!modelCosts[task.model]) {
      modelCosts[task.model] = { tasks: 0, estimated: 0 };
    }
    modelCosts[task.model].tasks++;
    const tokens = task.model === 'haiku'
      ? { input: 100_000, output: 30_000 }
      : { input: 200_000, output: 50_000 };
    const rates = task.model === 'opus'
      ? { input: 15, output: 75 }
      : task.model === 'sonnet'
        ? { input: 3, output: 15 }
        : { input: 0.80, output: 4 };
    const cost =
      (tokens.input / 1_000_000) * rates.input +
      (tokens.output / 1_000_000) * rates.output;
    modelCosts[task.model].estimated += cost;
  }

  console.log('\nBy model:');
  for (const [model, data] of Object.entries(modelCosts)) {
    console.log(`  @${model}: ${data.tasks} tasks — $${data.estimated.toFixed(2)}`);
  }

  // By domain
  const domainCosts: Record<string, { tasks: number; estimated: number }> = {};
  for (const task of plan.tasks) {
    if (!domainCosts[task.domain]) {
      domainCosts[task.domain] = { tasks: 0, estimated: 0 };
    }
    domainCosts[task.domain].tasks++;
    const tokens = task.model === 'haiku'
      ? { input: 100_000, output: 30_000 }
      : { input: 200_000, output: 50_000 };
    const rates = task.model === 'opus'
      ? { input: 15, output: 75 }
      : task.model === 'sonnet'
        ? { input: 3, output: 15 }
        : { input: 0.80, output: 4 };
    const cost =
      (tokens.input / 1_000_000) * rates.input +
      (tokens.output / 1_000_000) * rates.output;
    domainCosts[task.domain].estimated += cost;
  }

  console.log('\nBy domain:');
  for (const [domain, data] of Object.entries(domainCosts)) {
    console.log(`  ${domain}: ${data.tasks} tasks — $${data.estimated.toFixed(2)}`);
  }

  // Domain lead overhead
  console.log('\nDomain lead sessions:');
  for (const domain of plan.domains) {
    const rates = domain.leadModel === 'opus'
      ? { input: 15, output: 75 }
      : domain.leadModel === 'sonnet'
        ? { input: 3, output: 15 }
        : { input: 0.80, output: 4 };
    const cost = (500_000 / 1_000_000) * rates.input + (100_000 / 1_000_000) * rates.output;
    console.log(`  ${domain.name} lead (@${domain.leadModel}): $${cost.toFixed(2)}`);
  }

  // Wyvern Prime
  const wyvernCost = (200_000 / 1_000_000) * 15 + (50_000 / 1_000_000) * 75;
  console.log(`\nWyvern Prime (@opus): $${wyvernCost.toFixed(2)}`);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`TOTAL ESTIMATED: $${plan.estimatedCost.toFixed(2)}`);
}
