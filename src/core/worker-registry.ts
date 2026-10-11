import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import process from 'node:process';

import { join } from 'node:path';
import { installRoot } from './env-file.js';

const CC_HOME = installRoot();
const REGISTRY_PATH = join(CC_HOME, '.worker-state.json');

/**
 * Callback invoked whenever a worker is marked as completed (done or failed).
 * Registered via onWorkerComplete().
 */
export type WorkerCompleteCallback = (entry: WorkerEntry) => void;

const completionCallbacks: WorkerCompleteCallback[] = [];

/**
 * Register a callback to be notified whenever a worker completes.
 * Callbacks are invoked synchronously after the worker state is persisted.
 *
 * @param cb - Callback function receiving the completed WorkerEntry
 */
export function onWorkerComplete(cb: WorkerCompleteCallback): void {
  completionCallbacks.push(cb);
}

/**
 * Represents a worker entry in the persistent worker registry.
 * Tracks the lifecycle and hierarchy of worker processes.
 */
export interface WorkerEntry {
  /** Unique worker identifier (e.g., "w-abc123") */
  id: string;
  /** Operating system process ID */
  pid: number;
  /** ID of the parent worker that spawned this one, or null for root workers */
  parentId: string | null;
  /** Which system spawned this worker */
  spawner: 'assistant' | 'agent-fork' | 'build-round' | 'delegate' | 'orchestrator';
  /** Description of the task assigned to this worker */
  task: string;
  /** Working directory for the worker process */
  workDir: string;
  /** Path to the worker's log file */
  logFile: string;
  /** ISO 8601 timestamp when the worker was started */
  startedAt: string;
  /** Current execution status */
  status: 'running' | 'done' | 'failed';
  /** ISO 8601 timestamp when the worker finished (set on completion/failure) */
  finishedAt?: string;
  /** Summary result text (truncated to 500 characters) */
  result?: string;
  /** IDs of child workers spawned by this worker */
  children?: string[];
  /** Performance/cost tier: 'fast', 'standard', or 'heavy' (defaults to 'standard') */
  tier?: string;
}

interface Registry {
  workers: WorkerEntry[];
}

function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { workers: [] };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return { workers: [] };
  }
}

function saveRegistry(reg: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

/**
 * Register a new worker in the persistent registry. Automatically links
 * the worker to its parent if a parentId is provided.
 *
 * @param entry - Worker metadata to register
 */
export function registerWorker(entry: {
  id: string;
  pid: number;
  parentId?: string | null;
  spawner: WorkerEntry['spawner'];
  task: string;
  workDir: string;
  logFile: string;
  tier?: string;
}): void {
  const reg = loadRegistry();
  reg.workers.push({
    ...entry,
    parentId: entry.parentId ?? null,
    tier: entry.tier ?? 'standard',
    status: 'running',
    startedAt: new Date().toISOString(),
  });
  // Link to parent
  if (entry.parentId) {
    const parent = reg.workers.find(w => w.id === entry.parentId);
    if (parent) {
      parent.children = parent.children || [];
      parent.children.push(entry.id);
    }
  }
  saveRegistry(reg);
}

/**
 * Mark a worker as completed (done or failed) and optionally record its result.
 * The result is truncated to 500 characters.
 *
 * @param id - Worker identifier
 * @param status - Final status
 * @param result - Optional result text to store
 */
export function completeWorker(id: string, status: 'done' | 'failed', result?: string): void {
  const reg = loadRegistry();
  const worker = reg.workers.find(w => w.id === id);
  if (worker) {
    worker.status = status;
    worker.finishedAt = new Date().toISOString();
    if (result) worker.result = result.slice(0, 500);
  }
  saveRegistry(reg);

  // Cascading cancellation: if this worker failed, terminate all children
  if (status === 'failed') {
    cancelWorkerTree(id);
  }

  // Notify all registered completion callbacks
  if (worker) {
    for (const cb of completionCallbacks) {
      cb(worker);
    }
  }
}

/**
 * BFS through the children of a worker and cancel all running descendants.
 * Each running child is killed via SIGTERM, marked as failed with a
 * cancellation note, and its finishedAt timestamp set to now.
 *
 * This is called automatically by completeWorker() when a parent fails,
 * producing a cascading cancellation effect.
 *
 * @param rootId - ID of the worker whose children should be cancelled
 * @returns Array of worker IDs that were cancelled
 */
export function cancelWorkerTree(rootId: string): string[] {
  const reg = loadRegistry();
  const cancelled: string[] = [];
  const root = reg.workers.find(w => w.id === rootId);
  if (!root || !root.children) return cancelled;

  // BFS through the tree
  const queue = [...root.children];
  while (queue.length) {
    const id = queue.shift()!;
    const child = reg.workers.find(w => w.id === id);
    if (!child) continue;

    if (child.status === 'running') {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Process may already be gone — still mark as cancelled
      }
      child.status = 'failed';
      child.result = 'Cancelled: parent terminated';
      child.finishedAt = new Date().toISOString();
      cancelled.push(id);
    }

    // Enqueue grandchildren
    if (child.children) {
      queue.push(...child.children);
    }
  }

  saveRegistry(reg);
  return cancelled;
}

