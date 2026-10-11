import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot } from './env-file.js';

const TASKS_DIR = join(installRoot(), 'tasks');
const FOLDERS = ['pending', 'active', 'completed', 'failed', 'archive'] as const;

export type TaskStatus = 'pending' | 'active' | 'completed' | 'failed' | 'archived';

export interface TaskRecord {
  id: string;
  task: string;
  context: string;
  workDir: string;
  status: TaskStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  assignedWorker: string | null;
  result: string | null;
  error: string | null;
  tokensIn: number;
  tokensOut: number;
  // --- Durable resilience state (heartbeat + crash-resume) ---
  // Written by the running orchestrator each turn/wave. A watchdog uses these to
  // detect a dead/stalled run and resume it from the persisted ledger instead of
  // losing the work. All optional for backward-compat with older task files.
  heartbeatAt?: number | null;   // last progress timestamp (liveness)
  pid?: number | null;           // process running this task (dead pid ⇒ orphan)
  resumeCount?: number;          // times this task has been resumed after death
  ledger?: Array<{ task: string; status: string; note: string }> | null; // "instructions on disk"
  delegationCount?: number;      // for the no-op guard across resumes
  producedChanges?: boolean;
}

function ensureFolders(): void {
  for (const f of FOLDERS) {
    const p = join(TASKS_DIR, f);
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

function statusToFolder(status: TaskStatus): string {
  return status === 'archived' ? 'archive' : status;
}

function folderToStatus(folder: string): TaskStatus {
  return folder === 'archive' ? 'archived' : folder as TaskStatus;
}

function taskPath(folder: string, id: string): string {
  return join(TASKS_DIR, folder, `${id}.json`);
}

function readTask(filePath: string): TaskRecord | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeTask(filePath: string, task: TaskRecord): void {
  // Atomic write: a concurrent reader must never observe a half-written file
  // (truncated JSON → JSON.parse throws → the task silently disappears).
  const tmp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

export function createTask(task: string, context?: string, workDir?: string): TaskRecord {
  ensureFolders();
  const id = randomUUID().slice(0, 8);
  const record: TaskRecord = {
    id,
    task,
    context: context || '',
    workDir: workDir || installRoot(),
    status: 'pending',
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    assignedWorker: null,
    result: null,
    error: null,
    tokensIn: 0,
    tokensOut: 0,
  };
  // Ensure the working directory exists before any worker is spawned into it.
  // A missing new-project workDir made workers fall back to /data and
  // recursively list the entire NAS (43MB tool-output dumps → context
  // exhaustion → retry storm). Creating it here covers every task-creation path.
  mkdirSync(record.workDir, { recursive: true });
  writeTask(taskPath('pending', id), record);
  return record;
}

export function listTasks(status?: TaskStatus): TaskRecord[] {
  ensureFolders();
  const foldersToScan = status ? [statusToFolder(status)] : FOLDERS as unknown as string[];
  const results: TaskRecord[] = [];

  for (const folder of foldersToScan) {
    const dir = join(TASKS_DIR, folder);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const task = readTask(join(dir, file));
      if (task) results.push(task);
    }
  }

  return results.sort((a, b) => b.createdAt - a.createdAt);
}

export function getTask(id: string): TaskRecord | null {
  ensureFolders();
  for (const folder of FOLDERS) {
    const path = taskPath(folder as string, id);
    if (existsSync(path)) return readTask(path);
  }
  return null;
}

function moveTask(id: string, fromFolder: string, toFolder: string, updates: Partial<TaskRecord>): TaskRecord | null {
  const from = taskPath(fromFolder, id);
  if (!existsSync(from)) return null;
  const task = readTask(from);
  if (!task) return null;

  Object.assign(task, updates);
  const to = taskPath(toFolder, id);
  writeTask(to, task);
  // The old copy MUST go, or the task is counted in two folders. Retry once,
  // then log loudly rather than silently leaving a duplicate.
  try {
    unlinkSync(from);
  } catch {
    try { unlinkSync(from); } catch {
      console.error(`[task-store] failed to remove ${from} after moving task ${id} to ${toFolder} — task may be double-counted`);
    }
  }

  return task;
}

export function activateTask(id: string, workerId?: string): TaskRecord | null {
  return moveTask(id, 'pending', 'active', {
    status: 'active',
    startedAt: Date.now(),
    assignedWorker: workerId || null,
  });
}

export function completeTask(id: string, result?: string, tokens?: { in: number; out: number }): TaskRecord | null {
  return moveTask(id, 'active', 'completed', {
    status: 'completed',
    completedAt: Date.now(),
    result: result || null,
    ...(tokens ? { tokensIn: tokens.in, tokensOut: tokens.out } : {}),
  });
}

export function failTask(id: string, error: string, tokens?: { in: number; out: number }): TaskRecord | null {
  return moveTask(id, 'active', 'failed', {
    status: 'failed',
    completedAt: Date.now(),
    error,
    ...(tokens ? { tokensIn: tokens.in, tokensOut: tokens.out } : {}),
  });
}

export function cancelTask(id: string): TaskRecord | null {
  const task = getTask(id);
  if (!task || (task.status !== 'active' && task.status !== 'pending')) return null;
  const fromFolder = task.status;
  return moveTask(id, fromFolder, 'failed', {
    status: 'failed',
    completedAt: Date.now(),
    error: 'Cancelled by user',
  });
}

/**
 * Reconcile orphaned tasks on daemon startup. The orchestrator runs in-process,
 * so at boot nothing it owns can still be running — any task still marked
 * "active" is a guaranteed orphan from a prior process that crashed, was killed,
 * or was terminated by a reboot. Fail those so they don't linger as false
 * "active" builds. Returns the number reconciled.
 */
export function reconcileActiveTasks(reason = 'Interrupted by daemon restart/reboot'): number {
  ensureFolders();
  const dir = join(TASKS_DIR, 'active');
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const task = readTask(join(dir, file));
    if (!task) continue;
    if (failTask(task.id, reason)) count++;
  }
  if (count > 0) {
    console.warn(`[task-store] reconciled ${count} orphaned "active" task(s) → failed (${reason})`);
  }
  return count;
}

/**
 * Heartbeat + persist the running orchestrator's live state onto its active task
 * file (in place, no folder move). Called each turn/wave. This is what makes a
 * run resumable: the ledger ("instructions on disk") + pid + timestamp let the
 * watchdog tell a live run from a dead one and pick up where it left off.
 * No-op if the task is no longer active (already completed/failed).
 */
export function heartbeatTask(id: string, patch: Partial<TaskRecord>): void {
  const p = taskPath('active', id);
  if (!existsSync(p)) return;
  const task = readTask(p);
  if (!task) return;
  Object.assign(task, patch, { heartbeatAt: Date.now() });
  writeTask(p, task);
}

/**
 * Requeue a dead/stalled active task back to pending so the runner picks it up
 * and resumes it. Preserves the ledger/delegationCount/producedChanges so the
 * resumed run knows what was already done and only re-dispatches the rest.
 */
export function requeueForResume(id: string, resumeCount: number): TaskRecord | null {
  return moveTask(id, 'active', 'pending', {
    status: 'pending',
    resumeCount,
    startedAt: null,
    assignedWorker: null,
    pid: null,
  });
}

// A still-`active` task that has delegated this many worker waves while
// producedChanges is STILL false has run the delegate/orchestrator retry cycle to
// exhaustion with nothing committed — i.e. it is doom-looping, not progressing.
// The direct-delegation path caps at 4 retries per task (routes/tasks.ts
// MAX_RETRIES) and the runner at 3 resumes, so >=4 no-op delegations is a full
// failed cycle. Kept as a named constant so the threshold is auditable.
const DELEGATION_THRASH_LIMIT = 4;

/**
 * Boot reconcile, resume-aware + thrash-guarded. Any task still "active" after a
 * daemon restart is an orphan (its process is gone). A genuinely-interrupted run
 * that was making progress should resume from its ledger; a doom-looping run that
 * never committed output must NOT — reviving it just restarts the loop (and, until
 * the HTTP cancel route existed, it could not be stopped). So:
 *
 *   - producedChanges === true  → progressing → resume (capped by maxResumes).
 *   - fresh interrupt (resumeCount 0, under the delegation thrash limit) → resume,
 *     even with producedChanges false — it may simply have died before its first
 *     commit.
 *   - no progress (producedChanges false) AND evidence of exhausted effort
 *     (already resumed at least once, OR delegated >= DELEGATION_THRASH_LIMIT times
 *     with nothing to show) → FAIL-LOUD (thrash guard). An empty ledger after a
 *     prior resume is the same no-progress signal (rc >= 1 covers it).
 *   - resumeCount >= maxResumes → FAIL-LOUD regardless (hard cap, unchanged).
 *
 * Deterministic: decisions depend only on persisted counters, no timing/randomness.
 */
export function reconcileActiveTasksForResume(maxResumes = 3): { resumed: number; failed: number } {
  ensureFolders();
  const dir = join(TASKS_DIR, 'active');
  if (!existsSync(dir)) return { resumed: 0, failed: 0 };
  let resumed = 0, failed = 0;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const task = readTask(join(dir, file));
    if (!task) continue;
    const rc = task.resumeCount || 0;
    const madeProgress = task.producedChanges === true;
    const delegations = task.delegationCount || 0;

    // Hard cap — never resume more than maxResumes times, whatever the progress.
    if (rc >= maxResumes) {
      if (failTask(task.id, `Abandoned after ${rc} resume attempt(s) (daemon restart). Fail-loud.`)) failed++;
      continue;
    }

    // Thrash guard — no committed output AND evidence the effort is exhausted.
    const thrashing = !madeProgress && (rc >= 1 || delegations >= DELEGATION_THRASH_LIMIT);
    if (thrashing) {
      const reason = `Not resumed: no progress after ${rc} resume(s), ${delegations} delegation(s), producedChanges=false. Fail-loud (thrash guard).`;
      if (failTask(task.id, reason)) failed++;
      continue;
    }

    // Legitimate resume — progressing, or a fresh interrupt worth one attempt.
    if (requeueForResume(task.id, rc + 1)) resumed++;
  }
  if (resumed || failed) {
    console.warn(`[task-store] boot reconcile: ${resumed} task(s) requeued for resume, ${failed} failed-loud (thrash-guarded)`);
  }
  return { resumed, failed };
}

export function archiveTasks(olderThanHours = 24): number {
  ensureFolders();
  const cutoff = Date.now() - (olderThanHours * 60 * 60 * 1000);
  let count = 0;

  for (const folder of ['completed', 'failed']) {
    const dir = join(TASKS_DIR, folder);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = join(dir, file);
      const task = readTask(filePath);
      if (task && task.completedAt && task.completedAt < cutoff) {
        task.status = 'archived';
        writeTask(taskPath('archive', task.id), task);
        try { unlinkSync(filePath); } catch { /* ignore */ }
        count++;
      }
    }
  }

  return count;
}

export function taskCounts(): Record<string, number> {
  ensureFolders();
  const counts: Record<string, number> = {};
  for (const folder of FOLDERS) {
    const dir = join(TASKS_DIR, folder);
    if (!existsSync(dir)) { counts[folderToStatus(folder)] = 0; continue; }
    counts[folderToStatus(folder)] = readdirSync(dir).filter(f => f.endsWith('.json')).length;
  }
  return counts;
}
