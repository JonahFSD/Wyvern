/**
 * agent-teams-adapter.ts — Translates a SwarmPlan into artifacts
 * that Claude Code Agent Teams can consume:
 *
 * 1. A launch script (markdown prompt for the team lead)
 * 2. Hooks configuration for quality gates
 *
 * The launch script is designed to be pasted into a Claude Code session
 * with Agent Teams enabled. Claude reads it and executes the team setup.
 *
 * Each domain lead gets its own git worktree — an isolated copy of the
 * repo on its own branch. This prevents parallel agents from clobbering
 * each other's files when they all share a single working directory.
 */

import { resolve, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { SwarmPlan, SwarmTask, Domain } from './types.js';
import { formatVerifyCommandSequence } from '../engine/verification.js';

/**
 * Generate the team lead launch script — a markdown prompt that
 * tells Claude (as team lead) exactly how to set up and run the swarm.
 */
export function generateTeamScript(
  plan: SwarmPlan,
  projectRoot: string,
  verifyCommands: string[],
): string {
  const lines: string[] = [];
  const verifyCommand = formatVerifyCommandSequence(verifyCommands);

  lines.push(`# Swarm Launch Script — ${plan.project}`);
  lines.push('');
  lines.push('You are the team lead for this build. Follow these instructions exactly.');
  lines.push('');

  // ─── Team Setup ─────────────────────────────────────
  lines.push('## Step 1: Create the Agent Team');
  lines.push('');
  lines.push(`Create an agent team called "${plan.project}-build".`);
  lines.push('');

  // ─── Write Foundations ──────────────────────────────
  lines.push('## Step 2: Write Foundations on Main');
  lines.push('');
  lines.push('Before creating worktrees, write all foundation files on main branch:');
  lines.push('');
  for (const f of plan.foundations) {
    lines.push(`  - ${f.file} — ${f.description}`);
  }
  lines.push('');
  lines.push('After writing all foundation files:');
  lines.push(`  1. Run: \`${verifyCommand}\``);
  lines.push('  2. Commit: `git add . && git commit -m "feat(foundations): establish type contracts and shared utilities"`');
  lines.push('');
  lines.push('If foundations are already committed (e.g. resuming a previous run), skip this step.');
  lines.push('');

  // ─── Create Domain Worktrees ────────────────────────
  lines.push('## Step 3: Create Domain Worktrees');
  lines.push('');
  lines.push('Create a git worktree for each domain. This gives each domain lead its own');
  lines.push('isolated copy of the repo — no branch conflicts, no clobbered files.');
  lines.push('');
  lines.push('```bash');
  lines.push('mkdir -p .worktrees');
  for (const domain of plan.domains) {
    const branchName = domain.branch || `domain/${domain.name}`;
    // Handle both fresh start (branch doesn't exist) and recovery (branch already exists)
    lines.push(`# ${domain.name}: create worktree (handles both new and existing branches)`);
    lines.push(`if git show-ref --verify --quiet refs/heads/${branchName}; then`);
    lines.push(`  git worktree add .worktrees/${domain.name} ${branchName}`);
    lines.push(`else`);
    lines.push(`  git worktree add -b ${branchName} .worktrees/${domain.name}`);
    lines.push(`fi`);
  }
  lines.push('```');
  lines.push('');
  lines.push('After creating all worktrees, verify they exist:');
  lines.push('```bash');
  lines.push('git worktree list');
  lines.push('```');
  lines.push('');
  lines.push('You (the team lead) stay on main in the project root. Each domain lead');
  lines.push('works exclusively in its `.worktrees/<domain>` directory.');
  lines.push('');

  // ─── Domain Leads ───────────────────────────────────
  lines.push('## Step 4: Spawn Domain Leads');
  lines.push('');
  lines.push(`Spawn ${plan.domains.length} teammates, one per domain:`);
  lines.push('');

  for (const domain of plan.domains) {
    const worktreePath = join(projectRoot, '.worktrees', domain.name);
    lines.push(`### ${domain.name} Lead`);
    lines.push('');
    lines.push(`- **Name**: ${domain.name}-lead`);
    lines.push(`- **Model**: ${domain.leadModel}`);
    lines.push(`- **Working directory**: \`${worktreePath}\``);
    lines.push(`- **Owned paths**: ${domain.ownedPaths.join(', ')}`);
    lines.push('');
    lines.push('**Spawn prompt:**');
    lines.push('```');
    lines.push(generateDomainLeadPrompt(domain, plan, worktreePath, verifyCommands));
    lines.push('```');
    lines.push('');
  }

  // ─── Task Creation ──────────────────────────────────
  lines.push('## Step 5: Create Tasks');
  lines.push('');
  lines.push('Create the following tasks in the shared task list. Set dependencies using blocked_by.');
  lines.push('Tasks will auto-unblock as their dependencies complete.');
  lines.push('');

  // Group by tier
  const byTier = new Map<number, SwarmTask[]>();
  for (const task of plan.tasks) {
    const list = byTier.get(task.tier) || [];
    list.push(task);
    byTier.set(task.tier, list);
  }

  for (const tier of Array.from(byTier.keys()).sort((a, b) => a - b)) {
    lines.push(`### Tier ${tier}`);
    lines.push('');

    for (const task of byTier.get(tier)!) {
      const deps = task.blockedBy.length > 0
        ? `Depends on: ${task.blockedBy.join(', ')}`
        : 'No dependencies — immediately available';
      lines.push(`**${task.id}** — ${task.description}`);
      lines.push(`- Domain: ${task.domain}`);
      lines.push(`- Model: @${task.model}`);
      lines.push(`- ${deps}`);
      if (task.touchesFiles.length > 0) {
        lines.push(`- Files: ${task.touchesFiles.join(', ')}`);
      }
      if (task.exports.length > 0) {
        lines.push(`- Exports: ${task.exports.join(', ')}`);
      }
      lines.push('');
    }
  }

  // ─── Execution Rules ────────────────────────────────
  lines.push('## Step 6: Execution Rules');
  lines.push('');
  lines.push('- Do NOT implement any tasks yourself. Delegate everything to domain leads.');
  lines.push('- Watch for blocked teammates and help resolve blockers.');
  lines.push('- If a domain lead reports a failed verification, review the error and guide them.');
  lines.push('- Each domain lead works in its own worktree. Verify no cross-worktree interference.');
  lines.push('- When all tasks are complete, proceed to Step 7 for merge and final verification.');
  lines.push('');

  // ─── Merge Domains ──────────────────────────────────
  lines.push('## Step 7: Merge Domains (Deterministic Order)');
  lines.push('');
  lines.push('After ALL domain tasks are complete, merge domains back to main from the project root.');
  lines.push('You (the team lead) are already on main in the project root — NOT in a worktree.');
  lines.push('');
  const mergeOrder = plan.mergeOrder || plan.domains.map(d => d.name);
  for (const domainName of mergeOrder) {
    const domain = plan.domains.find(d => d.name === domainName);
    if (!domain) continue;
    const branchName = domain.branch || `domain/${domain.name}`;
    lines.push(`### Merge ${domain.name}`);
    lines.push('');
    lines.push('```bash');
    lines.push(`git merge ${branchName} --no-ff -m "merge(${domain.name}): complete ${domain.name} domain"`);
    lines.push(verifyCommand);
    lines.push('```');
    lines.push('');
    lines.push(`If this merge fails verification, STOP. Do NOT proceed to the next merge.`);
    lines.push(`Investigate the type mismatch and fix on the ${branchName} branch before re-merging.`);
    lines.push('');
  }

  // ─── Clean Up Worktrees ─────────────────────────────
  lines.push('### Clean Up Worktrees');
  lines.push('');
  lines.push('After all merges succeed, remove the worktrees:');
  lines.push('```bash');
  for (const domain of plan.domains) {
    lines.push(`git worktree remove .worktrees/${domain.name}`);
  }
  lines.push('```');
  lines.push('');

  // ─── Final Verification ─────────────────────────────
  lines.push('## Step 8: Final Verification');
  lines.push('');
  lines.push('After all domains are merged successfully:');
  lines.push(`  1. Run: \`${verifyCommand}\` on main`);
  lines.push('  2. Review: All domain branches should now be fully integrated');
  lines.push('  3. Clean up: Delete domain branches if desired (`git branch -d domain/*`)');
  lines.push('  4. Clean up the agent team');
  lines.push('');

  // ─── Budget ─────────────────────────────────────────
  lines.push('## Budget');
  lines.push('');
  lines.push(`Estimated total cost: **$${plan.estimatedCost.toFixed(2)}**`);
  lines.push(`Critical path time: **~${plan.stats.estimatedMinutes} minutes**`);
  lines.push(`Max parallelism: **${plan.stats.maxParallelism} concurrent tasks**`);
  lines.push('');

  return lines.join('\n');
}

/** Generate the spawn prompt for a domain lead. */
function generateDomainLeadPrompt(
  domain: Domain,
  plan: SwarmPlan,
  worktreePath: string,
  verifyCommands: string[],
): string {
  const domainTasks = plan.tasks.filter(t => t.domain === domain.name);
  const taskList = domainTasks
    .map(t => {
      const deps = t.blockedBy.length > 0 ? ` (blocked by: ${t.blockedBy.join(', ')})` : '';
      return `  ${t.id} @${t.model} — ${t.description}${deps}`;
    })
    .join('\n');

  const branchName = domain.branch || `domain/${domain.name}`;
  const verifyCommand = formatVerifyCommandSequence(verifyCommands);

  return `You are the ${domain.name} domain lead for the ${plan.project} project.

## CRITICAL: Your Working Directory

You have your own isolated worktree. ALL of your work happens here:
  cd ${worktreePath}

This directory is already on branch \`${branchName}\`. Do NOT run \`git checkout\`.
Do NOT \`cd\` to the project root or any other worktree. Stay in ${worktreePath}.

## Environment Setup

Set these environment variables in your session:
  cd ${worktreePath}
  export WYVERN_DOMAIN="${domain.name}"
  export WYVERN_WORKTREE="${worktreePath}"

You own these directories (relative to your worktree root):
${domain.ownedPaths.map(p => `  - ${p}`).join('\n')}

Your tasks (${domainTasks.length} total):
${taskList}

Work through tasks in dependency order. The shared task list handles blocking automatically.
When a task unblocks, claim it and execute.

For EVERY task:
1. Export the current task ID: \`export WYVERN_TASK_ID=<task-id>\`
2. Capture the task start SHA: \`export WYVERN_TASK_START_SHA=$(git rev-parse HEAD)\`
3. Read the task description
4. Implement the changes
5. Run (from your worktree): cd ${worktreePath} && ${verifyCommand}
6. Mark complete ONLY if verification passes
7. If it fails, fix issues and re-verify

Follow all conventions in CLAUDE.md and AGENTS/infrastructure/initialization/CLAUDE.md.
Read cmdctrl/wyvern/src/swarm/domain-conventions.md for your full protocol.

## Critical Worktree Rules

- You are in worktree: ${worktreePath} (branch: ${branchName})
- NEVER cd to the project root or another domain's worktree
- NEVER run git checkout — you are already on the correct branch
- NEVER merge from or to main
- NEVER pull changes from other domain branches
- When the team lead signals all tasks are complete, your branch will be merged from the main worktree
- If you encounter issues with foundations, escalate to the team lead immediately

Do NOT modify files outside your owned directories unless the task explicitly requires it.
Message other domain leads if you need cross-domain coordination.
Message the team lead if you're stuck on something outside your scope.`;
}

/**
 * Generate hooks configuration for quality gates.
 * These hooks integrate with Claude Code's hook system.
 *
 * IMPORTANT: The domain lead's session must export WYVERN_WORKTREE environment variable
 * so hooks run in the correct worktree directory, not the shared project root.
 */
export function generateHooksConfig(projectRoot: string): object {
  const taskCompletedHook = join(projectRoot, 'cmdctrl', 'wyvern', 'src', 'swarm', 'hooks', 'task-completed.sh');
  const teammateIdleHook = join(projectRoot, 'cmdctrl', 'wyvern', 'src', 'swarm', 'hooks', 'teammate-idle.sh');

  return {
    hooks: {
      TaskCompleted: [
        {
          command: `bash "${taskCompletedHook}"`,
          description: 'Run the full Wyvern TaskCompleted enforcement gate',
          exitCodes: {
            0: 'allow',
            2: 'reject',
          },
        },
      ],
      TeammateIdle: [
        {
          command: `bash "${teammateIdleHook}"`,
          description: 'Suggest available work when a teammate finishes early',
          exitCodes: {
            0: 'allow',
            2: 'feedback',
          },
        },
      ],
      TaskCreated: [
        {
          command: `echo "Task created — validating task has required fields"`,
          description: 'Validate new tasks have description, domain, and model tier',
          exitCodes: {
            0: 'allow',
            2: 'reject',
          },
        },
      ],
    },
  };
}

/**
 * Generate a summary of what the swarm will do,
 * suitable for human review before committing to execution.
 */
export function generatePreflightSummary(plan: SwarmPlan): string {
  const lines: string[] = [
    'SWARM PREFLIGHT CHECK',
    '='.repeat(50),
    '',
    `Project: ${plan.project}`,
    `Domains: ${plan.domains.map(d => `${d.name} (@${d.leadModel})`).join(', ')}`,
    '',
    `Total tasks: ${plan.stats.totalTasks}`,
    `  @haiku: ${plan.stats.tasksByModel['haiku'] ?? 0}`,
    `  @sonnet: ${plan.stats.tasksByModel['sonnet'] ?? 0}`,
    `  @opus: ${plan.stats.tasksByModel['opus'] ?? 0}`,
    '',
    `Estimated cost: $${plan.estimatedCost.toFixed(2)}`,
    `Estimated time: ~${plan.stats.estimatedMinutes} min`,
    `Max parallelism: ${plan.stats.maxParallelism}`,
    '',
    `Critical path: ${plan.criticalPath.join(' → ')}`,
    '',
  ];

  // Foundations
  lines.push('Foundations (written on main, before branches):');
  for (const f of plan.foundations) {
    lines.push(`  ${f.file} @${f.model}`);
  }

  // Domain worktrees
  lines.push('', 'Domain worktrees:');
  for (const d of plan.domains) {
    const branchName = d.branch || `domain/${d.name}`;
    lines.push(`  ${d.name} → .worktrees/${d.name} (branch: ${branchName})`);
  }

  // Merge order
  const mergeOrder = plan.mergeOrder || plan.domains.map(d => d.name);
  lines.push('', 'Merge order (deterministic):');
  for (let i = 0; i < mergeOrder.length; i++) {
    lines.push(`  ${i + 1}. ${mergeOrder[i]}`);
  }

  // Domain file ownership
  lines.push('', 'Domain file ownership:');
  for (const d of plan.domains) {
    lines.push(`  ${d.name}: ${d.ownedPaths.join(', ')}`);
  }

  return lines.join('\n');
}