/**
 * Return all currently running workers from the registry.
 *
 * @returns Array of workers with status 'running'
 */
export function getActiveWorkers(): WorkerEntry[] {
  const reg = loadRegistry();
  return reg.workers.filter(w => w.status === 'running');
}

/**
 * Return workers that were started within the last N hours.
 *
 * @param hours - Lookback window in hours (default 24)
 * @returns Array of recent workers (any status)
 */
export function getRecentWorkers(hours = 24): WorkerEntry[] {
  const reg = loadRegistry();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return reg.workers.filter(w => new Date(w.startedAt).getTime() > cutoff);
}

/**
 * Return the full worker tree. If a rootId is provided, returns only the
 * subtree rooted at that worker (BFS traversal through children links).
 * Without a rootId, returns all workers in the registry.
 *
 * @param rootId - Optional root worker ID to start traversal from
 * @returns Array of workers forming the tree/subtree
 */
export function getWorkerTree(rootId?: string): WorkerEntry[] {
  const reg = loadRegistry();
  if (!rootId) return reg.workers;
  const result: WorkerEntry[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    const w = reg.workers.find(x => x.id === id);
    if (w) {
      result.push(w);
      if (w.children) queue.push(...w.children);
    }
  }
  return result;
}

/**
 * Remove workers older than the specified number of days from the registry.
 * Running workers are never pruned regardless of age.
 *
 * @param days - Retention period in days (default 7)
 */
export function pruneOld(days = 7): void {
  const reg = loadRegistry();
  const cutoff = Date.now() - Math.min(Math.max(days, 1), 365) * 24 * 60 * 60 * 1000;
  reg.workers = reg.workers.filter(w =>
    w.status === 'running' || new Date(w.startedAt).getTime() > cutoff
  );
  saveRegistry(reg);
}

/**
 * Run a health check on the worker registry, returning summary metrics.
 *
 * @returns {{ activeCount: number; totalCount: number; oldestWorkerAge: number }}
 *   activeCount — workers currently 'running'
 *   totalCount — all workers in the registry
 *   oldestWorkerAge — milliseconds since the oldest worker (any status) was started
 */
export function healthCheck(): { activeCount: number; totalCount: number; oldestWorkerAge: number } {
  const reg = loadRegistry();
  const now = Date.now();
  let activeCount = 0;
  let oldestStartedAt = Infinity;

  for (const w of reg.workers) {
    if (w.status === 'running') activeCount++;
    const started = new Date(w.startedAt).getTime();
    if (started < oldestStartedAt) oldestStartedAt = started;
  }

  return {
    activeCount,
    totalCount: reg.workers.length,
    oldestWorkerAge: reg.workers.length > 0 ? now - oldestStartedAt : 0,
  };
}

/**
 * Remove workers that were started more than 48 hours ago.
 * Running workers are never removed regardless of age.
 */
export function cleanupOldWorkers(): void {
  const reg = loadRegistry();
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  reg.workers = reg.workers.filter(w =>
    w.status === 'running' || new Date(w.startedAt).getTime() > cutoff
  );
  saveRegistry(reg);
}

/**
 * Return the filesystem path to the worker state JSON file.
 *
 * @returns Absolute path to the worker registry file
 */
export function getRegistryPath(): string {
  return REGISTRY_PATH;
}
