import * as store from './task-store.js';
import { loadConfig, hydrateWorkerKey } from './config.js';
import { Orchestrator } from './orchestrator.js';
import type { OrchestratorCallbacks, LedgerSnapshot } from './orchestrator.js';
import { Worker } from './worker.js';

/**
 * Run an orchestrator for a task that is ALREADY marked active (claimed by the
 * daemon's task-runner). Persists a heartbeat + the live ledger to disk every
 * turn/wave so a watchdog can resume this run if the process dies, and honors a
 * resume seed when the task carries a prior ledger. Resolves when the run
 * finishes (task moved to completed/failed). Never throws — terminal state is
 * always written to the task store.
 */
export async function runOrchestratorForTask(taskRecord: store.TaskRecord): Promise<void> {
  const id = taskRecord.id;
  const requirements = taskRecord.task;
  const projectPath = taskRecord.workDir;
  const isResume = (taskRecord.resumeCount || 0) > 0 && Array.isArray(taskRecord.ledger) && taskRecord.ledger.length > 0;

  try {
    const config = loadConfig({ workDir: projectPath });
    const hydrated = await hydrateWorkerKey(config);
    hydrated.workDir = projectPath;

    // Every orchestrator build gets a post-delegation security scan when a scanner
    // is configured (loadConfig defaults autoScan to false, which is why builds
    // were never scanned). Opt out with CC_AUTO_SCAN=0.
    hydrated.autoScan = process.env.CC_AUTO_SCAN !== '0';

    // Stamp pid immediately so the watchdog can tell a live run from a corpse.
    store.heartbeatTask(id, { pid: process.pid });

    const callbacks: OrchestratorCallbacks = {
      // Persist heartbeat + resumable ledger ("instructions on disk") each turn/wave.
      onHeartbeat: (snap: LedgerSnapshot) => store.heartbeatTask(id, {
        pid: process.pid,
        ledger: snap.ledger,
        delegationCount: snap.delegationCount,
        producedChanges: snap.producedChanges,
      }),
      onOrchestratorThinking: (t) => console.log(`[orch:${id}] think: ${t.slice(0, 120)}`),
      onOrchestratorExploring: (tool, summary) => console.log(`[orch:${id}] explore: ${tool} ${summary}`),
      onDelegating: (task, model) => console.log(`[orch:${id}] delegate: ${task.slice(0, 80)} (${model || 'default'})`),
      onParallelDelegating: (count) => console.log(`[orch:${id}] parallel: ${count} tasks`),
      onWorkerUpdate: (t) => console.log(`[orch:${id}] worker: ${t.slice(0, 80)}`),
      onWorkerToolCall: (name) => console.log(`[orch:${id}] tool: ${name}`),
      onWorkerToolResult: (name, _r, isErr) => console.log(`[orch:${id}] result: ${name} ${isErr ? 'ERR' : 'ok'}`),
      onReviewing: (diff) => console.log(`[orch:${id}] review: ${diff || 'no diff'}`),
      onRetrying: (task, attempt, detail) => console.log(`[orch:${id}] retry ${detail?.scope ?? ''} attempt ${attempt}: ${task.slice(0, 60)}${detail?.error ? ` — reason: ${detail.error.replace(/\s+/g, ' ').slice(0, 500)}` : ''}`),
      onTokenUsage: (role, input, output) => { if (role === 'orchestrator') console.log(`[orch:${id}] tokens in=${input} out=${output}`); },
      onDelegationComplete: (task, status) => console.log(`[orch:${id}] done: ${task.slice(0, 60)} → ${status}`),
    };

    const workerRunner = async (task: string, context: string, criteria: string[], modelName?: string, _role?: unknown, workDir?: string, workerId?: string) => {
      // Deep-copy `worker` so a per-worker model override doesn't mutate the
      // shared hydrated config and race other concurrent workers.
      const workerConfig = { ...hydrated, worker: { ...hydrated.worker } };
      if (workDir) workerConfig.workDir = workDir;
      if (modelName) {
        const pool = workerConfig.workerPool.find((w: any) => w.name === modelName || w.provider.model === modelName);
        if (pool) Object.assign(workerConfig.worker, pool.provider);
      }
      const worker = new Worker(workerConfig, {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: () => {},
        onTokenUsage: () => {},
      }, undefined, undefined, workerId);
      return worker.executeTask(task, context, criteria);
    };

    const orchestrator = new Orchestrator(hydrated, callbacks, workerRunner);
    if (isResume) {
      orchestrator.seedFromLedger({
        originalRequirement: requirements,
        ledger: taskRecord.ledger as LedgerSnapshot['ledger'],
        delegationCount: taskRecord.delegationCount || 0,
        producedChanges: !!taskRecord.producedChanges,
      });
      console.log(`[orch:${id}] RESUMING (attempt ${taskRecord.resumeCount}, ${(taskRecord.ledger || []).length} ledger items)`);
    }

    const result = await orchestrator.processUserMessage(requirements);

    // FAIL-LOUD GUARD: a run that delegated nothing AND changed nothing is a
    // silent no-op (context overflow / reasoning-model empty response), NOT a
    // completion. Never mark it completed — that was the old false-green bug.
    if (!orchestrator.anyLedgerCompleted && !orchestrator.changedFiles) {
      const reason = `No-op run: no delegation completed and no file changes. Re-dispatch smaller.`;
      store.failTask(id, reason, { in: 0, out: 0 });
      console.log(`[orch:${id}] FAILED (no-op)`);
    } else if (result?.startsWith('INCOMPLETE:')) {
      // PLAN-AUDIT GATE: the done-criteria gate detected unaddressed directive
      // items after exhausting its nudges. Mark as failed so the run gets
      // re-dispatched, not silently closed as "complete".
      store.failTask(id, result, { in: 0, out: 0 });
      console.log(`[orch:${id}] FAILED (INCOMPLETE — gap items not addressed)`);
    } else if (result?.startsWith('BUDGET_EXCEEDED:')) {
      store.failTask(id, result, { in: 0, out: 0 });
      console.log(`[orch:${id}] FAILED (BUDGET_EXCEEDED) ${result.slice(17, 120)}`);
    } else {
      const summary = result?.trim()
        ? result
        : `Completed ${orchestrator.delegationsMade} delegation(s)${orchestrator.changedFiles ? ' with file changes' : ''}.`;
      store.completeTask(id, summary, { in: 0, out: 0 });
      console.log(`[orch:${id}] COMPLETED (${orchestrator.delegationsMade} delegations, changes=${orchestrator.changedFiles})`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    store.failTask(id, errMsg, { in: 0, out: 0 });
    console.log(`[orch:${id}] FAILED: ${errMsg}`);
    if (err instanceof Error && err.stack) console.log(`[orch:${id}] STACK:\n${err.stack}`);
  }
}

/**
 * Legacy fire-and-forget entry: activate a pending task then run it in THIS
 * process. Prefer dropping a pending task and letting the daemon's task-runner
 * execute it durably (survives process death). Kept for direct-dispatch scripts.
 */
export function fireOrchestrator(taskRecord: store.TaskRecord, _requirements?: string, _projectPath?: string): void {
  const active = store.activateTask(taskRecord.id);
  if (!active) return; // already claimed/running elsewhere
  void runOrchestratorForTask(active);
}
