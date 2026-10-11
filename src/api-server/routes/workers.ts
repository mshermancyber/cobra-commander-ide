import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware/error-handler.js';
import { getRecentWorkers } from '../../core/worker-registry.js';
import { workerProjector } from '../../core/worker-projector.js';

function clampTask(task: string, maxLen = 2000): string {
  if (task.length <= maxLen) return task;
  return task.slice(0, maxLen) + '…';
}

export function createWorkerRoutes() {
  async function listWorkers(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const statusFilter = url.searchParams.get('status');

    let workers = getRecentWorkers(6)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    if (statusFilter) {
      workers = workers.filter(w => w.status === statusFilter);
    }

    const mapped = workers.slice(0, 10).map(w => {
      const proj = workerProjector.getProjection(w.id);
      const start = new Date(w.startedAt).getTime();
      const finish = w.finishedAt ? new Date(w.finishedAt).getTime() : undefined;

      return {
        id: w.id,
        workerId: w.id,
        pid: w.pid,
        status: w.status,
        tier: w.tier ?? 'standard',
        // Full-ish task so the UI can show a preview and expand it.
        task: clampTask(w.task),
        description: clampTask(w.task),
        logPath: w.logFile,
        startedAt: start,
        start,
        finish,
        // Frozen duration for finished workers so the UI doesn't tick forever.
        elapsed: finish ? finish - start : undefined,
        currentTool: proj?.currentTool ?? null,
        turnsCompleted: proj?.turnsCompleted ?? 0,
      };
    });

    sendJson(res, 200, mapped);
  }

  return { listWorkers };
}
