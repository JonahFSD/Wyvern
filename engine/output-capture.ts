import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ChildProcess } from 'node:child_process';

export class OutputCapture {
  readonly logFile: string;
  private stream: WriteStream | null = null;

  constructor(taskDir: string, taskNumber: string) {
    this.logFile = join(taskDir, `output-${taskNumber}.log`);
  }

  async attach(proc: ChildProcess): Promise<void> {
    await mkdir(dirname(this.logFile), { recursive: true });
    this.stream = createWriteStream(this.logFile, { flags: 'w' });

    const header = `=== Wyvern Output Capture ===\n` +
      `Task: ${this.logFile}\n` +
      `PID: ${proc.pid}\n` +
      `Started: ${new Date().toISOString()}\n` +
      `${'='.repeat(30)}\n\n`;

    this.stream.write(header);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        this.stream?.write(chunk);
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        this.stream?.write(chunk);
      });
    }
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.stream) {
        resolve();
        return;
      }

      const footer = `\n${'='.repeat(30)}\n` +
        `Ended: ${new Date().toISOString()}\n`;

      this.stream.write(footer, () => {
        this.stream?.end(() => {
          this.stream = null;
          resolve();
        });
      });
    });
  }
}

export function createOutputCapture(taskDir: string, taskNumber: string): OutputCapture {
  return new OutputCapture(taskDir, taskNumber);
}
