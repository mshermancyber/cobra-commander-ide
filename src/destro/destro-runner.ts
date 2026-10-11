// forked from core/task-runner.ts @ 2026-07-04 — DOWNSTREAM fork, do not backport to core

// TODO: wire to incident-store
// import * as store from './incident-store.js';

// TODO: stub — replace when investigation orchestrator is built
function stubInvestigateIncident(incident: { id: string; resumeCount?: number }): Promise<void> {
  console.log(`[destro-runner] stub investigating incident ${incident.id}`);
  return Promise.resolve();
}

/**
 * Durable incident investigation + crash-resilience, owned by the daemon.
 *
 * - POLLER: claims `open` incidents and investigates them IN the daemon process
 *   (which is a persistent systemd service), so an investigation is never tied to
 *   an ephemeral shell.
 * - WATCHDOG: finds `investigating` incidents whose process is dead or whose
 *   heartbeat has gone stale and requeues them for resume (from the persisted
 *   ledger), or fails them LOUD once they exhaust DESTRO_MAX_RESUMES so nothing
 *   loops forever.
 */

const POLL_MS = 4_000;              // how often to claim open work
const WATCHDOG_MS = 60_000;         // how often to hunt dead/stalled runs
const STALL_MS = 5 * 60_000;        // no heartbeat this long ⇒ presumed stuck
const DESTRO_MAX_CONCURRENT = 2;    // investigations running at once in this daemon
const DESTRO_MAX_RESUMES = 3;       // give up (fail-loud) after this many resumes

// Incident ids currently executing in THIS process — the watchdog must never
// touch a run we are actively driving.
const running = new Set<string>();

function pidAlive(pid?: number | null): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function claimAndRun(incident: { id: string; resumeCount?: number }): void {
  running.add(incident.id);
  // stubInvestigateIncident never throws (writes terminal state itself).
  void stubInvestigateIncident(incident).finally(() => running.delete(incident.id));
}

function pollOpen(): void {
  if (running.size >= DESTRO_MAX_CONCURRENT) return;
  // TODO: wire to incident-store
  // const open = store.listIncidents('open').sort((a, b) => a.createdAt - b.createdAt);
  const open: Array<{ id: string; createdAt: number; resumeCount?: number }> = [];
  for (const i of open) {
    if (running.size >= DESTRO_MAX_CONCURRENT) break;
    if (running.has(i.id)) continue;
    // TODO: Atomic claim: open → investigating. If it returns null another claimer won.
    // const claimed = store.activateIncident(i.id, `daemon:${process.pid}`);
    // if (!claimed) continue;
    const claimed = i;
    console.log(`[destro-runner] investigating incident ${claimed.id}${(claimed.resumeCount || 0) > 0 ? ` (resume #${claimed.resumeCount})` : ''}`);
    claimAndRun(claimed);
  }
}

function watchdog(): void {
  // TODO: wire to incident-store
  // const investigating = store.listIncidents('investigating');
  const investigating: Array<{ id: string; pid?: number | null; heartbeatAt?: number; resumeCount?: number }> = [];
  const now = Date.now();
  for (const i of investigating) {
    if (running.has(i.id)) continue;                 // we're driving it — healthy
    const dead = !pidAlive(i.pid);                   // owning process gone
    const stale = !i.heartbeatAt || (now - i.heartbeatAt) > STALL_MS;
    if (!dead && !stale) continue;                   // alive elsewhere & progressing
    const rc = i.resumeCount || 0;
    if (rc >= DESTRO_MAX_RESUMES) {
      // TODO: wire to incident-store
      // store.failIncident(i.id, `Abandoned after ${rc} resume attempt(s) (dead=${dead}, stale=${stale}). Fail-loud — re-dispatch manually.`);
      console.warn(`[destro-runner] incident ${i.id} FAILED-LOUD after ${rc} resumes`);
      continue;
    }
    // TODO: wire to incident-store
    // store.requeueForResume(i.id, rc + 1);          // → open; poller resumes it
    console.warn(`[destro-runner] resuming orphaned/stalled incident ${i.id} (attempt ${rc + 1}/${DESTRO_MAX_RESUMES}, dead=${dead}, stale=${stale})`);
  }
}

/** Start the poller + watchdog. Returns a teardown function. */
export function startDestroRunner(): () => void {
  const p = setInterval(() => { try { pollOpen(); } catch (e) { console.error('[destro-runner] poll error:', e); } }, POLL_MS);
  const w = setInterval(() => { try { watchdog(); } catch (e) { console.error('[destro-runner] watchdog error:', e); } }, WATCHDOG_MS);
  // Don't let these timers keep the event loop alive on shutdown.
  p.unref?.(); w.unref?.();
  console.log(`[destro-runner] started (poll ${POLL_MS}ms, watchdog ${WATCHDOG_MS}ms, max ${DESTRO_MAX_CONCURRENT} concurrent, ${DESTRO_MAX_RESUMES} resumes)`);
  return () => { clearInterval(p); clearInterval(w); };
}
