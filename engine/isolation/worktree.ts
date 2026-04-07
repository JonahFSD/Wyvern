import { execSync } from 'node:child_process';
import { join } from 'node:path';

export function createWorktree(
  projectRoot: string,
  taskId: string,
  branch?: string,
): string {
  const worktreePath = join(projectRoot, '.wyvern', 'worktrees', taskId);
  const branchName = branch || `wyvern/${taskId}`;

  try {
    execSync(`git branch ${branchName}`, { cwd: projectRoot, stdio: 'pipe' });
  } catch {
    // Branch may already exist
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
