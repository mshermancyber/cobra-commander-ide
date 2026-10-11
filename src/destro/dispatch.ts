// Destro dispatch — routes work to the coder pipeline per DESTRO-AGENT-SPEC.md §15.
// Three dispatch lanes:
//   (a) 'intake'       → HTTP POST to api-server /api/v1/intake/expand → approve → send chain
//   (b) 'orchestrator' → createTask via dynamic import of task-store
//   (c) 'worker'       → in-memory new Worker(...).executeTask(...)
//
// Uses dynamic imports (import()) — runtime, not static dependencies — per §2.5.

import type { WorkerCallbacks } from '../core/worker.js';
import { apiBaseUrl } from '../core/net-defaults.js';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export type DispatchKind = 'intake' | 'orchestrator' | 'worker';

export interface DispatchPayload {
  prompt?: string;
  requirement?: string;
  context?: string;
  projectPath?: string;
  workDir?: string;
  criteria?: string[];
}

export interface DispatchResult {
  lane: DispatchKind;
  status: 'dispatched' | 'completed' | 'failed';
  taskId?: string;
  intakeRequestId?: string;
  summary?: string;
  error?: string;
}

// ──────────────────────────────────────────────
// Tool definition (for registration in destro-agent)
// ──────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const dispatchPipelineTool: ToolDef = {
  name: 'dispatch_pipeline',
  description:
    'Route work to the coder pipeline. Choose intake (new project, vague ask), orchestrator (existing project, multi-step), or worker (single-file small fix).',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['intake', 'orchestrator', 'worker'],
        description: 'Which pipeline lane to dispatch to',
      },
      prompt: {
        type: 'string',
        description: 'The work description (required for intake)',
      },
      requirement: {
        type: 'string',
        description: 'Crisp requirement string (orchestrator/worker)',
      },
      context: {
        type: 'string',
        description: 'Additional context for the task',
      },
      projectPath: {
        type: 'string',
        description: 'Target project path (orchestrator/worker)',
      },
      workDir: {
        type: 'string',
        description: 'Working directory for the worker',
      },
      criteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Acceptance criteria (worker lane)',
      },
    },
    required: ['kind', 'prompt'],
  },
};

// ──────────────────────────────────────────────
// API helpers (matching chat-bridge.ts patterns)
// ──────────────────────────────────────────────

const API_BASE = apiBaseUrl();
const API_TOKEN = process.env.API_TOKEN || '';

async function apiCall(method: string, path: string, body?: unknown): Promise<unknown> {
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  return res.json();
}

// ──────────────────────────────────────────────
// Lane: intake
// ──────────────────────────────────────────────

async function dispatchIntake(payload: DispatchPayload): Promise<DispatchResult> {
  const prompt = payload.prompt || payload.requirement || '';
  if (!prompt) {
    return {
      lane: 'intake',
      status: 'failed',
      error: 'Intake dispatch requires a prompt or requirement',
    };
  }

  try {
    // Step 1: expand
    const expandResp = (await apiCall('POST', '/api/v1/intake/expand', {
      prompt,
    })) as { id?: string; error?: string; status?: string };

    if (!expandResp.id) {
      return {
        lane: 'intake',
        status: 'failed',
        error: `Intake expand failed: ${JSON.stringify(expandResp)}`,
      };
    }

    const requestId = expandResp.id;

    // Step 2: approve
    const approveResp = (await apiCall(
      'POST',
      `/api/v1/intake/requests/${requestId}/approve`,
    )) as { id?: string; error?: string; status?: string };

    if (approveResp.error) {
      return {
        lane: 'intake',
        status: 'failed',
        intakeRequestId: requestId,
        error: `Intake approve failed: ${approveResp.error}`,
      };
    }

    // Step 3: send
    const sendResp = (await apiCall(
      'POST',
      `/api/v1/intake/requests/${requestId}/send`,
    )) as { id?: string; error?: string; status?: string; taskId?: string };

    if (sendResp.error) {
      return {
        lane: 'intake',
        status: 'failed',
        intakeRequestId: requestId,
        error: `Intake send failed: ${sendResp.error}`,
      };
    }

    return {
      lane: 'intake',
      status: 'dispatched',
      intakeRequestId: requestId,
      taskId: sendResp.taskId || undefined,
      summary: `Intake request ${requestId} expanded, approved, and sent${sendResp.taskId ? ` → task ${sendResp.taskId}` : ''}.`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      lane: 'intake',
      status: 'failed',
      error: `Intake dispatch error: ${msg}`,
    };
  }
}

