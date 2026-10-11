import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { broadcast } from '../websocket/events.js';
import type { Config } from '../../core/config.js';
import { classifyError, autoFix } from '../../core/error-classifier.js';
import * as store from '../../core/task-store.js';
import { installRoot } from '../../core/env-file.js';

function loadProjectCatalog(projectDir: string): string {
  // Look for existing catalog files in the project
  const catalogPatterns = ['full-catalog.md', 'catalog.md'];
  for (const pat of catalogPatterns) {
    try {
      const files = readdirSync(projectDir).filter(f => f.endsWith(pat));
      if (files.length > 0) {
        const content = readFileSync(join(projectDir, files[0]), 'utf-8');
        if (content.length > 500) {
          const trimmed = content.length > 30000 ? content.slice(0, 30000) + '\n...[catalog truncated]' : content;
          return `\n\n## PROJECT CATALOG (from ${files[0]})\nUse this to find correct function signatures, exports, and file locations:\n\n${trimmed}\n`;
        }
      }
    } catch { /* dir not readable */ }
  }

  // No catalog found — generate lightweight exports summary from source files
  try {
    const srcDirs = ['src', 'server/src', 'lib'].map(d => join(projectDir, d)).filter(d => existsSync(d));
    if (srcDirs.length === 0) return '';

    const exports: string[] = [];
    let fileCount = 0;
    const MAX_FILES = 60;

    function scanDir(dir: string) {
      if (fileCount >= MAX_FILES) return;
      try {
        for (const entry of readdirSync(dir)) {
          if (fileCount >= MAX_FILES) break;
          const full = join(dir, entry);
          try {
            const st = statSync(full);
            if (st.isDirectory() && !entry.startsWith('.') && entry !== 'node_modules' && entry !== 'dist') {
              scanDir(full);
            } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts') && !entry.endsWith('.test.ts')) {
              const content = readFileSync(full, 'utf-8');
              const lines = content.split('\n');
              const relPath = relative(projectDir, full);
              const sigs: string[] = [];
              for (const line of lines) {
                const m = line.match(/^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+(\w+)/);
                if (m) sigs.push(m[0].trim());
              }
              if (sigs.length > 0) {
                exports.push(`### ${relPath}\n${sigs.join('\n')}`);
                fileCount++;
              }
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    for (const d of srcDirs) scanDir(d);
    if (exports.length === 0) return '';

    return `\n\n## PROJECT EXPORTS (auto-scanned, ${fileCount} files)\nVerify signatures by reading the actual files before using:\n\n${exports.join('\n\n')}\n`;
  } catch { return ''; }
}

export function createTaskRoutes(config: Config) {
  async function parseBody(req: IncomingMessage): Promise<any> {
    const MAX_BODY = 2 * 1024 * 1024; // 2MB cap prevents memory-exhaustion DoS
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          req.destroy();
          resolve({});
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
      req.on('error', reject);
    });
  }

  async function delegateTask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.task) { sendError(res, 400, 'Missing "task" field'); return; }

    let workDir = body.workDir || '';
    if (!workDir) {
      // Infer the project dir from the task text. Collect every /data/<name>
      // path and prefer one that is NOT cobra-commander's own tree, so a task
      // that merely references the install root (e.g. its own docs) doesn't get
      // its work written into CC's source. Pick the last such match.
      const searchText = `${body.task || ''} ${body.context || ''}`;
      const matches = [...searchText.matchAll(/\/data\/[a-zA-Z0-9_-]+(?:\/server)?/g)].map(m => m[0]);
      const nonSelf = matches.filter(p => !p.startsWith(installRoot()));
      workDir = (nonSelf.length ? nonSelf[nonSelf.length - 1] : matches[matches.length - 1]) || '';
    }

    // Only fall back to CC's own tree when the work is explicitly about it;
    // otherwise mis-scoped work must not pollute the install root.
    if (!workDir) {
      const selfText = `${body.task || ''} ${body.context || ''}`.toLowerCase();
      workDir = /cobra|\borchestrator\b/.test(selfText) ? installRoot() : (process.env.CC_WORKSPACE_ROOT || process.cwd());
    }

    store.archiveTasks(0);
    const record = store.createTask(body.task, body.context || '', workDir);
    sendJson(res, 202, { taskId: record.id, status: 'started' });

    (async () => {
      store.activateTask(record.id);
      const MAX_RETRIES = 4;
      let totalIn = 0;
      let totalOut = 0;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const { Worker } = await import('../../core/worker.js');
          const { hydrateWorkerKey } = await import('../../core/config.js');
          const taskConfig = { ...config };
          if (workDir) taskConfig.workDir = workDir;
          const hydrated = await hydrateWorkerKey(taskConfig);
          const worker = new Worker(hydrated, {
            onText: (t: string) => broadcast({ type: 'task:text', taskId: record.id, text: t }),
            onToolCall: (n: string, a: Record<string, unknown>) => broadcast({ type: 'task:tool_call', taskId: record.id, tool: n, args: a }),
            onToolResult: (n: string, r: string, e: boolean) => broadcast({ type: 'task:tool_result', taskId: record.id, tool: n, success: !e, preview: r.slice(0, 500) }),
            onTokenUsage: (i: number, o: number) => { totalIn += i; totalOut += o; broadcast({ type: 'task:tokens', taskId: record.id, tokensIn: totalIn, tokensOut: totalOut }); },
          });

          const resolvedWorkDir = workDir || installRoot();
          const catalogContext = loadProjectCatalog(resolvedWorkDir);
          let taskContext = `Your task ID is: ${record.id}\nWhen you complete your task, include "TASK ${record.id} COMPLETED" in your final message.\n\n## PROJECT DIRECTORY: ${resolvedWorkDir}\nAll files you create or modify MUST be under ${resolvedWorkDir}. Do NOT write files outside it.${catalogContext}\n\n${body.context || ''}`;

          if (attempt === 2 && lastError) {
            taskContext += `\n\n## RETRY — Previous attempt failed\nError: ${lastError}\nFix the error and complete the task.`;
          } else if (attempt === 3 && lastError) {
            taskContext += `\n\n## RETRY — Different approach required\nTwo previous attempts failed: ${lastError}\nTry a COMPLETELY DIFFERENT strategy.`;
          } else if (attempt >= 4 && lastError) {
            taskContext += `\n\n## FINAL RETRY — Simplify\nThree attempts failed. Last error: ${lastError}\nStrip to absolute minimum. Get core functionality working, skip edge cases.`;
          }

          const result = await worker.executeTask(body.task, taskContext, body.criteria || []);

          store.completeTask(record.id, result, { in: totalIn, out: totalOut });
          broadcast({ type: 'task:completed', taskId: record.id, result });
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          lastError = errMsg;
          const classification = classifyError(err instanceof Error ? err : errMsg, attempt, MAX_RETRIES);

          if (attempt < MAX_RETRIES) {
            if (classification.action !== 'fail') {
              const fixed = await autoFix(classification);
              broadcast({ type: 'task:retrying', taskId: record.id, attempt, action: classification.action, fixed });
            } else {
              broadcast({ type: 'task:retrying', taskId: record.id, attempt, action: 'escalate', fixed: false });
            }
            continue;
          }

          store.failTask(record.id, `Failed after ${MAX_RETRIES} attempts. Last error: ${errMsg}`, { in: totalIn, out: totalOut });
          broadcast({ type: 'task:failed', taskId: record.id, error: `Failed after ${MAX_RETRIES} attempts. Last error: ${errMsg}` });
          return;
        }
      }
    })();
  }

  async function listTasksHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const statusFilter = url.searchParams.get('status') as store.TaskStatus | null;
    const tasks = store.listTasks(statusFilter || undefined);
    const list = tasks.slice(0, 50).map(({ result, ...rest }) => ({ ...rest, hasResult: !!result }));
    sendJson(res, 200, list);
  }

  async function getTaskHandler(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const task = store.getTask(params.id);
    if (!task) { sendError(res, 404, 'Task not found'); return; }
    sendJson(res, 200, task);
  }

  async function completeTaskHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = await parseBody(req);
    const task = store.completeTask(params.id, body.result, body.tokens);
    if (!task) { sendError(res, 404, 'Task not found or not active'); return; }
    broadcast({ type: 'task:completed', taskId: params.id, result: body.result });
    sendJson(res, 200, task);
  }

  async function failTaskHandler(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const body = await parseBody(req);
    const task = store.failTask(params.id, body.error || 'Unknown error', body.tokens);
    if (!task) { sendError(res, 404, 'Task not found or not active'); return; }
    broadcast({ type: 'task:failed', taskId: params.id, error: body.error });
    sendJson(res, 200, task);
  }

  async function cancelTaskHandler(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const task = store.cancelTask(params.id);
    if (!task) { sendError(res, 404, 'Task not found or not cancellable (must be active or pending)'); return; }
    broadcast({ type: 'task:failed', taskId: params.id, error: 'Cancelled by user' });
    sendJson(res, 200, task);
  }

  async function archiveHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    const hours = body.olderThanHours || 24;
    const count = store.archiveTasks(hours);
    sendJson(res, 200, { archived: count });
  }

  async function countsHandler(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, store.taskCounts());
  }

  return {
    listTasks: listTasksHandler,
    getTask: getTaskHandler,
    taskCounts: countsHandler,
    cancelTask: cancelTaskHandler,
  };
}
