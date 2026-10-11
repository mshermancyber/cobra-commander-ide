import { spawn, type IPty } from 'node-pty';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// WebSocket-to-PTY Bridge using node-pty
// ---------------------------------------------------------------------------

interface PTYSession {
  id: string;
  pty: IPty;
  ws: WebSocket;
  reconnectTimeout?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, PTYSession>();
const RECONNECT_GRACE_MS = 60_000; // Keep PTY alive for 60s after disconnect

function createPTY(): IPty {
  const npx = join(process.execPath, '..', 'npx');
  return spawn(npx, ['tsx', join(process.cwd(), 'src/remote/assistant-repl.ts')], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

export function handleTerminalConnection(ws: WebSocket, sessionId?: string): string {
  // Check if this is a reconnection
  if (sessionId && sessions.has(sessionId)) {
    const existing = sessions.get(sessionId)!;
    clearTimeout(existing.reconnectTimeout);

    existing.ws = ws;
    existing.reconnectTimeout = undefined;

    // Reattach output
    existing.pty.onData((data: string) => {
      sendJson(ws, { type: 'output', data });
    });

    sendJson(ws, { type: 'connected', sessionId: existing.id });
    return existing.id;
  }

  // New session
  const id = sessionId || randomUUID();
  const pty = createPTY();

  const session: PTYSession = { id, pty, ws };
  sessions.set(id, session);

  // Pipe PTY output to WebSocket
  pty.onData((data: string) => {
    sendJson(ws, { type: 'output', data });
  });

  // Handle PTY exit
  pty.onExit(({ exitCode, signal }) => {
    sendJson(ws, { type: 'exit', code: exitCode, signal: signal ?? undefined });
    sessions.delete(id);
  });

  // Handle WebSocket messages
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      switch (msg.type) {
        case 'input':
          if (typeof msg.data === 'string') {
            pty.write(msg.data);
          }
          break;
        case 'resize':
          if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
            pty.resize(msg.cols, msg.rows);
          }
          break;
      }
    } catch { /* ignore invalid messages */ }
  });

  // Handle WebSocket close — keep PTY alive for potential reconnect
  ws.on('close', () => {
    session.reconnectTimeout = setTimeout(() => {
      pty.kill();
      sessions.delete(id);
    }, RECONNECT_GRACE_MS);
  });

  ws.on('error', () => {
    session.reconnectTimeout = setTimeout(() => {
      pty.kill();
      sessions.delete(id);
    }, RECONNECT_GRACE_MS);
  });

  sendJson(ws, { type: 'connected', sessionId: id });
  return id;
}

export function getActiveTerminalCount(): number {
  return sessions.size;
}

export function shutdownAllTerminals(): void {
  for (const [id, session] of sessions) {
    clearTimeout(session.reconnectTimeout);
    session.pty.kill();
    sessions.delete(id);
  }
}