// ──────────────────────────────────────────────
// Lane: orchestrator
// ──────────────────────────────────────────────

async function dispatchOrchestrator(payload: DispatchPayload): Promise<DispatchResult> {
  const requirement = payload.requirement || payload.prompt || '';
  if (!requirement) {
    return {
      lane: 'orchestrator',
      status: 'failed',
      error: 'Orchestrator dispatch requires a requirement or prompt',
    };
  }

  try {
    // Dynamic import — runtime-only, no static dependency
    const taskStore = await import('../core/task-store.js');

    const contextStr = [
      payload.context || '',
      payload.projectPath ? `Project path: ${payload.projectPath}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    const record = taskStore.createTask(
      requirement,
      contextStr || undefined,
      payload.projectPath || payload.workDir || process.cwd(),
    );

    return {
      lane: 'orchestrator',
      status: 'dispatched',
      taskId: record.id,
      summary: `Orchestrator task ${record.id} created: "${requirement.slice(0, 120)}"`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      lane: 'orchestrator',
      status: 'failed',
      error: `Orchestrator dispatch error: ${msg}`,
    };
  }
}

// ──────────────────────────────────────────────
// Lane: worker
// ──────────────────────────────────────────────

async function dispatchWorker(payload: DispatchPayload): Promise<DispatchResult> {
  const requirement = payload.requirement || payload.prompt || '';
  if (!requirement) {
    return {
      lane: 'worker',
      status: 'failed',
      error: 'Worker dispatch requires a requirement or prompt',
    };
  }

  try {
    // Dynamic imports — runtime-only, no static dependency
    const [workerMod, configMod] = await Promise.all([
      import('../core/worker.js'),
      import('../core/config.js'),
    ]);

    const workDir = payload.workDir || payload.projectPath || process.cwd();
    const config = configMod.loadConfig({ workDir });

    // Hydrate worker key if needed
    if (configMod.hydrateWorkerKey) {
      await configMod.hydrateWorkerKey(config);
    }

    const workerId = `destro-worker-${Date.now()}`;
    const callbacks: WorkerCallbacks = {
      onText: (text: string) => {
        // Silently capture — we don't stream worker output in Destro
      },
      onToolCall: (_name: string, _input: Record<string, unknown>) => {
        // Tracked in actions ledger by the agent loop
      },
      onToolResult: (_name: string, _result: string, _isError: boolean) => {
        // No op
      },
      onTokenUsage: (_input: number, _output: number) => {
        // No op
      },
    };

    const worker = new workerMod.Worker(config, callbacks, undefined, undefined, workerId);

    const contextStr = [
      payload.context || '',
      `Work directory: ${workDir}`,
    ]
      .filter(Boolean)
      .join('\n');

    const criteria = payload.criteria || [];

    const result = await worker.executeTask(requirement, contextStr, criteria);

    // Check for TASK completion marker
    const taskIdMatch = result.match(/TASK\s+(\S+)\s+COMPLETED/);
    const taskId = taskIdMatch ? taskIdMatch[1] : undefined;

    return {
      lane: 'worker',
      status: 'completed',
      taskId,
      summary: result.slice(0, 500),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      lane: 'worker',
      status: 'failed',
      error: `Worker dispatch error: ${msg}`,
    };
  }
}

// ──────────────────────────────────────────────
// Public router
// ──────────────────────────────────────────────

/**
 * Route work to the coder pipeline.
 *
 * Three lanes:
 * - 'intake'       → new project, vague ask — goes through intake expand → approve → send
 * - 'orchestrator' → existing project, multi-step — creates a durable task for the orchestrator
 * - 'worker'       → single-file small fix — runs an in-memory worker directly
 */
export async function routeWork(
  kind: DispatchKind,
  payload: DispatchPayload,
): Promise<DispatchResult> {
  switch (kind) {
    case 'intake':
      return dispatchIntake(payload);
    case 'orchestrator':
      return dispatchOrchestrator(payload);
    case 'worker':
      return dispatchWorker(payload);
    default: {
      const _exhaustive: never = kind;
      return {
        lane: kind,
        status: 'failed',
        error: `Unknown dispatch kind: ${kind}`,
      };
    }
  }
}

// ──────────────────────────────────────────────
// Tool executor (called by destro-agent's tool dispatch)
// ──────────────────────────────────────────────

/**
 * Execute a dispatch_pipeline tool call from Destro's agent loop.
 * Parses the standard tool input, calls routeWork, and returns a
 * flattened result suitable for appending as a tool result.
 */
export async function executeDispatchPipeline(
  input: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  const kind = input.kind as DispatchKind;
  const payload: DispatchPayload = {
    prompt: input.prompt as string | undefined,
    requirement: input.requirement as string | undefined,
    context: input.context as string | undefined,
    projectPath: input.projectPath as string | undefined,
    workDir: input.workDir as string | undefined,
    criteria: input.criteria as string[] | undefined,
  };

  const dispatchResult = await routeWork(kind, payload);

  const result = JSON.stringify(dispatchResult, null, 2);
  return {
    result,
    isError: dispatchResult.status === 'failed',
  };
}

// ──────────────────────────────────────────────
// await_task — foreman liveness: block on an orchestrator task until terminal
// ──────────────────────────────────────────────

// Task-store statuses that mean "done, one way or another".
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'archived']);

export const awaitTaskTool: ToolDef = {
  name: 'await_task',
  description:
    'Block until a dispatched orchestrator task reaches a terminal state (completed/failed/archived), then return its real outcome. ' +
    'ALWAYS call this after dispatch_pipeline{kind:"orchestrator"} — it is how you stay alive tracking the orchestrator instead of ' +
    'guessing from the filesystem. Orchestrator builds routinely run many minutes with retries; a file not existing yet does NOT mean ' +
    'the build failed. One call covers the whole wait (it does not consume your turns). Only after it returns terminal should you ' +
    'verify the output with real probes and conclude.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The orchestrator task id returned by dispatch_pipeline (e.g. "466b9357").',
      },
      maxWaitMs: {
        type: 'number',
        description: 'Optional hard ceiling in ms to wait before returning a still-running snapshot (default 1800000 = 30 min, max 3600000).',
      },
    },
    required: ['taskId'],
  },
};

/**
 * Poll the task-store for `taskId` until it is terminal or the ceiling is hit.
 * Blocks in a single tool call so the agent never burns turns on sleep+ls loops
 * and never concludes while the orchestrator is still legitimately working.
 */
export async function executeAwaitTask(
  input: Record<string, unknown>,
): Promise<{ result: string; isError: boolean }> {
  const taskId = String(input.taskId || '').trim();
  if (!taskId) {
    return { result: JSON.stringify({ error: 'await_task requires a taskId' }), isError: true };
  }
  const ceiling = Math.min(
    Math.max(Number(input.maxWaitMs) || 1_800_000, 30_000),
    3_600_000,
  );

  const taskStore = await import('../core/task-store.js');
  const started = Date.now();
  const pollMs = 15_000;

  // Immediate check first, then poll.
  for (;;) {
    const task = taskStore.getTask(taskId);
    if (!task) {
      return {
        result: JSON.stringify({ taskId, status: 'not_found', note: 'No such task in the store.' }),
        isError: true,
      };
    }
    const terminal = TERMINAL_TASK_STATUSES.has(task.status);
    const elapsed = Date.now() - started;
    if (terminal || elapsed >= ceiling) {
      const ledger = Array.isArray(task.ledger) ? task.ledger : [];
      const summary = {
        taskId,
        status: task.status,
        terminal,
        producedChanges: task.producedChanges ?? false,
        delegationCount: task.delegationCount ?? undefined,
        error: task.error ?? undefined,
        waitedMs: elapsed,
        ledgerTail: ledger.slice(-6),
        note: terminal
          ? `Task reached terminal state "${task.status}". Now VERIFY its output with real probes before concluding.`
          : `Ceiling (${ceiling}ms) hit while task still "${task.status}" — not terminal yet. Call await_task again to keep tracking, or investigate why it is stuck.`,
      };
      return { result: JSON.stringify(summary, null, 2), isError: task.status === 'failed' };
    }
    await new Promise(r => setTimeout(r, Math.min(pollMs, ceiling - elapsed)));
  }
}
