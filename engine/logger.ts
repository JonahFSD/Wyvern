import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogEntry } from './types.js';

const COLORS = {
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
  reset: '\x1b[0m',
  dim: '\x1b[2m',
} as const;

export class Logger {
  private logDir: string;
  private logFile: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logDir: string) {
    this.logDir = logDir;
    const date = new Date().toISOString().slice(0, 10);
    this.logFile = join(logDir, `wyvern-${date}.jsonl`);

    this.flushTimer = setInterval(() => this.flush(), 1000);
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.log('info', event, data);
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.log('warn', event, data);
  }

  error(event: string, data?: Record<string, unknown>): void {
    this.log('error', event, data);
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.log('debug', event, data);
  }

  private log(level: LogEntry['level'], event: string, data?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const entry: LogEntry = { timestamp, level, event, data };

    this.buffer.push(JSON.stringify(entry));
    this.printToConsole(entry);
  }

  private printToConsole(entry: LogEntry): void {
    const color = COLORS[entry.level];
    const time = entry.timestamp.slice(11, 19);
    const level = entry.level.toUpperCase().padEnd(5);
    const dataStr = entry.data
      ? ` ${COLORS.dim}${JSON.stringify(entry.data)}${COLORS.reset}`
      : '';

    process.stderr.write(
      `${COLORS.dim}${time}${COLORS.reset} ${color}${level}${COLORS.reset} ${entry.event}${dataStr}\n`
    );
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const lines = this.buffer.splice(0).join('\n') + '\n';
    try {
      await mkdir(this.logDir, { recursive: true });
      await appendFile(this.logFile, lines, 'utf-8');
    } catch (err) {
      process.stderr.write(`Failed to write log: ${err}\n`);
    }
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

export function createLogger(logDir: string): Logger {
  return new Logger(logDir);
}
