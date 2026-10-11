import { createServer, request as httpRequest } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { getTailscaleIP } from '../core/tailscale.js';
import { handleTerminalConnection, shutdownAllTerminals } from './pty-bridge.js';
import { handleChatConnection, shutdownAllChat } from './chat-bridge.js';
import {
  listChats,
  getChat,
  createChat,
  archiveChat,
  unarchiveChat,
  deleteChat,
} from './chat-store.js';
import {
  createSession,
  destroySession,
  parseSessionCookie,
  formatSessionCookie,
  clearSessionCookie,
  validateSession,
  configureSessions,
} from './sessions.js';
import {
  authGate,
  authWsUpgrade,
  recordFailedAttempt,
  clearRateLimit,
  configureRateLimit,
} from './auth-middleware.js';
import { loadRemoteConfig, type RemoteConfig } from './remote-config.js';
import { createAuthProvider } from './auth-providers/factory.js';
import { TokenAuthProvider } from './auth-providers/token.js';
import type { AuthProvider } from './auth-providers/index.js';
import { DEFAULT_API_PORT } from '../core/net-defaults.js';
import { installRoot } from '../core/env-file.js';

// ---------------------------------------------------------------------------
// Remote Control HTTP Server
// Configurable via .env — bind address, auth provider, rate limits, etc.
// ---------------------------------------------------------------------------

