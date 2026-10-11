// Destro agent — background process execution for long-running tasks. Created 2026-07-04.

import { spawn, ChildProcess } from 'node:child_process';

// ──────────────────────────────────────────────
// Ring Buffer
// ──────────────────────────────────────────────

interface RingEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  timestamp: number;
}

class RingBuffer {
  private buffer: RingEntry[];
  private pos = 0;
  private filled = false;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(entry: RingEntry): void {
    this.buffer[this.pos] = entry;
    this.pos = (this.pos + 1) % this.capacity;
    if (this.pos === 0) this.filled = true;
  }

  getAll(): RingEntry[] {
    if (!this.filled) {
      return this.buffer.slice(0, this.pos);
    }
    return [...this.buffer.slice(this.pos), ...this.buffer.slice(0, this.pos)];
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.pos = 0;
    this.filled = false;
  }

  get length(): number {
    return this.filled ? this.capacity : this.pos;
  }
}

// ──────────────────────────────────────────────
// BackgroundProcess
// ──────────────────────────────────────────────

export interface BackgroundProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  ringBufferSize?: number;
}

export interface BackgroundProcessOutput {
  entries: RingEntry[];
  stdout: string;
  stderr: string;
  combined: string;
}

export class BackgroundProcess {
  private cmd: string;
  private options: BackgroundProcessOptions;
  private process: ChildProcess | null = null;
  private ring: RingBuffer;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;
  private started = false;
  private killed = false;

  constructor(cmd: string, options: BackgroundProcessOptions = {}) {
    this.cmd = cmd;
    this.options = options;
    this.ring = new RingBuffer(options.ringBufferSize || 10_000);
  }

  /**
   * Spawn the command detached with piped stdio.
   */
  start(): void {
    if (this.started) return;
    this.started = true;

    const env = this.options.env
      ? { ...process.env, ...this.options.env }
      : process.env;

    this.process = spawn('/bin/sh', ['-c', this.cmd], {
      cwd: this.options.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    // Prevent the child from keeping the parent alive
    if (this.process.pid) {
      this.process.unref();
    }

    this.process.stdout?.on('data', (data: Buffer) => {
      this.ring.push({ stream: 'stdout', data: data.toString('utf-8'), timestamp: Date.now() });
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.ring.push({ stream: 'stderr', data: data.toString('utf-8'), timestamp: Date.now() });
    });

    this.process.on('exit', (code, signal) => {
      this.exitCode = code;
      this.exitSignal = signal;
    });

    this.process.on('error', () => {
      // Process failed to spawn; exitCode remains handled via exit event
    });
  }

  /**
   * Read accumulated stdout/stderr from the ring buffer.
   * Does NOT drain the buffer — returns full contents each call.
   */
  poll(): BackgroundProcessOutput {
    const entries = this.ring.getAll();
    const stdoutParts: string[] = [];
    const stderrParts: string[] = [];

    for (const e of entries) {
      if (e.stream === 'stdout') stdoutParts.push(e.data);
      else stderrParts.push(e.data);
    }

    return {
      entries,
      stdout: stdoutParts.join(''),
      stderr: stderrParts.join(''),
      combined: entries.map(e => e.data).join(''),
    };
  }

  /**
   * Get the current ring buffer contents.
   */
  getOutput(): BackgroundProcessOutput {
    return this.poll();
  }

  /**
   * Check whether the process is still running.
   */
  isRunning(): boolean {
    if (!this.process || this.killed) return false;
    if (this.exitCode !== null || this.exitSignal !== null) return false;
    try {
      // Signal 0 checks existence without sending a signal
      process.kill(this.process.pid!, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Kill the process: SIGTERM first, then SIGKILL after 5 seconds.
   */
  stop(): void {
    if (!this.process || this.killed) return;
    this.killed = true;

    try {
      this.process.kill('SIGTERM');
    } catch { /* already dead */ }

    const pid = this.process.pid;
    setTimeout(() => {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch { /* already dead */ }
      }
    }, 5_000);
  }

  /**
   * The underlying child process (may be null before start).
   */
  get childProcess(): ChildProcess | null {
    return this.process;
  }

  /**
   * The exit code, if the process has exited.
   */
  get exitCodeValue(): number | null {
    return this.exitCode;
  }

  /**
   * The exit signal, if the process was signaled.
   */
  get exitSignalValue(): string | null {
    return this.exitSignal;
  }
}

// ──────────────────────────────────────────────
// Wake Conditions
// ──────────────────────────────────────────────

/**
 * Wait for a background process to exit.
 */
export function waitForExit(
  bg: BackgroundProcess,
  timeoutMs?: number,
): Promise<{ exitCode: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const process = bg.childProcess;
    if (!process || !bg.isRunning()) {
      resolve({ exitCode: bg.exitCodeValue, signal: bg.exitSignalValue });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onExit = (code: number | null, signal: string | null) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, signal });
    };

    process.on('exit', onExit);

    if (timeoutMs) {
      timer = setTimeout(() => {
        process.off('exit', onExit);
        resolve({ exitCode: null, signal: 'timeout' });
      }, timeoutMs);
    }
  });
}

/**
 * Wait for a background process to output a line matching the given pattern.
 * Polls every 500ms until pattern is found, process exits, or timeout fires.
 */
export function waitForPattern(
  bg: BackgroundProcess,
  pattern: RegExp,
  timeoutMs?: number,
): Promise<{ matched: boolean; line?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = () => {
      if (settled) return;
      const output = bg.getOutput();
      for (const entry of output.entries) {
        if (pattern.test(entry.data)) {
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ matched: true, line: entry.data.trim() });
          return;
        }
      }
      if (!bg.isRunning()) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ matched: false });
        return;
      }
      setTimeout(check, 500);
    };

    check();

    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ matched: false });
      }, timeoutMs);
    }
  });
}

/**
 * Wait until a health URL responds successfully for a sustained period.
 * Polls every 5 seconds and resolves when the health check has been
 * consistently healthy for sustainedMs milliseconds.
 */
export function waitForHealthy(
  bg: BackgroundProcess,
  healthUrl: string,
  sustainedMs?: number,
): Promise<{ healthy: boolean }> {
  const requiredSustained = sustainedMs || 30_000;
  const pollInterval = 5_000;

  return new Promise((resolve) => {
    let healthySince: number | null = null;
    let settled = false;

    const check = async () => {
      if (settled) return;

      if (!bg.isRunning()) {
        settled = true;
        resolve({ healthy: false });
        return;
      }

      let isHealthy = false;
      try {
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), 10_000);
        const resp = await fetch(healthUrl, { signal: controller.signal });
        clearTimeout(fetchTimer);
        isHealthy = resp.ok;
      } catch {
        isHealthy = false;
      }

      if (isHealthy) {
        if (healthySince === null) {
          healthySince = Date.now();
        }
        if (Date.now() - healthySince >= requiredSustained) {
          settled = true;
          resolve({ healthy: true });
          return;
        }
      } else {
        healthySince = null;
      }

      setTimeout(check, pollInterval);
    };

    check();
  });
}

// ──────────────────────────────────────────────
// Convenience Factory
// ──────────────────────────────────────────────

/**
 * Create and start a background process in one call.
 */
export function startBackgroundExec(
  cmd: string,
  options?: BackgroundProcessOptions,
): BackgroundProcess {
  const bg = new BackgroundProcess(cmd, options);
  bg.start();
  return bg;
}
