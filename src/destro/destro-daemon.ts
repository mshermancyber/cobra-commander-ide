// Destro daemon — standalone HTTP server with SSE streaming, approval plumbing,
// session management, and proactive fleet-watch loop. Created 2026-07-04.
//
// Usage: npx tsx src/destro/destro-daemon.ts

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { loadDestroConfig } from './destro-config.js';
import type { DestroConfig } from './destro-config.js';
import {
  destroAgentLoop,
} from './destro-agent.js';
import type { DestroAgentOptions, DestroAgentResult } from './destro-agent.js';
import {
  createDestroSession,
  appendSteerMessage,
  setAbortFlag,
} from './destro-session.js';
import type { DestroSessionState } from './destro-session.js';
import { DestroCircuitBreaker } from './destro-circuit-breaker.js';
import { DEFAULT_SUPPORT_PORT } from '../core/net-defaults.js';

const execAsync = promisify(exec);

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

const MUTATION_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'docker_restart',
  'systemctl_restart',
  'docker_compose_up',
]);

const PORT = DEFAULT_SUPPORT_PORT;
const HOST = '127.0.0.1';
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const PROACTIVE_INTERVAL_MS = 60 * 1000; // 60 seconds
const PREFIX = '[destro-daemon]';

// ──────────────────────────────────────────────
// Fleet watch types
// ──────────────────────────────────────────────

interface FleetService {
  name: string;
  kind: 'docker-compose' | 'docker' | 'systemd' | 'process';
  path: string;
  containers?: string[];
  unit?: string;
  health: { type: 'http' | 'docker' | 'systemd'; url?: string };
  watch: boolean;
}

interface FleetWatch {
  services?: FleetService[];
}

// ──────────────────────────────────────────────
// Session entry
// ──────────────────────────────────────────────

interface SessionEntry {
  session: DestroSessionState;
  targetDir: string;
  mode: 'interactive' | 'auto' | 'diagnose';
  activeLoop: Promise<DestroAgentResult> | null;
  started: number;
}

// ──────────────────────────────────────────────
// Approval entry
// ──────────────────────────────────────────────

interface PendingApproval {
  resolve: (decision: string) => void;
  reject: (err: Error) => void;
  sessionId: string;
  timeout: NodeJS.Timeout;
}

// ──────────────────────────────────────────────
// Global state
// ──────────────────────────────────────────────

const sessions = new Map<string, SessionEntry>();
const pendingApprovals = new Map<string, PendingApproval>();
const sseClients = new Set<ServerResponse>();
const daemonBreaker = new DestroCircuitBreaker();

let proactiveTimer: ReturnType<typeof setInterval> | null = null;

// ──────────────────────────────────────────────
// Logging
// ──────────────────────────────────────────────

function log(msg: string): void {
  console.log(`${PREFIX} ${msg}`);
}

function logError(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err ?? '');
  console.error(`${PREFIX} ${msg}${detail ? `: ${detail}` : ''}`);
}

// ──────────────────────────────────────────────
// Body parser
// ──────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await parseBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ──────────────────────────────────────────────
// Response helpers
// ──────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}

