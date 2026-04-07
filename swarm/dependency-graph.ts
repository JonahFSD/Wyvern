/**
 * dependency-graph.ts — Builds a DAG from swarm tasks and validates it.
 * Detects cycles, computes tiers, finds the critical path, and
 * calculates maximum parallelism.
 */

import type { SwarmTask, SwarmPlan } from './types.js';

/** Validate that the task graph is a valid DAG (no cycles, no missing refs). */
export function validateGraph(tasks: SwarmTask[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const taskIds = new Set(tasks.map(t => t.id));

  // Check for duplicate IDs
  const seen = new Set<string>();
  for (const task of tasks) {
    if (seen.has(task.id)) {
      errors.push(`Duplicate task ID: ${task.id}`);
    }
    seen.add(task.id);
  }

  // Check for missing dependency references
  for (const task of tasks) {
    for (const dep of task.blockedBy) {
      if (!taskIds.has(dep)) {
        errors.push(`Task ${task.id} depends on non-existent task: ${dep}`);
      }
    }
  }

  // Check for cycles using DFS
  const cycle = detectCycle(tasks);
  if (cycle) {
    errors.push(`Dependency cycle detected: ${cycle.join(' → ')}`);
  }

  // Check for file conflicts (two tasks in same tier touching same file)
  const tierGroups = groupByTier(tasks);
  for (const [tier, tierTasks] of tierGroups) {
    const fileOwners = new Map<string, string>();
    for (const task of tierTasks) {
      for (const file of task.touchesFiles) {
        const existing = fileOwners.get(file);
        if (existing && existing !== task.id) {
          // Only a conflict if they could actually run in parallel
          const areDependentOnEachOther =
            task.blockedBy.includes(existing) ||
            tierTasks.find(t => t.id === existing)?.blockedBy.includes(task.id);
          if (!areDependentOnEachOther) {
            errors.push(
              `File conflict in tier ${tier}: ${file} touched by both ${existing} and ${task.id}`
            );
          }
        }
        fileOwners.set(file, task.id);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Detect cycles using iterative DFS with coloring. Returns cycle path or null. */
function detectCycle(tasks: SwarmTask[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const task of tasks) {
    // blockedBy means: task depends on these → edges go FROM dependency TO task
    // For cycle detection, we need the reverse: who does each task block?
    if (!adjacency.has(task.id)) adjacency.set(task.id, []);
    for (const dep of task.blockedBy) {
      const list = adjacency.get(dep) || [];
      list.push(task.id);
      adjacency.set(dep, list);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  for (const task of tasks) {
    color.set(task.id, WHITE);
    parent.set(task.id, null);
  }

  for (const task of tasks) {
    if (color.get(task.id) !== WHITE) continue;

    const stack: string[] = [task.id];
    while (stack.length > 0) {
      const node = stack[stack.length - 1];
      const nodeColor = color.get(node)!;

      if (nodeColor === WHITE) {
        color.set(node, GRAY);
        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
          const neighborColor = color.get(neighbor);
          if (neighborColor === GRAY) {
            // Found a cycle — reconstruct path
            const cycle = [neighbor, node];
            let current = node;
            while (parent.get(current) && parent.get(current) !== neighbor) {
              current = parent.get(current)!;
              cycle.push(current);
            }
            cycle.push(neighbor);
            return cycle.reverse();
          }
          if (neighborColor === WHITE) {
            parent.set(neighbor, node);
            stack.push(neighbor);
          }
        }
      } else {
        color.set(node, BLACK);
        stack.pop();
      }
    }
  }

  return null;
}

/** Group tasks by their tier number. */
function groupByTier(tasks: SwarmTask[]): Map<number, SwarmTask[]> {
  const groups = new Map<number, SwarmTask[]>();
  for (const task of tasks) {
    const list = groups.get(task.tier) || [];
    list.push(task);
    groups.set(task.tier, list);
  }
  return groups;
}

/** Find the critical path — the longest chain of sequential dependencies. */
export function findCriticalPath(tasks: SwarmTask[]): string[] {
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Compute longest path to each node using dynamic programming
  const longestTo = new Map<string, number>();
  const prevOn = new Map<string, string | null>();

  // Topological sort first
  const sorted = topologicalSort(tasks);

  for (const taskId of sorted) {
    const task = taskMap.get(taskId)!;
    let maxPrev = 0;
    let maxPrevId: string | null = null;

    for (const dep of task.blockedBy) {
      const depLength = (longestTo.get(dep) ?? 0) + (taskMap.get(dep)?.estimatedMinutes ?? 1);
      if (depLength > maxPrev) {
        maxPrev = depLength;
        maxPrevId = dep;
      }
    }

    longestTo.set(taskId, maxPrev);
    prevOn.set(taskId, maxPrevId);
  }

  // Find the task with the longest path
  let endTask = '';
  let maxLength = 0;
  for (const [taskId, length] of longestTo) {
    const task = taskMap.get(taskId)!;
    const total = length + task.estimatedMinutes;
    if (total > maxLength) {
      maxLength = total;
      endTask = taskId;
    }
  }

  // Reconstruct path
  const path: string[] = [];
  let current: string | null = endTask;
  while (current) {
    path.unshift(current);
    current = prevOn.get(current) ?? null;
  }

  return path;
}

/** Topological sort using Kahn's algorithm. */
function topologicalSort(tasks: SwarmTask[]): string[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const task of tasks) {
    inDegree.set(task.id, task.blockedBy.length);
    if (!adjacency.has(task.id)) adjacency.set(task.id, []);
    for (const dep of task.blockedBy) {
      const list = adjacency.get(dep) || [];
      list.push(task.id);
      adjacency.set(dep, list);
    }
  }

  const queue = tasks.filter(t => t.blockedBy.length === 0).map(t => t.id);
  const result: string[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    result.push(node);
    for (const neighbor of (adjacency.get(node) || [])) {
      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) queue.push(neighbor);
    }
  }

  return result;
}

/** Calculate max parallelism — most tasks runnable simultaneously at any point. */
export function calculateMaxParallelism(tasks: SwarmTask[]): number {
  const tierGroups = groupByTier(tasks);
  let maxParallel = 0;

  for (const [, tierTasks] of tierGroups) {
    if (tierTasks.length > maxParallel) {
      maxParallel = tierTasks.length;
    }
  }

  return maxParallel;
}

/** Compute stats for the swarm plan. */
export function computeStats(tasks: SwarmTask[]): SwarmPlan['stats'] {
  const tasksByTier: Record<number, number> = {};
  const tasksByDomain: Record<string, number> = {};
  const tasksByModel: Record<string, number> = {};

  for (const task of tasks) {
    tasksByTier[task.tier] = (tasksByTier[task.tier] ?? 0) + 1;
    tasksByDomain[task.domain] = (tasksByDomain[task.domain] ?? 0) + 1;
    tasksByModel[task.model] = (tasksByModel[task.model] ?? 0) + 1;
  }

  const criticalPath = findCriticalPath(tasks);
  const taskMap = new Map(tasks.map(t => [t.id, t]));
  const estimatedMinutes = criticalPath.reduce(
    (sum, id) => sum + (taskMap.get(id)?.estimatedMinutes ?? 5), 0
  );

  return {
    totalTasks: tasks.length,
    tasksByTier,
    tasksByDomain,
    tasksByModel,
    maxParallelism: calculateMaxParallelism(tasks),
    estimatedMinutes,
  };
}

/** Pretty-print the DAG for human review. */
export function formatGraph(tasks: SwarmTask[]): string {
  const lines: string[] = ['Swarm Dependency Graph', '='.repeat(50)];
  const tierGroups = groupByTier(tasks);
  const sortedTiers = Array.from(tierGroups.keys()).sort((a, b) => a - b);

  for (const tier of sortedTiers) {
    const tierTasks = tierGroups.get(tier)!;
    lines.push(`\nTIER ${tier} (${tierTasks.length} tasks)`);
    lines.push('-'.repeat(30));

    // Group by domain within tier
    const byDomain = new Map<string, SwarmTask[]>();
    for (const task of tierTasks) {
      const list = byDomain.get(task.domain) || [];
      list.push(task);
      byDomain.set(task.domain, list);
    }

    for (const [domain, domainTasks] of byDomain) {
      lines.push(`  [${domain}]`);
      for (const task of domainTasks) {
        const deps = task.blockedBy.length > 0
          ? ` (blocked by: ${task.blockedBy.join(', ')})`
          : '';
        const model = ` @${task.model}`;
        lines.push(`    ${task.id} — ${task.description}${model}${deps}`);
      }
    }
  }

  const stats = computeStats(tasks);
  lines.push(`\n${'='.repeat(50)}`);
  lines.push(`Total: ${stats.totalTasks} tasks across ${sortedTiers.length} tiers`);
  lines.push(`Max parallelism: ${stats.maxParallelism}`);
  lines.push(`Critical path: ${stats.estimatedMinutes} min estimated`);
  lines.push(`Critical path tasks: ${findCriticalPath(tasks).join(' → ')}`);

  return lines.join('\n');
}
