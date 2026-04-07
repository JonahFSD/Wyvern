import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories to ignore when watching for file activity.
 * These are high-churn or irrelevant to code progress and would
 * cause false resets (or exhaust inotify watches on Linux).
 */
const IGNORED_PREFIXES = [
  'node_modules',
  '.next',
  '.git',
  'dist',
  '.turbo',
  '.swc',
  '.vercel',
  '.wrangler',
  '__pycache__',
  '.cache',
];

/** Check if a changed file path should be ignored by the watchdog. */
function shouldIgnore(filename: string | null): boolean {
  if (!filename) return false; // null filename = unknown change, treat as activity
  return IGNORED_PREFIXES.some(prefix =>
    filename.startsWith(prefix + '/') || filename === prefix
  );
}

export class Watchdog {
  private timeoutMs: number;
  private projectDir: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: FSWatcher | null = null;
  private onTimeoutCallback: (() => void) | null = null;
  private pid: number | null = null;
  private usingFallback = false;

  constructor(timeoutMs: number, projectDir: string) {
    this.timeoutMs = timeoutMs;
    this.projectDir = projectDir;
  }

  onTimeout(callback: () => void): void {
    this.onTimeoutCallback = callback;
  }

  /** Whether the watchdog fell back to pure timer mode (no file-activity detection). */
  get isFallbackMode(): boolean {
    return this.usingFallback;
  }

  start(pid: number): void {
    this.pid = pid;
    this.resetTimer();

    try {
      this.watcher = watch(this.projectDir, { recursive: true }, (_event, filename) => {
        // Filter out noise from build artifacts, deps, and VCS
        if (shouldIgnore(filename as string | null)) return;
        this.resetTimer();
      });

      this.watcher.on('error', () => {
        // fs.watch can fail on some systems (e.g. Linux inotify limit)
        process.stderr.write(
          `\x1b[33mWARN\x1b[0m  watchdog: fs.watch failed, falling back to pure timer mode. ` +
          `Activity detection disabled — timeout is ${(this.timeoutMs / 1000).toFixed(0)}s from now.\n`
        );
        this.watcher?.close();
        this.watcher = null;
        this.usingFallback = true;
      });
    } catch {
      // Recursive watch not supported on this platform
      process.stderr.write(
        `\x1b[33mWARN\x1b[0m  watchdog: recursive fs.watch not supported, using pure timer mode. ` +
        `Activity detection disabled — timeout is ${(this.timeoutMs / 1000).toFixed(0)}s from now.\n`
      );
      this.usingFallback = true;
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pid = null;
  }

  private resetTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.onTimeoutCallback) {
        this.onTimeoutCallback();
      }
    }, this.timeoutMs);
  }
}

export function createWatchdog(timeoutMs: number, projectDir: string): Watchdog {
  return new Watchdog(timeoutMs, projectDir);
}
