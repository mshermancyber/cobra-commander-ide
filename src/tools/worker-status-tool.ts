import { getActiveWorkers, getRecentWorkers, getWorkerTree } from '../core/worker-registry.js';
import { execSync } from 'node:child_process';
import type { ToolDefinition } from '../core/types.js';

export const workerStatusTool: ToolDefinition = {
  name: 'worker_status',
  description: 'Check status of your engineering department workers. Shows active, recent, and tree views. Always call this BEFORE answering questions about worker/team status.',
  input_schema: {
    type: 'object',
    properties: {
      view: {
        type: 'string',
        enum: ['active', 'recent', 'tree', 'all'],
        description: 'active=running workers, recent=last 24h, tree=hierarchy from rootId, all=active+recent combined',
      },
      rootId: {
        type: 'string',
        description: 'For tree view: root worker ID to trace descendants from',
      },
    },
    required: ['view'],
  },
};

export function executeWorkerStatusTool(input: Record<string, unknown>): { result: string; is_error: boolean } {
  const view = input.view as string;

  try {
    // Also check ps for any live processes not in registry
    let psOutput = '';
    try {
      psOutput = execSync('ps aux | grep -E "delegate\\.ts|build-round" | grep -v grep', { encoding: 'utf-8', timeout: 5000 });
    } catch { /* no running processes */ }

    let workers;
    if (view === 'tree' && input.rootId) {
      workers = getWorkerTree(input.rootId as string);
    } else if (view === 'active') {
      workers = getActiveWorkers();
    } else if (view === 'recent') {
      workers = getRecentWorkers(24);
    } else {
      workers = [...getActiveWorkers(), ...getRecentWorkers(24).filter(w => w.status !== 'running')];
    }

    // Validate active workers are actually still running
    for (const w of workers) {
      if (w.status === 'running') {
        try {
          execSync(`ps -p ${w.pid} -o pid= 2>/dev/null`, { encoding: 'utf-8' });
        } catch {
          w.status = 'done';
          w.result = '(process exited, status unknown — check log)';
        }
      }
    }

    const lines = workers.map(w => {
      const parent = w.parentId ? ` ← parent:${w.parentId}` : ' (root)';
      const children = w.children?.length ? ` → children:[${w.children.join(',')}]` : '';
      const elapsed = w.status === 'running'
        ? ` (${Math.round((Date.now() - new Date(w.startedAt).getTime()) / 1000)}s ago)`
        : ` (finished ${w.finishedAt || 'unknown'})`;
      return `[${w.status.toUpperCase()}] ${w.id} (pid:${w.pid}) spawner:${w.spawner}${parent}${children}${elapsed}\n  task: ${w.task}\n  log: ${w.logFile}${w.result ? `\n  result: ${w.result}` : ''}`;
    });

    let output = `=== Worker Registry (${view}) ===\n`;
    output += `Total: ${workers.length} workers\n\n`;
    output += lines.join('\n\n') || '(none)';

    if (psOutput) {
      output += `\n\n=== Live Processes (ps) ===\n${psOutput}`;
    }

    return { result: output, is_error: false };
  } catch (e: any) {
    return { result: `Error: ${e.message}`, is_error: true };
  }
}
