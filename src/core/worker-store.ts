import { appendFileSync, readFileSync, readdirSync, unlinkSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot } from './env-file.js';

const CC_HOME = installRoot();
const DEFAULT_STORE_DIR = join(CC_HOME, '.worker-store');

export interface WorkerStateEntry {
  workerId: string;
  timestamp: number;
  type: 'start' | 'tool' | 'turn' | 'error' | 'compact' | 'steer' | 'complete';
  data: Record<string, any>;
}

export class WorkerStore {
  private storeDir: string;

  constructor(storeDir?: string) {
    this.storeDir = storeDir || DEFAULT_STORE_DIR;
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
  }

  private filePath(workerId: string): string {
    return join(this.storeDir, `${workerId}.jsonl`);
  }

  append(entry: WorkerStateEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.filePath(entry.workerId), line);
  }

  getWorkerState(workerId: string): WorkerStateEntry[] {
    const fp = this.filePath(workerId);
    if (!existsSync(fp)) return [];
    return readFileSync(fp, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); }
        catch { return null; }
      })
      .filter(Boolean) as WorkerStateEntry[];
  }

  getLatestEntry(workerId: string): WorkerStateEntry | null {
    const entries = this.getWorkerState(workerId);
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  getActiveWorkers(): string[] {
    if (!existsSync(this.storeDir)) return [];
    const files = readdirSync(this.storeDir).filter(f => f.endsWith('.jsonl'));
    const active: string[] = [];
    for (const f of files) {
      const workerId = f.replace('.jsonl', '');
      const latest = this.getLatestEntry(workerId);
      if (latest && latest.type !== 'complete') {
        active.push(workerId);
      }
    }
    return active;
  }

  getWorkerSummary(workerId: string): { turns: number; tools: number; errors: number; status: string } {
    const entries = this.getWorkerState(workerId);
    let turns = 0, tools = 0, errors = 0, status = 'unknown';
    for (const e of entries) {
      if (e.type === 'turn') turns++;
      else if (e.type === 'tool') tools++;
      else if (e.type === 'error') errors++;
      else if (e.type === 'complete') status = e.data.status || 'done';
      else if (e.type === 'start') status = 'running';
    }
    if (status === 'unknown' && entries.length > 0) status = 'running';
    return { turns, tools, errors, status };
  }

  prune(olderThanMs: number): void {
    if (!existsSync(this.storeDir)) return;
    const cutoff = Date.now() - olderThanMs;
    for (const f of readdirSync(this.storeDir).filter(f => f.endsWith('.jsonl'))) {
      const fp = join(this.storeDir, f);
      try {
        const st = statSync(fp);
        if (st.mtimeMs < cutoff) unlinkSync(fp);
      } catch { /* skip */ }
    }
  }
}

export const workerStore = new WorkerStore();