export interface RemoteServerOptions {
  port?: number;
  workDir: string;
  config?: Partial<RemoteConfig>;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

// ---------------------------------------------------------------------------
// Paths that should redirect authenticated users to the shell
// ---------------------------------------------------------------------------
const SHELL_PATH = '/index.html';

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function getStaticDir(): string {
  // Resolve against the install root, not the cwd: the daemon is routinely
  // started from whatever project directory it is working on.
  const root = installRoot();
  const dist = join(root, 'gui', 'webshell', 'dist');
  if (existsSync(dist)) return dist;
  return join(root, 'gui', 'webshell');
}

/**
 * Read the built login HTML. Falls back to a minimal inlined login page
 * if the dist files haven't been built yet.
 */
function getLoginPage(): string {
  const loginPath = join(getStaticDir(), 'login.html');
  if (existsSync(loginPath)) {
    try {
      return readFileSync(loginPath, 'utf-8');
    } catch { /* fall through */ }
  }

  // Cobra Commander login page — green-on-black matrix theme with Grok logo
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#0a0a0a">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="icon" type="image/jpeg" href="/assets/favicon.jpg">
  <link rel="apple-touch-icon" href="/assets/cobra-logo.jpg">
  <title>Cobra Commander</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100dvh; overflow: hidden; overscroll-behavior: none; }
    body {
      background: #0a0a0a;
      color: #d0e0d0;
      font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    .login-card {
      background: #0f140f;
      border: 1px solid #1e2d1e;
      border-radius: 12px;
      padding: 32px 24px;
      width: 100%;
      max-width: 360px;
      margin: 16px;
      box-shadow: 0 0 30px rgba(0,255,65,0.15);
    }
    .logo {
      display: block;
      width: 320px;
      max-width: 90%;
      height: auto;
      margin: 0 auto 16px;
      border-radius: 12px;
      object-fit: contain;
      filter: drop-shadow(0 0 20px rgba(0,255,65,0.4));
    }
    .login-card h1 {
      font-size: 22px; font-weight: 700; margin-bottom: 4px; text-align: center;
      color: #00ff41; text-shadow: 0 0 20px rgba(0,255,65,0.3);
      letter-spacing: 2px; text-transform: uppercase;
    }
    .login-card .subtitle {
      font-size: 11px; color: #7a9a7a; text-align: center; margin-bottom: 24px; letter-spacing: 1px;
    }
    .form-group { margin-bottom: 16px; }
    .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; color: #7a9a7a; user-select: none; }
    .form-group input {
      width: 100%; min-height: 44px; padding: 10px 14px;
      background: #080b08; color: #d0e0d0;
      border: 1px solid #1e2d1e; border-radius: 8px;
      font-family: inherit; font-size: 16px;
      outline: none; -webkit-appearance: none;
      transition: border-color 0.2s;
    }
    .form-group input:focus { border-color: #00ff41; }
    .form-group input.error { border-color: #ff3333; }
    .error-msg { color: #ff3333; font-size: 12px; margin-top: 4px; min-height: 18px; }
    .login-btn {
      width: 100%; min-height: 44px;
      background: #00ff41; color: #0a0a0a;
      border: none; border-radius: 8px;
      font-family: inherit; font-size: 15px; font-weight: 700;
      cursor: pointer; margin-top: 8px;
      transition: opacity 0.15s, box-shadow 0.2s;
      -webkit-appearance: none;
      box-shadow: 0 0 20px rgba(0,255,65,0.3);
      letter-spacing: 1px; text-transform: uppercase;
    }
    .login-btn:active { opacity: 0.8; }
    .login-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    @keyframes shake { 0%,100% { transform: translateX(0); } 20% { transform: translateX(-6px); } 40% { transform: translateX(6px); } 60% { transform: translateX(-4px); } 80% { transform: translateX(4px); } }
    .shake { animation: shake 0.4s ease; }
  </style>
</head>
<body>
  <div class="login-card" id="login-card">
    <img class="logo" src="/assets/cobra-logo.jpg" alt="Cobra Commander">
    <h1>Cobra Commander</h1>
    <p class="subtitle">Head of Engineering &middot; Direct Access</p>
    <div class="form-group">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" placeholder="linux user">
      <div class="error-msg" id="username-error"></div>
    </div>
    <div class="form-group">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" placeholder="password">
      <div class="error-msg" id="password-error"></div>
    </div>
    <button class="login-btn" id="login-btn" type="submit">Sign In</button>
    <div class="error-msg" id="login-error" style="text-align:center;margin-top:12px;"></div>
  </div>
  <script>
    var card = document.getElementById('login-card');
    var btn = document.getElementById('login-btn');
    var loginError = document.getElementById('login-error');
    btn.addEventListener('click', function() {
      var u = document.getElementById('username').value.trim();
      var p = document.getElementById('password').value;
      if (!u) { document.getElementById('username').classList.add('error'); document.getElementById('username-error').textContent = 'Required'; card.classList.add('shake'); setTimeout(function(){card.classList.remove('shake')},400); return; }
      if (!p) { document.getElementById('password').classList.add('error'); document.getElementById('password-error').textContent = 'Required'; card.classList.add('shake'); setTimeout(function(){card.classList.remove('shake')},400); return; }
      document.getElementById('username').classList.remove('error');
      document.getElementById('password').classList.remove('error');
      document.getElementById('username-error').textContent = '';
      document.getElementById('password-error').textContent = '';
      loginError.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Signing in...';
      fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })
        .then(function(r) {
          if (r.ok) return r.json().then(function(d) { window.location.href = '/index.html'; });
          if (r.status === 429) { loginError.textContent = 'Too many attempts. Wait 30 seconds.'; }
          else if (r.status === 401) { loginError.textContent = 'Invalid username or password.'; card.classList.add('shake'); setTimeout(function(){card.classList.remove('shake')},400); }
          else { loginError.textContent = 'Login failed. Please try again.'; }
          btn.disabled = false;
          btn.textContent = 'Sign In';
        })
        .catch(function() { loginError.textContent = 'Connection error.'; btn.disabled = false; btn.textContent = 'Sign In'; });
    });
    document.getElementById('password').addEventListener('keydown', function(e) { if (e.key === 'Enter') btn.click(); });
    document.getElementById('username').addEventListener('keydown', function(e) { if (e.key === 'Enter') btn.click(); });
  </script>
</body>
</html>`;
}

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;

  // Default to index.html for root
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }

  const staticDir = getStaticDir();
  const filePath = join(staticDir, pathname);

  // Prevent directory traversal
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for unknown paths
    const indexPath = join(staticDir, 'index.html');
    if (existsSync(indexPath)) {
      try {
        const content = readFileSync(indexPath);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': content.length,
          'Cache-Control': 'no-cache',
        });
        res.end(content);
        return true;
      } catch { /* fall through to 404 */ }
    }
    return false;
  }

  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = readFileSync(filePath);
    const cacheControl = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': content.length,
      'Cache-Control': cacheControl,
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request body parser (for JSON)
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, maxSize: number = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxSize) {
        req.destroy();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Auth endpoints
// ---------------------------------------------------------------------------

async function handleAuthLogin(
  req: IncomingMessage,
  res: ServerResponse,
  provider: AuthProvider,
  config: RemoteConfig,
): Promise<void> {
  // Parse body
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 413, { error: 'Payload too large' });
    return;
  }

  let parsed: { username?: string; password?: string; grant_type?: string; code?: string };
  try {
    parsed = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const ip = req.socket?.remoteAddress || '127.0.0.1';

  // ── Standard username/password ──
  const { username, password } = parsed;
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    sendJson(res, 401, { error: 'Invalid credentials' });
    return;
  }

  // Check allowed users list (if configured)
  if (config.allowedUsers.length > 0 && !config.allowedUsers.includes(username)) {
    recordFailedAttempt(ip);
    sendJson(res, 401, { error: 'Invalid credentials' });
    return;
  }

  // Authenticate via provider
  const result = await provider.authenticate(username, password);

  if (!result.success) {
    recordFailedAttempt(ip);
    sendJson(res, 401, { error: 'Invalid credentials' });
    return;
  }

  // Success — clear rate limit and create session
  clearRateLimit(ip);
  const sessionTTL = config.sessionTTL * 1000;
  const token = createSession(result.user || username, sessionTTL);
  const cookie = formatSessionCookie(token, config.sessionTTL);

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': cookie,
    'Content-Length': '2',
  });
  res.end('{}');
}

function handleAuthLogout(req: IncomingMessage, res: ServerResponse): void {
  const cookieHeader = req.headers.cookie || '';
  const token = parseSessionCookie(cookieHeader);

  if (token) {
    destroySession(token);
  }

  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Set-Cookie': clearSessionCookie(),
    'Content-Length': '2',
  });
  res.end('{}');
}

function handleAuthStatus(req: IncomingMessage, res: ServerResponse): void {
  const cookieHeader = req.headers.cookie || '';
  const token = parseSessionCookie(cookieHeader);

  if (!token) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  const session = validateSession(token);
  if (!session) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  sendJson(res, 200, {
    authenticated: true,
    user: session.user,
    created: session.created,
    expires: session.expires,
  });
}

// ---------------------------------------------------------------------------
// Resolve bind address
// ---------------------------------------------------------------------------

async function resolveBindAddress(bind: string): Promise<string | null> {
  switch (bind) {
    case 'tailscale': {
      const ip = getTailscaleIP();
      if (ip) return ip;

      const maxWait = 5 * 60 * 1000;
      const interval = 10_000;
      const deadline = Date.now() + maxWait;
      console.log('  Remote control: waiting for Tailscale (up to 5 min)...');

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, interval));
        const retry = getTailscaleIP();
        if (retry) {
          console.log(`  Remote control: Tailscale detected (${retry})`);
          return retry;
        }
      }

      console.log('  Remote control: disabled (Tailscale not available after 5 min)');
      return null;
    }
    case 'localhost':
      return '127.0.0.1';
    case '0.0.0.0':
      return '0.0.0.0';
    default:
      return bind;
  }
}

function bindLabel(bind: string, addr: string): string {
  switch (bind) {
    case 'tailscale': return `Tailscale (${addr})`;
    case 'localhost': return 'localhost only';
    case '0.0.0.0': return 'all interfaces';
    default: return addr;
  }
}

// ---------------------------------------------------------------------------
// Main server
// ---------------------------------------------------------------------------

export async function startRemoteServer(
  options: RemoteServerOptions,
): Promise<{ port: number; close: () => void } | null> {
  const rc = loadRemoteConfig();

  // Merge any overrides from options
  if (options.config) {
    Object.assign(rc, options.config);
  }

  // Allow explicit port override from options
  const port = options.port ?? rc.port;

  // Check if remote control is enabled
  if (!rc.enabled) {
    console.log('  Remote control: disabled (REMOTE_ENABLED=false)');
    return null;
  }

  // Resolve bind address
  const bindAddr = await resolveBindAddress(rc.bind);
  if (!bindAddr) {
    return null;
  }

  // Configure sessions and rate limiting from remote config
  configureSessions({ sessionTTL: rc.sessionTTL, maxSessions: rc.maxSessions });
  configureRateLimit({ loginMaxAttempts: rc.loginMaxAttempts, loginLockoutSeconds: rc.loginLockoutSeconds });

  // Create the configured auth provider. A web shell that hands out a terminal
  // must never listen without a credential, so an unconfigured token provider
  // is a startup failure rather than an open door.
  const provider = createAuthProvider({ provider: rc.authMode, pamService: rc.pamService });
  if (provider instanceof TokenAuthProvider && !provider.isConfigured()) {
    console.error('  Remote control: refusing to start — no credential configured.');
    console.error('  Set REMOTE_AUTH_PASSWORD_HASH in .env (npx tsx src/remote/auth-providers/token.ts <password>)');
    console.error('  or choose another provider with REMOTE_AUTH_MODE=pam.');
    return null;
  }

  // Only trust same-origin / localhost / Tailscale origins. Reflecting an
  // arbitrary Origin together with Allow-Credentials lets any website the user
  // visits ride their authenticated session against this server.
  const isAllowedOrigin = (origin: string, host: string): boolean => {
    try {
      const u = new URL(origin);
      if (host && (u.host === host || u.hostname === host.split(':')[0])) return true;
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(u.hostname)) return true; // Tailscale 100.64/10
      return false;
    } catch { return false; }
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS headers — credentialed CORS only for trusted origins.
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin, req.headers.host || '')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // ── Auth endpoints (public paths) ──
    if (pathname === '/auth/login' && req.method === 'POST') {
      await handleAuthLogin(req, res, provider, rc);
      return;
    }

    if (pathname === '/auth/logout' && req.method === 'POST') {
      handleAuthLogout(req, res);
      return;
    }

    if (pathname === '/auth/status' && req.method === 'GET') {
      handleAuthStatus(req, res);
      return;
    }

    // ── Static assets served without auth (login page needs logo/favicon) ──
    if (pathname.startsWith('/assets/') || pathname === '/favicon.jpg' || pathname.startsWith('/pwa/')) {
      if (serveStatic(req, res)) return;
    }

    // ── Auth gate for everything else ──
    const gateResult = authGate(req, res);
    if (!gateResult.proceed) {
      return; // Response already sent by authGate
    }

    // ── GET / serves login page for unauthenticated, redirects to shell for authenticated ──
    if (req.method === 'GET' && pathname === '/') {
      // If already authenticated, redirect to shell
      if (gateResult.auth.authenticated) {
        res.writeHead(302, { 'Location': SHELL_PATH });
        res.end();
        return;
      }

      // Serve login page
      const loginPage = getLoginPage();
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(loginPage),
        'Cache-Control': 'no-cache',
      });
      res.end(loginPage);
      return;
    }

    // ── Health endpoint ──
    if (pathname === '/api/health' && req.method === 'GET') {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const health: Record<string, unknown> = {
        status: 'ok',
        uptime: Math.floor(uptime),
        uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`,
        memory: {
          rss: Math.round(mem.rss / 1024 / 1024),
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          external: Math.round(mem.external / 1024 / 1024),
        },
        node: process.version,
        pid: process.pid,
      };
      sendJson(res, 200, health);
      return;
    }

