import { workerEvents, type WorkerEvent } from './event-bus.js';
import { processRegistry } from './process-registry.js';
import { runCoordinator } from './run-coordinator.js';
import { getActiveWorkers } from './worker-registry.js';

/**
 * Log a message to stderr with a timestamp. Used by reactive-bus handlers
 * to produce structured diagnostic output without polluting stdout.
 */
function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[reactive-bus ${ts}] ${msg}\n`);
}

/**
 * Look up the task key (run key) associated with a given worker ID.
 * Returns undefined if the worker doesn't hold any active run.
 */
function findTaskKeyForWorker(workerId: string): string | undefined {
  for (const [taskKey, run] of runCoordinator.getActiveRuns()) {
    if (run.workerId === workerId) return taskKey;
  }
  return undefined;
}

/**
 * Look up the PID of a worker by its ID from the worker registry.
 * Returns undefined if the worker is not found or not active.
 */
function findWorkerPid(workerId: string): number | undefined {
  const active = getActiveWorkers();
  const entry = active.find(w => w.id === workerId);
  return entry?.pid;
}

/**
 * Wire reactive subscriptions against the shared event bus.
 *
 * Subscriptions installed:
 *   - retry.exhausted → logs the exhausted worker and emits an escalation
 *     event so upstream orchestrator logic can intervene.
 *   - doom.detected  → if a worker has hit the doom-loop detector for the
 *     second time (count >= 2), the worker's process tree is killed via
 *     the process-registry and a cancellation event is emitted.
 *   - task.completed → automatically releases the run held by the worker
 *     via the run-coordinator so other dispatchers can acquire the task key.
 *
 * Call this once during startup. Returns an unsubscribe function that
 * removes all three subscriptions.
 */
export function initReactiveBus(): () => void {
  const unsub1 = workerEvents.on(handleRetryExhausted);
  const unsub2 = workerEvents.on(handleDoomDetected);
  const unsub3 = workerEvents.on(handleTaskCompleted);

  return () => {
    unsub1();
    unsub2();
    unsub3();
  };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

function handleRetryExhausted(event: WorkerEvent): void {
  if (event.type !== 'retry.exhausted') return;

  log(
    `ESCALATION: Worker ${event.workerId} exhausted retries after ` +
    `${event.attempts} attempt(s). Last error: ${event.lastError.slice(0, 200)}`,
  );

  // Emit an escalation event so orchestrator / circuit-breaker can react.
  workerEvents.emit({
    type: 'escalation.triggered',
    workerId: event.workerId,
    reason: 'retry.exhausted',
    detail: `attempts=${event.attempts} error=${event.lastError.slice(0, 200)}`,
    timestamp: Date.now(),
  });
}

function handleDoomDetected(event: WorkerEvent): void {
  if (event.type !== 'doom.detected') return;

  // 2nd strike for the same worker — auto-cancel.
  if (event.count >= 2) {
    const pid = findWorkerPid(event.workerId);
    log(
      `DOOM-CANCEL: Worker ${event.workerId} (pid=${pid ?? '?'}) ` +
      `hit doom-loop strike ${event.count} (tool: ${event.tool}).`,
    );

    if (pid !== undefined) {
      log(`  → Killing process tree for pid ${pid}`);
      processRegistry.killTree(pid);
    } else {
      log(`  → No PID found for worker ${event.workerId}; cannot killTree`);
    }

    workerEvents.emit({
      type: 'doom.cancelled',
      workerId: event.workerId,
      tool: event.tool,
      count: event.count,
      timestamp: Date.now(),
    });
  }
}

function handleTaskCompleted(event: WorkerEvent): void {
  if (event.type !== 'task.completed') return;

  const taskKey = findTaskKeyForWorker(event.workerId);
  if (taskKey) {
    runCoordinator.releaseRun(taskKey);
    log(`RELEASE: Released run '${taskKey}' owned by worker ${event.workerId}`);
  }
}