function sendSSE(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ──────────────────────────────────────────────
// Route matching
// ──────────────────────────────────────────────

interface RouteMatch {
  handler: string;
  params: Record<string, string>;
}

function matchRoute(method: string, url: string): RouteMatch | null {
  // Strip query string
  const path = url.split('?')[0];

  if (method === 'GET' && path === '/health') {
    return { handler: 'health', params: {} };
  }

  if (method === 'POST' && path === '/chat') {
    return { handler: 'chat', params: {} };
  }

  if (method === 'GET' && path === '/sessions') {
    return { handler: 'listSessions', params: {} };
  }

  // /sessions/:id
  let m = path.match(/^\/sessions\/([^/]+)$/);
  if (m) {
    if (method === 'GET') return { handler: 'getSession', params: { id: m[1] } };
    return null;
  }

  // /sessions/:id/steer
  m = path.match(/^\/sessions\/([^/]+)\/steer$/);
  if (m && method === 'POST') {
    return { handler: 'steerSession', params: { id: m[1] } };
  }

  // /sessions/:id/abort
  m = path.match(/^\/sessions\/([^/]+)\/abort$/);
  if (m && method === 'POST') {
    return { handler: 'abortSession', params: { id: m[1] } };
  }

  // /sessions/:id/approve
  m = path.match(/^\/sessions\/([^/]+)\/approve$/);
  if (m && method === 'POST') {
    return { handler: 'approveSession', params: { id: m[1] } };
  }

  return null;
}

// ──────────────────────────────────────────────
// Fleet watch
// ──────────────────────────────────────────────

async function readFleetWatch(): Promise<FleetWatch> {
  const fleetPath = join(process.cwd(), 'src', 'destro', 'fleet-watch.json');

  // Try the import-relative path first, then cwd-relative
  const paths = [
    fleetPath,
    join(process.cwd(), 'fleet-watch.json'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = await readFile(p, 'utf-8');
      return JSON.parse(raw) as FleetWatch;
    } catch {
      // unreadable — try next path
    }
  }

  return { services: [] };
}

async function probeHttpService(target: string): Promise<boolean> {
  try {
    const url = target.startsWith('http') ? target : `http://${target}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

async function probeDockerService(target: string): Promise<boolean> {
  try {
    // target is the container name or grep pattern
    const { stdout } = await execAsync(`docker ps --format '{{.Names}}' | grep -q '${target}'`, {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function probeSystemdService(target: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`systemctl --user is-active '${target}'`, {
      timeout: 10_000,
    });
    return stdout.trim() === 'active';
  } catch {
    return false;
  }
}

async function probeService(svc: FleetService): Promise<boolean> {
  const healthType = svc.health?.type || 'http';
  const healthUrl = svc.health?.url || '';
  log(`Probing service "${svc.name}" (kind=${svc.kind}, healthType=${healthType}${healthUrl ? `, url=${healthUrl}` : ''})`);

  switch (healthType) {
    case 'http':
      return probeHttpService(healthUrl);
    case 'docker':
      // Probe via container names if provided, else fall back to service name
      if (svc.containers && svc.containers.length > 0) {
        for (const container of svc.containers) {
          const up = await probeDockerService(container);
          if (!up) return false;
        }
        return true;
      }
      return probeDockerService(svc.name);
    case 'systemd': {
      const unit = svc.unit || svc.name;
      return probeSystemdService(unit);
    }
    default:
      logError(`Unknown health type: ${healthType} for "${svc.name}"`);
      return false;
  }
}

function broadcastSSE(event: Record<string, unknown>): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(data);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ──────────────────────────────────────────────
// Proactive loop
// ──────────────────────────────────────────────

async function runProactiveLoop(config: DestroConfig): Promise<void> {
  const fleetWatch = await readFleetWatch();
  const services = fleetWatch.services || [];

  if (services.length === 0) {
    log('Proactive loop: no services in fleet-watch.json');
    return;
  }

  const watched = services.filter(s => s.watch);
  if (watched.length === 0) {
    log('Proactive loop: no watched services (watch:true)');
    return;
  }

  for (const svc of watched) {
    log(`Proactive loop: probing "${svc.name}"...`);

    const healthy = await probeService(svc);
    if (healthy) {
      daemonBreaker.recordSuccess();
      log(`Proactive loop: "${svc.name}" is healthy`);
      continue;
    }

    // Unhealthy
    log(`Proactive loop: "${svc.name}" is UNHEALTHY`);
    daemonBreaker.recordFailure();

    if (daemonBreaker.isOpen()) {
      log('Proactive loop: circuit breaker open — skipping remediation');
      broadcastSSE({
        type: 'proactive',
        status: 'circuit_open',
        service: svc.name,
        message: 'Circuit breaker open — skipping remediation',
        ts: Date.now(),
      });
      continue;
    }

    broadcastSSE({
      type: 'proactive',
      status: 'unhealthy',
      service: svc.name,
      kind: svc.kind,
      healthType: svc.health?.type,
      healthUrl: svc.health?.url,
      path: svc.path,
      ts: Date.now(),
    });

    // Run diagnose session (or autoheal if enabled)
    const autoheal = process.env.DESTRO_AUTOHEAL === '1';
    const mode = autoheal ? 'auto' : 'diagnose' as const;
    const sessionId = `proactive-${svc.name}-${Date.now()}`;

    log(`Proactive loop: starting ${mode} session "${sessionId}" for "${svc.name}"`);

    const session = createDestroSession(sessionId);
    const entry: SessionEntry = {
      session,
      targetDir: config.workDir,
      mode,
      activeLoop: null,
      started: Date.now(),
    };
    sessions.set(sessionId, entry);

    const userMessage = autoheal
      ? `Service "${svc.name}" (kind=${svc.kind}, path=${svc.path}) is unhealthy. Diagnose and fix the issue.`
      : `Service "${svc.name}" (kind=${svc.kind}, path=${svc.path}) is unhealthy. Diagnose the issue but DO NOT make any changes. Report findings only.`;

    const loopPromise = destroAgentLoop({
      targetDir: config.workDir,
      service: svc.name,
      failureSignature: `proactive-${svc.kind}-${svc.health?.url || svc.health?.type || 'unknown'}`,
      userMessage,
      sessionId,
      config,
      onToolCall: (name, input) => {
        broadcastSSE({
          type: 'proactive_tool',
          sessionId,
          service: svc.name,
          tool: name,
          input,
          ts: Date.now(),
        });
      },
      onTurn: (turn, status) => {
        broadcastSSE({
          type: 'proactive_turn',
          sessionId,
          service: svc.name,
          turn,
          status,
          ts: Date.now(),
        });
      },
    });

    entry.activeLoop = loopPromise;

    // Fire-and-forget: track result when done
    loopPromise
      .then(result => {
        entry.session = result.session;
        entry.session.status = result.status === 'resolved' ? 'closed' : 'escalated';
        log(`Proactive loop: session "${sessionId}" completed with status="${result.status}"`);
        broadcastSSE({
          type: 'proactive_result',
          sessionId,
          service: svc.name,
          status: result.status,
          summary: result.summary.slice(0, 500),
          ts: Date.now(),
        });
      })
      .catch(err => {
        logError(`Proactive loop: session "${sessionId}" failed`, err);
        broadcastSSE({
          type: 'proactive_result',
          sessionId,
          service: svc.name,
          status: 'error',
          error: (err as Error).message,
          ts: Date.now(),
        });
      });
  }
}

// ──────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    ok: true,
    sessions: sessions.size,
    uptime: Math.floor(process.uptime()),
  });
}

function handleListSessions(res: ServerResponse): void {
  const list: Array<{
    id: string;
    status: string;
    targetDir: string;
    started: number;
    mode: string;
  }> = [];

  for (const [id, entry] of sessions) {
    list.push({
      id,
      status: entry.session.status,
      targetDir: entry.targetDir,
      started: entry.started,
      mode: entry.mode,
    });
  }

  sendJson(res, 200, list);
}

function handleGetSession(res: ServerResponse, id: string): void {
  const entry = sessions.get(id);
  if (!entry) {
    sendJson(res, 404, { error: `Session "${id}" not found` });
    return;
  }

  sendJson(res, 200, {
    id: entry.session.id,
    status: entry.session.status,
    targetDir: entry.targetDir,
    mode: entry.mode,
    started: entry.started,
    incidentSummary: entry.session.incidentSummary,
    actionsLedger: entry.session.actionsLedger,
    contextFiles: entry.session.contextFiles,
    createdAt: entry.session.createdAt,
    lastActiveAt: entry.session.lastActiveAt,
    abortFlag: entry.session.abortFlag,
  });
}

async function handleSteerSession(
  res: ServerResponse,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const entry = sessions.get(id);
  if (!entry) {
    sendJson(res, 404, { error: `Session "${id}" not found` });
    return;
  }

  const message = typeof body.message === 'string' ? body.message : '';
  if (!message) {
    sendJson(res, 400, { error: 'Missing "message" field' });
    return;
  }

  appendSteerMessage(entry.session, 'operator', message);
  sendJson(res, 200, { ok: true, sessionId: id });
}

function handleAbortSession(res: ServerResponse, id: string): void {
  const entry = sessions.get(id);
  if (!entry) {
    sendJson(res, 404, { error: `Session "${id}" not found` });
    return;
  }

  setAbortFlag(entry.session);
  entry.session.status = 'closed';
  sendJson(res, 200, { ok: true, sessionId: id, aborted: true });
}

async function handleApproveSession(
  res: ServerResponse,
  id: string,
  body: Record<string, unknown>,
): Promise<void> {
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId : '';
  const decision = typeof body.decision === 'string' ? body.decision : '';

  if (!approvalId) {
    sendJson(res, 400, { error: 'Missing "approvalId" field' });
    return;
  }

  if (!['allow', 'allow_incident', 'deny'].includes(decision)) {
    sendJson(res, 400, { error: 'decision must be "allow", "allow_incident", or "deny"' });
    return;
  }

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    sendJson(res, 404, { error: `Approval "${approvalId}" not found or already resolved` });
    return;
  }

  if (pending.sessionId !== id) {
    sendJson(res, 400, { error: `Approval "${approvalId}" does not belong to session "${id}"` });
    return;
  }

  clearTimeout(pending.timeout);
  pendingApprovals.delete(approvalId);
  pending.resolve(decision);

  sendJson(res, 200, { ok: true, approvalId, decision });
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown>,
): Promise<void> {
  const message = typeof body.message === 'string' ? body.message : '';
  if (!message) {
    sendJson(res, 400, { error: 'Missing "message" field' });
    return;
  }

  const targetDir = typeof body.targetDir === 'string' ? body.targetDir : process.cwd();
  const mode = (typeof body.mode === 'string' && ['interactive', 'auto'].includes(body.mode))
    ? body.mode as 'interactive' | 'auto'
    : 'interactive';
  const sessionId = typeof body.sessionId === 'string' && body.sessionId
    ? body.sessionId
    : `destro-${Date.now()}`;

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });

  // Register SSE client
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });

  // Find or create session
  let entry = sessions.get(sessionId);
  if (!entry) {
    const newSession = createDestroSession(sessionId);
    entry = {
      session: newSession,
      targetDir,
      mode,
      activeLoop: null,
      started: Date.now(),
    };
    sessions.set(sessionId, entry);
  }

  // Load config
  let config: DestroConfig;
  try {
    config = await loadDestroConfig();
  } catch (err) {
    sendSSE(res, {
      type: 'result',
      status: 'error',
      error: `Failed to load config: ${(err as Error).message}`,
    });
    res.end();
    sseClients.delete(res);
    return;
  }

  log(`Starting chat session "${sessionId}" (mode=${mode}, targetDir=${targetDir})`);

  // Run the agent loop with SSE callbacks
  const loopPromise = destroAgentLoop({
    targetDir,
    userMessage: message,
    sessionId,
    config,
    onToolCall: (name, input) => {
      sendSSE(res, { type: 'tool', name, input });

      // Approval plumbing for mutation tools
      if (MUTATION_TOOLS.has(name)) {
        if (entry!.mode === 'auto') {
          // Auto mode: auto-approve unconditionally
          sendSSE(res, {
            type: 'approval_request',
            approvalId: `auto-${Date.now()}`,
            tool: name,
            input,
            decision: 'auto_approved',
            message: `Auto-approved mutation: ${name}`,
          });
        } else {
          // Interactive mode: emit approval_request and set up pending approval
          const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

          sendSSE(res, {
            type: 'approval_request',
            approvalId,
            tool: name,
            input,
            sessionId,
          });

          // Create a pending approval that the /approve endpoint resolves
          const pendingPromise = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(approvalId);
              sendSSE(res, {
                type: 'approval_timeout',
                approvalId,
                tool: name,
                message: `Approval for "${name}" timed out after ${APPROVAL_TIMEOUT_MS / 1000}s`,
              });
              reject(new Error('Approval timed out'));
            }, APPROVAL_TIMEOUT_MS);

            pendingApprovals.set(approvalId, {
              resolve: (decision: string) => {
                clearTimeout(timeout);
                resolve(decision);
              },
              reject: (err: Error) => {
                clearTimeout(timeout);
                reject(err);
              },
              sessionId,
              timeout,
            });
          });

          // Fire-and-forget: handle decision asynchronously
          pendingPromise
            .then(decision => {
              if (decision === 'deny') {
                setAbortFlag(entry!.session);
                sendSSE(res, {
                  type: 'content',
                  content: `Tool "${name}" denied by operator. Session aborted.`,
                });
              } else {
                sendSSE(res, {
                  type: 'approval_resolved',
                  approvalId,
                  decision,
                  tool: name,
                });
              }
            })
            .catch(() => {
              // Timeout — escalate
              setAbortFlag(entry!.session);
              entry!.session.status = 'escalated';
            });
        }
      }
    },
    onTurn: (turn, status) => {
      sendSSE(res, { type: 'turn', turn, status });
    },
  });

  entry.activeLoop = loopPromise;

  try {
    const result = await loopPromise;

    // Update session from result
    entry.session = result.session;
    entry.session.status =
      result.status === 'resolved' ? 'closed'
      : result.status === 'escalated' ? 'escalated'
      : 'closed';

    sendSSE(res, {
      type: 'result',
      status: result.status,
      summary: result.summary,
      actionsLedger: result.actionsLedger,
      error: result.error,
    });
  } catch (err) {
    sendSSE(res, {
      type: 'result',
      status: 'error',
      error: (err as Error).message,
    });
  } finally {
    res.end();
    sseClients.delete(res);
  }
}

// ──────────────────────────────────────────────
// Request router
// ──────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  const method = (req.method || 'GET').toUpperCase();

  const route = matchRoute(method, url);

  if (!route) {
    sendJson(res, 404, { error: `Not found: ${method} ${url}` });
    return;
  }

  try {
    switch (route.handler) {
      case 'health':
        handleHealth(res);
        break;

      case 'listSessions':
        handleListSessions(res);
        break;

      case 'getSession':
        handleGetSession(res, route.params.id);
        break;

      case 'chat': {
        const body = await parseJsonBody(req);
        await handleChat(req, res, body);
        break;
      }

      case 'steerSession': {
        const body = await parseJsonBody(req);
        await handleSteerSession(res, route.params.id, body);
        break;
      }

      case 'abortSession':
        handleAbortSession(res, route.params.id);
        break;

      case 'approveSession': {
        const body = await parseJsonBody(req);
        await handleApproveSession(res, route.params.id, body);
        break;
      }

      default:
        sendJson(res, 404, { error: `Unknown handler: ${route.handler}` });
    }
  } catch (err) {
    logError(`Error handling ${method} ${url}`, err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'Internal server error' });
    }
  }
}

// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  log('Starting Destro daemon...');

  // Load config (validates env setup early)
  let config: DestroConfig;
  try {
    config = await loadDestroConfig();
    log(`Config loaded: provider=${config.provider.baseUrl}, model=${config.provider.model}`);
  } catch (err) {
    logError('Failed to load config', err);
    process.exit(1);
  }

  // Create HTTP server
  const server = createServer(handleRequest);

  server.listen(PORT, HOST, () => {
    log(`Destro daemon listening on http://${HOST}:${PORT}`);
    log(`Endpoints:`);
    log(`  GET  /health`);
    log(`  POST /chat`);
    log(`  GET  /sessions`);
    log(`  GET  /sessions/:id`);
    log(`  POST /sessions/:id/steer`);
    log(`  POST /sessions/:id/abort`);
    log(`  POST /sessions/:id/approve`);

    const autoheal = process.env.DESTRO_AUTOHEAL === '1' ? 'enabled' : 'disabled (diagnose-only)';
    log(`Autoheal: ${autoheal}`);
  });

  // Start proactive loop
  proactiveTimer = setInterval(() => {
    runProactiveLoop(config).catch(err => {
      logError('Proactive loop error', err);
    });
  }, PROACTIVE_INTERVAL_MS);

  // Run initial probe immediately after a short delay
  setTimeout(() => {
    runProactiveLoop(config).catch(err => {
      logError('Initial proactive loop error', err);
    });
  }, 5_000);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    log(`Received ${signal} — shutting down gracefully...`);

    if (proactiveTimer) {
      clearInterval(proactiveTimer);
      proactiveTimer = null;
    }

    // Abort all active sessions
    for (const [, entry] of sessions) {
      setAbortFlag(entry.session);
      entry.session.status = 'closed';
    }

    // Reject all pending approvals
    for (const [id, pending] of pendingApprovals) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Server shutting down'));
      pendingApprovals.delete(id);
    }

    // Close all SSE connections
    for (const client of sseClients) {
      try { client.end(); } catch { /* best-effort */ }
    }
    sseClients.clear();

    server.close(() => {
      log('Destro daemon shut down.');
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      log('Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ──────────────────────────────────────────────
// Bootstrap
// ──────────────────────────────────────────────

main().catch(err => {
  logError('Fatal error during bootstrap', err);
  process.exit(1);
});
