import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { sendJson, sendError } from '../middleware/error-handler.js';
import { DEFAULT_SUPPORT_PORT } from '../../core/net-defaults.js';

const DESTRO_PORT = DEFAULT_SUPPORT_PORT;
const DESTRO_HOST = '127.0.0.1';

// ── helpers ──

function parseBody(req: IncomingMessage): Promise<string> {
  const MAX_BODY = 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function proxyJson(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): void {
  const bodyPromise = method !== 'GET' && method !== 'HEAD' ? parseBody(req) : Promise.resolve('');

  bodyPromise.then((body) => {
    const proxyReq = httpRequest(
      {
        hostname: DESTRO_HOST,
        port: DESTRO_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (proxyRes) => {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const status = proxyRes.statusCode || 500;
          try {
            const data = JSON.parse(raw);
            sendJson(res, status, data);
          } catch {
            res.writeHead(status, { 'Content-Type': 'text/plain' });
            res.end(raw);
          }
        });
      },
    );

    proxyReq.on('error', () => {
      sendError(res, 502, 'Destro daemon unreachable');
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }).catch(() => {
    sendError(res, 502, 'Destro daemon unreachable');
  });
}

function proxySSE(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
): void {
  parseBody(req).then((body) => {
    const proxyReq = httpRequest(
      {
        hostname: DESTRO_HOST,
        port: DESTRO_PORT,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        proxyRes.pipe(res);

        // Abort proxy if client disconnects
        req.on('close', () => {
          proxyReq.destroy();
        });
      },
    );

    proxyReq.on('error', () => {
      // If headers haven't been sent yet, send error. Otherwise just end.
      if (!res.headersSent) {
        sendError(res, 502, 'Destro daemon unreachable');
      } else {
        res.end();
      }
    });

    if (body) proxyReq.write(body);
    proxyReq.end();
  }).catch(() => {
    sendError(res, 502, 'Destro daemon unreachable');
  });
}

// ── route handlers ──

async function health(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  proxyJson(_req, res, 'GET', '/health');
}

async function chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  proxySSE(req, res, 'POST', '/chat');
}

async function listSessions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  proxyJson(_req, res, 'GET', '/sessions');
}

async function getSession(_req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  proxyJson(_req, res, 'GET', `/sessions/${params.id}`);
}

async function steer(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  proxyJson(req, res, 'POST', `/sessions/${params.id}/steer`);
}

async function abort(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  proxyJson(req, res, 'POST', `/sessions/${params.id}/abort`);
}

async function approve(req: IncomingMessage, res: ServerResponse, params: Record<string, string>): Promise<void> {
  proxyJson(req, res, 'POST', `/sessions/${params.id}/approve`);
}

// ── factory ──

export function createDestroRoutes() {
  return {
    health,
    chat,
    sessions: listSessions, // alias used by server.ts registration
    getSession,
    steer,
    abort,
    approve,
    listSessions,
  };
}
