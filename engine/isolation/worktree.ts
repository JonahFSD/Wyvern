import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export function createWorktree(
  projectRoot: string,
  taskId: string,
  branch?: string,
): string {
  const worktreePath = join(projectRoot, '.wyvern', 'worktrees', taskId);
  const branchName = branch || `wyvern/${taskId}`;

  // Clean up stale worktree if it exists from a previous run
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove ${worktreePath} --force`, { cwd: projectRoot, stdio: 'pipe' });
    } catch {
      // If remove fails, prune and retry
      try {
        execSync('git worktree prune', { cwd: projectRoot, stdio: 'pipe' });
      } catch { /* best effort */ }
    }
  } else {
    // Path doesn't exist but git might still have a stale worktree record
    try {
      execSync('git worktree prune', { cwd: projectRoot, stdio: 'pipe' });
    } catch { /* best effort */ }
  }

  // Delete stale branch if it exists
  try {
    execSync(`git branch -D ${branchName}`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Branch doesn't exist, that's fine
  }

  // Create fresh branch and worktree
  try {
    execSync(`git branch ${branchName}`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Branch may already exist (shouldn't after the delete above, but be safe)
  }

  execSync(`git worktree add ${worktreePath} ${branchName}`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });

  return worktreePath;
}

export function removeWorktree(projectRoot: string, taskId: string): void {
  const worktreePath = join(projectRoot, '.wyvern', 'worktrees', taskId);
  try {
    execSync(`git worktree remove ${worktreePath} --force`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Already removed
  }
  // Clean up the branch too
  const branchName = `wyvern/${taskId}`;
  try {
    execSync(`git branch -D ${branchName}`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Branch may not exist
  }
}

export function mergeWorktree(
  projectRoot: string,
  taskId: string,
  targetBranch: string = 'main',
): void {
  const branchName = `wyvern/${taskId}`;
  execSync(`git checkout ${targetBranch}`, { cwd: projectRoot, stdio: 'pipe' });
  execSync(`git merge --no-ff ${branchName} -m "Merge task ${taskId}"`, {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}
