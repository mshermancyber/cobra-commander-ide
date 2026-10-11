import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { broadcast } from '../websocket/events.js';

interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  filesChanged?: string[];
  commandsRun?: string[];
  findings?: string[];
}

interface FileChange {
  path: string;
  original: string;
  modified: string;
  diff?: string;
  status: 'pending' | 'accepted' | 'rejected';
  reason?: string;
}

interface WorkspaceState {
  id: string;
  task: string;
  plan: PlanStep[];
  currentStep: number;
  changes: FileChange[];
  status: 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'stopped';
  taskId?: string;
  startedAt: number;
  completedAt?: number;
  terminalOutput: string[];
  chatMessages: Array<{ role: string; content: string; timestamp: number }>;
}

const workspaces = new Map<string, WorkspaceState>();

function workspaceDir(workDir: string): string {
  const dir = join(workDir, '.cobra-commander', 'workspaces');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function persistWorkspace(workDir: string, state: WorkspaceState): void {
  const dir = workspaceDir(workDir);
  const file = join(dir, `${state.id}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2));
}

function loadWorkspace(workDir: string, id: string): WorkspaceState | null {
  const file = join(workspaceDir(workDir), `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

export function createWorkspaceRoutes(workDir: string) {
  async function parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve({});
        }
      });
      req.on('error', reject);
    });
  }

  // POST /api/workspace/start
  async function startWorkspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await parseBody(req);
    if (!body.task) { sendError(res, 400, 'Missing "task" field'); return; }

    const id = randomUUID().slice(0, 8);
    const plan: PlanStep[] = (body.plan || []).map((step: string, i: number) => ({
      id: `step-${i + 1}`,
      description: step,
      status: 'pending' as const,
    }));

    // If no plan provided, start with a default single step
    if (plan.length === 0) {
      plan.push({
        id: 'step-1',
        description: body.task,
        status: 'pending' as const,
      });
    }

    const state: WorkspaceState = {
      id,
      task: body.task,
      plan,
      currentStep: 0,
      changes: [],
      status: plan.length > 1 ? 'planning' : 'executing',
      startedAt: Date.now(),
      terminalOutput: [],
      chatMessages: [
        { role: 'system', content: `Task: ${body.task}`, timestamp: Date.now() },
      ],
    };

    workspaces.set(id, state);
    persistWorkspace(workDir, state);

    // If context/criteria provided, delegate to the worker
    if (body.executeImmediately) {
      const taskId = randomUUID().slice(0, 8);
      state.taskId = taskId;
      state.status = 'executing';

      broadcast({
        type: 'workspace:started',
        workspaceId: id,
        task: state.task,
        taskId,
      });

      // Run async
      (async () => {
        try {
          const { Worker } = await import('../../core/worker.js');
          const { loadConfig, hydrateWorkerKey } = await import('../../core/config.js');
          const config = loadConfig({ workDir });
          const hydrated = await hydrateWorkerKey(config);
          const worker = new Worker(hydrated, {
            onText: (t: string) => {
              state.chatMessages.push({ role: 'assistant', content: t, timestamp: Date.now() });
              broadcast({ type: 'workspace:chat', workspaceId: id, text: t });
            },
            onToolCall: (n: string, args: Record<string, unknown>) => {
              state.chatMessages.push({
                role: 'tool-call',
                content: `${n}(${JSON.stringify(args).slice(0, 200)})`,
                timestamp: Date.now(),
              });
              broadcast({ type: 'workspace:tool_call', workspaceId: id, tool: n, args });
            },
            onToolResult: (n: string, r: string, e: boolean) => {
              state.terminalOutput.push(`[${n}] ${r.slice(0, 500)}`);
              broadcast({
                type: 'workspace:tool_result',
                workspaceId: id,
                tool: n,
                success: !e,
                preview: r.slice(0, 500),
              });
            },
            onTokenUsage: (_input: number, _output: number) => {
              /* track silently */
            },
          });

          const result = await worker.executeTask(body.task, body.context || '', body.criteria || []);
          state.status = 'completed';
          state.completedAt = Date.now();
          state.chatMessages.push({ role: 'assistant', content: result, timestamp: Date.now() });
          persistWorkspace(workDir, state);
          broadcast({ type: 'workspace:completed', workspaceId: id, result });
        } catch (err) {
          state.status = 'failed';
          state.completedAt = Date.now();
          const msg = err instanceof Error ? err.message : String(err);
          state.chatMessages.push({ role: 'error', content: msg, timestamp: Date.now() });
          persistWorkspace(workDir, state);
          broadcast({ type: 'workspace:failed', workspaceId: id, error: msg });
        }
      })();
    }

    sendJson(res, 202, { workspaceId: id, taskId: state.taskId, status: state.status });
  }

  // GET /api/workspace/:id
  async function getWorkspace(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    const existing = workspaces.get(id) || loadWorkspace(workDir, id);
    if (!existing) { sendError(res, 404, 'Workspace not found'); return; }
    const state = existing;
    workspaces.set(id, state);

    sendJson(res, 200, {
      id: state.id,
      task: state.task,
      plan: state.plan,
      currentStep: state.currentStep,
      changes: state.changes,
      status: state.status,
      taskId: state.taskId,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      terminalOutput: state.terminalOutput.slice(-100),
      chatMessages: state.chatMessages.slice(-50),
    });
  }

  // POST /api/workspace/:id/approve
  async function approveWorkspace(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    // Approve all pending changes
    for (const change of state.changes) {
      if (change.status === 'pending') change.status = 'accepted';
    }
    state.status = 'completed';
    state.completedAt = Date.now();
    persistWorkspace(workDir, state);
    broadcast({ type: 'workspace:approved', workspaceId: id });

    sendJson(res, 200, { status: 'approved', changesApproved: state.changes.filter(c => c.status === 'accepted').length });
  }

  // POST /api/workspace/:id/reject/:fileIndex
  async function rejectChange(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    const fileIdx = parseInt(params.fileIndex, 10);
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    if (isNaN(fileIdx) || fileIdx < 0 || fileIdx >= state.changes.length) {
      sendError(res, 400, 'Invalid file index');
      return;
    }

    state.changes[fileIdx].status = 'rejected';
    persistWorkspace(workDir, state);
    broadcast({
      type: 'workspace:change_rejected',
      workspaceId: id,
      fileIndex: fileIdx,
      file: state.changes[fileIdx].path,
    });

    sendJson(res, 200, { status: 'rejected', file: state.changes[fileIdx].path });
  }

  // POST /api/workspace/:id/stop
  async function stopWorkspace(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    state.status = 'stopped';
    state.completedAt = Date.now();
    persistWorkspace(workDir, state);
    broadcast({ type: 'workspace:stopped', workspaceId: id });

    sendJson(res, 200, { status: 'stopped' });
  }

  // GET /api/workspace/:id/changes
  async function getChanges(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    const existing = workspaces.get(id) || loadWorkspace(workDir, id);
    if (!existing) { sendError(res, 404, 'Workspace not found'); return; }
    const state = existing;
    workspaces.set(id, state);

    sendJson(res, 200, {
      changes: state.changes,
      accepted: state.changes.filter(c => c.status === 'accepted').length,
      rejected: state.changes.filter(c => c.status === 'rejected').length,
      pending: state.changes.filter(c => c.status === 'pending').length,
      total: state.changes.length,
    });
  }

  // POST /api/workspace/:id/edit
  async function editFile(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    const body = await parseBody(req);
    if (!body.path || body.content === undefined) {
      sendError(res, 400, 'Missing "path" or "content" field');
      return;
    }

    // Prevent path traversal: resolve and verify stays within workDir
    const fullPath = resolve(workDir, body.path);
    if (!fullPath.startsWith(resolve(workDir) + '/') && fullPath !== resolve(workDir)) {
      sendError(res, 403, 'Path traversal blocked');
      return;
    }

    // Find existing change or create new one
    let change = state.changes.find(c => c.path === body.path);
    if (change) {
      change.modified = body.content;
      change.status = 'pending';
    } else {
      // Try to read original
      let original = '';
      if (existsSync(fullPath)) {
        try {
          original = readFileSync(fullPath, 'utf-8');
        } catch { /* binary */ }
      }

      change = {
        path: body.path,
        original,
        modified: body.content,
        status: 'pending',
      };
      state.changes.push(change);
    }

    // Write to disk
    try {
      writeFileSync(fullPath, body.content);
      broadcast({ type: 'workspace:file_edited', workspaceId: id, path: body.path });
    } catch (err) {
      console.error('[workspace] write error:', err instanceof Error ? err.stack || err.message : String(err));
      sendError(res, 500, 'Failed to write file');
      return;
    }

    persistWorkspace(workDir, state);
    sendJson(res, 200, { status: 'edited', path: body.path });
  }

  // GET /api/workspace — list workspaces
  async function listWorkspaces(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const dir = workspaceDir(workDir);
    const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];

    const list = files
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => (b.startedAt || 0) - (a.startedAt || 0))
      .map((ws: any) => ({
        id: ws.id,
        task: ws.task,
        status: ws.status,
        startedAt: ws.startedAt,
        completedAt: ws.completedAt,
        changes: ws.changes?.length || 0,
      }));

    sendJson(res, 200, list);
  }

  // POST /api/workspace/:id/plan — update the plan
  async function updatePlan(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    const body = await parseBody(req);
    if (!body.plan || !Array.isArray(body.plan)) {
      sendError(res, 400, 'Missing "plan" array');
      return;
    }

    state.plan = body.plan.map((step: any, i: number) => ({
      id: step.id || `step-${i + 1}`,
      description: typeof step === 'string' ? step : step.description,
      status: (step.status || 'pending') as PlanStep['status'],
      filesChanged: step.filesChanged || [],
      commandsRun: step.commandsRun || [],
      findings: step.findings || [],
    }));

    persistWorkspace(workDir, state);
    broadcast({ type: 'workspace:plan_updated', workspaceId: id, plan: state.plan });

    sendJson(res, 200, { plan: state.plan });
  }

  // POST /api/workspace/:id/execute — start executing the plan
  async function executePlan(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
    const id = params.id;
    let state = workspaces.get(id);
    if (!state) { sendError(res, 404, 'Workspace not found'); return; }

    if (state.status === 'executing') {
      sendError(res, 409, 'Already executing');
      return;
    }

    state.status = 'executing';
    state.currentStep = 0;
    const taskId = randomUUID().slice(0, 8);
    state.taskId = taskId;

    broadcast({ type: 'workspace:executing', workspaceId: id });

    // Execute async
    (async () => {
      try {
        const { Worker } = await import('../../core/worker.js');
        const { loadConfig, hydrateWorkerKey } = await import('../../core/config.js');
        const config = loadConfig({ workDir });
        const hydrated = await hydrateWorkerKey(config);

        for (let i = 0; i < state.plan.length; i++) {
          state.currentStep = i;
          state.plan[i].status = 'in-progress';
          persistWorkspace(workDir, state);
          broadcast({
            type: 'workspace:step_started',
            workspaceId: id,
            stepIndex: i,
            step: state.plan[i],
          });

          const worker = new Worker(hydrated, {
            onText: (t: string) => {
              state.chatMessages.push({ role: 'assistant', content: t, timestamp: Date.now() });
              broadcast({ type: 'workspace:chat', workspaceId: id, text: t });
            },
            onToolCall: (n: string, args: Record<string, unknown>) => {
              broadcast({ type: 'workspace:tool_call', workspaceId: id, tool: n, args });
            },
            onToolResult: (n: string, r: string, e: boolean) => {
              state.terminalOutput.push(`[${n}] ${r.slice(0, 500)}`);
              broadcast({
                type: 'workspace:tool_result',
                workspaceId: id,
                tool: n,
                success: !e,
                preview: r.slice(0, 500),
              });
            },
            onTokenUsage: (_input: number, _output: number) => {
              /* track silently */
            },
          });

          try {
            const result = await worker.executeTask(state.plan[i].description, '', []);
            state.plan[i].status = 'completed';
            state.plan[i].filesChanged = []; // Populated by the worker output
            state.chatMessages.push({
              role: 'assistant',
              content: `✓ Step ${i + 1} complete: ${result.slice(0, 200)}`,
              timestamp: Date.now(),
            });
            broadcast({
              type: 'workspace:step_completed',
              workspaceId: id,
              stepIndex: i,
              result: result.slice(0, 500),
            });
          } catch (stepErr) {
            state.plan[i].status = 'failed';
            const msg = stepErr instanceof Error ? stepErr.message : String(stepErr);
            state.chatMessages.push({ role: 'error', content: `✗ Step ${i + 1} failed: ${msg}`, timestamp: Date.now() });
            broadcast({ type: 'workspace:step_failed', workspaceId: id, stepIndex: i, error: msg });
            // Continue with next steps despite failure
          }

          persistWorkspace(workDir, state);
        }

        state.status = 'reviewing';
        state.completedAt = Date.now();
        persistWorkspace(workDir, state);
        broadcast({ type: 'workspace:execution_done', workspaceId: id });
      } catch (err) {
        state.status = 'failed';
        state.completedAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        broadcast({ type: 'workspace:failed', workspaceId: id, error: msg });
        persistWorkspace(workDir, state);
      }
    })();

    sendJson(res, 202, { workspaceId: id, taskId, status: 'executing' });
  }

  return {
    startWorkspace,
    getWorkspace,
    approveWorkspace,
    rejectChange,
    stopWorkspace,
    getChanges,
    editFile,
    listWorkspaces,
    updatePlan,
    executePlan,
  };
}
