import * as store from './task-store.js';
import { runOrchestratorForTask } from './orchestrator-launcher.js';

/**
 * Durable task execution + crash-resilience, owned by the daemon.
 *
 * - POLLER: claims `pending` tasks and runs them IN the daemon process (which is
 *   a persistent systemd service), so a run is never tied to an ephemeral shell.
 * - WATCHDOG: finds `active` tasks whose process is dead or whose heartbeat has
 *   gone stale and requeues them for resume (from the persisted ledger), or
 *   fails them LOUD once they exhaust MAX_RESUMES so nothing loops forever.
 */

const POLL_MS = 4_000;            // how often to claim pending work
const WATCHDOG_MS = 60_000;       // how often to hunt dead/stalled runs
const STALL_MS = 5 * 60_000;      // no heartbeat this long ⇒ presumed stuck
const MAX_CONCURRENT = 2;         // orchestrators running at once in this daemon
const MAX_RESUMES = 3;            // give up (fail-loud) after this many resumes

// Task ids currently executing in THIS process — the watchdog must never touch
// a run we are actively driving.
const running = new Set<string>();

function pidAlive(pid?: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function claimAndRun(task: store.TaskRecord): void {
  running.add(task.id);
  // runOrchestratorForTask never throws (writes terminal state itself).
  void runOrchestratorForTask(task).finally(() => running.delete(task.id));
}

function pollPending(): void {
  if (running.size >= MAX_CONCURRENT) return;
  const pending = store.listTasks('pending').sort((a, b) => a.createdAt - b.createdAt);
  for (const t of pending) {
    if (running.size >= MAX_CONCURRENT) break;
    if (running.has(t.id)) continue;
    // Atomic claim: pending → active. If it returns null another claimer won.
    const claimed = store.activateTask(t.id, `daemon:${process.pid}`);
    if (!claimed) continue;
    console.log(`[task-runner] running task ${claimed.id}${(claimed.resumeCount || 0) > 0 ? ` (resume #${claimed.resumeCount})` : ''}`);
    claimAndRun(claimed);
  }
}

function watchdog(): void {
  const active = store.listTasks('active');
  const now = Date.now();
  for (const t of active) {
    if (running.has(t.id)) continue;                 // we're driving it — healthy
    const dead = !pidAlive(t.pid);                   // owning process gone
    const stale = !t.heartbeatAt || (now - t.heartbeatAt) > STALL_MS;
    if (!dead && !stale) continue;                   // alive elsewhere & progressing
    const rc = t.resumeCount || 0;
    if (rc >= MAX_RESUMES) {
      store.failTask(t.id, `Abandoned after ${rc} resume attempt(s) (dead=${dead}, stale=${stale}). Fail-loud — re-dispatch manually.`);
      console.warn(`[task-runner] task ${t.id} FAILED-LOUD after ${rc} resumes`);
      continue;
    }
    store.requeueForResume(t.id, rc + 1);            // → pending; poller resumes it
    console.warn(`[task-runner] resuming orphaned/stalled task ${t.id} (attempt ${rc + 1}/${MAX_RESUMES}, dead=${dead}, stale=${stale})`);
  }
}

/** Start the poller + watchdog. Returns a teardown function. */
export function startTaskRunner(): () => void {
  const p = setInterval(() => { try { pollPending(); } catch (e) { console.error('[task-runner] poll error:', e); } }, POLL_MS);
  const w = setInterval(() => { try { watchdog(); } catch (e) { console.error('[task-runner] watchdog error:', e); } }, WATCHDOG_MS);
  // Don't let these timers keep the event loop alive on shutdown.
  p.unref?.(); w.unref?.();
  console.log(`[task-runner] started (poll ${POLL_MS}ms, watchdog ${WATCHDOG_MS}ms, max ${MAX_CONCURRENT} concurrent, ${MAX_RESUMES} resumes)`);
  return () => { clearInterval(p); clearInterval(w); };
}