    // ── Chat API endpoints ──
    if (pathname.startsWith('/api/chats') && gateResult.auth.authenticated) {
      const username = gateResult.auth.user!;
      const chatMatch = pathname.match(/^\/api\/chats\/([^/]+)$/);

      if (req.method === 'GET' && pathname === '/api/chats') {
        // List non-archived chats
        const chats = listChats(username);
        sendJson(res, 200, { chats } as Record<string, unknown>);
        return;
      }

      if (req.method === 'GET' && pathname === '/api/chats/archived') {
        // List archived chats
        const chats = listChats(username, true);
        sendJson(res, 200, { chats } as Record<string, unknown>);
        return;
      }

      if (req.method === 'GET' && chatMatch) {
        // Get single chat
        const chat = getChat(username, chatMatch[1]);
        if (!chat) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, { chat } as Record<string, unknown>);
        return;
      }

      if (req.method === 'POST' && pathname === '/api/chats') {
        // Create new chat
        let title: string | undefined;
        try {
          const body = await readBody(req);
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.title === 'string') title = parsed.title;
        } catch { /* no body or invalid json — create with default title */ }
        const chat = createChat(username, title);
        sendJson(res, 201, { id: chat.id, title: chat.title } as Record<string, unknown>);
        return;
      }

      if (req.method === 'DELETE' && chatMatch) {
        // Permanently delete chat
        const ok = deleteChat(username, chatMatch[1]);
        if (!ok) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, { deleted: true });
        return;
      }

      // Match /api/chats/:id/archive or /api/chats/:id/unarchive
      const chatActionMatch = pathname.match(/^\/api\/chats\/([^/]+)\/(archive|unarchive)$/);

      if (req.method === 'POST' && chatActionMatch && chatActionMatch[2] === 'archive') {
        // Archive chat
        const ok = archiveChat(username, chatActionMatch[1]);
        if (!ok) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, { archived: true });
        return;
      }

      if (req.method === 'POST' && chatActionMatch && chatActionMatch[2] === 'unarchive') {
        // Unarchive chat
        const ok = unarchiveChat(username, chatActionMatch[1]);
        if (!ok) {
          sendJson(res, 404, { error: 'Chat not found' });
          return;
        }
        sendJson(res, 200, { archived: false });
        return;
      }

      // Unknown chat route — 404
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    // ── API proxy: forward /api/* to the local API server ──
    if (pathname.startsWith('/api/')) {
      const apiPort = DEFAULT_API_PORT;
      const apiHost = process.env.API_HOST || '127.0.0.1';
      const apiToken = process.env.API_TOKEN || '';

      let body = '';
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await readBody(req).catch(() => '');
      }

      const proxyReq = httpRequest(
        {
          hostname: apiHost,
          port: apiPort,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${apiHost}:${apiPort}`,
            authorization: `Bearer ${apiToken}`,
          },
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );

      proxyReq.on('error', () => {
        sendJson(res, 502, { error: 'API server unreachable' });
      });

      if (body) proxyReq.write(body);
      proxyReq.end();
      return;
    }

    // ── Serve static files ──
    if (req.method === 'GET') {
      const served = serveStatic(req, res);
      if (!served) {
        res.writeHead(404);
        res.end('Not Found');
      }
      return;
    }

    // ── Reject other methods ──
    res.writeHead(405);
    res.end('Method Not Allowed');
  });

  // ── WebSocket handling ──
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Session auth for WebSocket upgrades
    const auth = authWsUpgrade(req);
    if (!auth.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (pathname === '/ws/terminal' || pathname.startsWith('/ws/terminal')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = url.searchParams.get('sessionId') || undefined;
        handleTerminalConnection(ws, sessionId);
      });
    } else if (pathname === '/ws/chat' || pathname.startsWith('/ws/chat')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const sessionId = url.searchParams.get('sessionId') || randomUUID();
        const username = auth.user || 'unknown';
        handleChatConnection(ws, sessionId, options.workDir, username);
      });
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  const label = bindLabel(rc.bind, bindAddr);
  const authLabel = `${provider.name} auth`;

  return new Promise((resolve) => {
    server.listen(port, bindAddr, () => {
      console.log(`  Remote control: http://${bindAddr}:${port} (${label}, ${authLabel})`);
      resolve({
        port,
        close: () => {
          shutdownAllTerminals();
          shutdownAllChat();
          wss.close();
          server.close();
        },
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`  Remote control: port ${port} in use, retrying...`);
        server.listen(0, bindAddr, () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            console.log(`  Remote control: http://${bindAddr}:${addr.port} (${label}, ${authLabel})`);
            resolve({
              port: addr.port,
              close: () => {
                shutdownAllTerminals();
                shutdownAllChat();
                wss.close();
                server.close();
              },
            });
          } else {
            resolve(null);
          }
        });
      } else {
        console.log(`  Remote control: failed to start — ${err.message}`);
        resolve(null);
      }
    });
  });
}
