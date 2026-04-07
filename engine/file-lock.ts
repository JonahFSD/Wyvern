/**
 * file-lock.ts — Simple advisory file locking using .lock files.
 *
 * Prevents concurrent writes to PLAN.md when multiple tasks
 * run in parallel and try to check their boxes simultaneously.
 *
 * Uses mkdir-based locking (atomic on POSIX) with exponential
 * backoff retry and a stale-lock timeout.
 */

import { mkdir, rmdir, stat } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';

const LOCK_STALE_MS = 30_000; // Locks older than 30s are considered stale
const MAX_RETRIES = 20;
const BASE_DELAY_MS = 50;
const MAX_DELAY_MS = 500;

export class FileLock {
  private lockDir: string;

  constructor(filePath: string) {
    this.lockDir = filePath + '.lock';
  }

  /** Acquire the lock with exponential backoff. Throws after MAX_RETRIES. */
  async acquire(): Promise<void> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        await mkdir(this.lockDir);
        return; // Lock acquired
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') throw err;

        // Lock exists — check if it's stale
        if (await this.isStale()) {
          await this.forceRelease();
          continue; // Retry immediately after clearing stale lock
        }

        // Back off with jitter
        const delay = Math.min(
          BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS,
          MAX_DELAY_MS,
        );
        await sleep(delay);
      }
    }

    // Last resort: force-release and try once more
    await this.forceRelease();
    try {
      await mkdir(this.lockDir);
    } catch {
      throw new Error(`Failed to acquire lock on ${this.lockDir} after ${MAX_RETRIES} retries`);
    }
  }

  /** Release the lock. */
  async release(): Promise<void> {
    try {
      await rmdir(this.lockDir);
    } catch {
      // Lock already released or never acquired — safe to ignore
    }
  }

  /** Check if the lock is stale (older than LOCK_STALE_MS). */
  private async isStale(): Promise<boolean> {
    try {
      const stats = await stat(this.lockDir);
      return Date.now() - stats.mtimeMs > LOCK_STALE_MS;
    } catch {
      return true; // Can't stat = doesn't exist = not stale, but safe to retry
    }
  }

  /** Force-release a stale lock. */
  private async forceRelease(): Promise<void> {
    try {
      await rmdir(this.lockDir);
    } catch {
      // Already gone
    }
  }
}

/**
 * Read a file with an advisory lock held.
 * Returns the file contents.
 */
export async function lockedRead(filePath: string): Promise<string> {
  const lock = new FileLock(filePath);
  await lock.acquire();
  try {
    return await readFile(filePath, 'utf-8');
  } finally {
    await lock.release();
  }
}

/**
 * Perform a read-modify-write on a file with an advisory lock held.
 * The `transform` function receives the current content and returns
 * the new content to write.
 */
export async function lockedUpdate(
  filePath: string,
  transform: (content: string) => string,
): Promise<void> {
  const lock = new FileLock(filePath);
  await lock.acquire();
  try {
    const content = await readFile(filePath, 'utf-8');
    const updated = transform(content);
    if (updated !== content) {
      await writeFile(filePath, updated, 'utf-8');
    }
  } finally {
    await lock.release();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
