import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  validateSession,
  parseSessionCookie,
} from './sessions.js';
import { loadRemoteConfig } from './remote-config.js';

// ---------------------------------------------------------------------------
// Auth gate middleware — blocks all unauthenticated access
// ---------------------------------------------------------------------------

// Paths that do NOT require authentication
const PUBLIC_PATHS = new Set([
  '/',              // Login page (GET only)
  '/auth/login',    // Login endpoint
  '/auth/logout',   // Logout endpoint
  '/auth/status',   // Session status check
  '/auth/oidc',     // OIDC redirect endpoint
  '/auth/oidc/callback', // OIDC callback
]);

// Path prefixes for static assets (no auth required)
const STATIC_PREFIXES = [
  '/assets/',
  '/pwa/',
  '/src/',
  '/favicon.ico',
  '/manifest.json',
];

// Rate limiting — configurable
interface RateLimitEntry {
  count: number;
  firstAttempt: number;
  lockedUntil: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

// Defaults, overridden by configureRateLimit()
let MAX_FAILED_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
let LOCKOUT_DURATION_MS = 30_000; // 30 seconds

// Cleanup rate limit entries every 5 minutes
const RL_CLEANUP_INTERVAL = 5 * 60 * 1000;
const rlCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.lockedUntil && now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}, RL_CLEANUP_INTERVAL);
rlCleanupTimer.unref();

/**
 * Apply remote configuration to rate limiting.
 * Call once during server startup.
 */
export function configureRateLimit(config?: { loginMaxAttempts?: number; loginLockoutSeconds?: number }): void {
  const rc = config || loadRemoteConfig();
  if (rc.loginMaxAttempts) {
    MAX_FAILED_ATTEMPTS = rc.loginMaxAttempts;
  }
  if (rc.loginLockoutSeconds) {
    LOCKOUT_DURATION_MS = rc.loginLockoutSeconds * 1000;
  }
}

function extractIP(req: IncomingMessage): string {
  const addr = req.socket?.remoteAddress || req.headers['x-forwarded-for'] as string || '127.0.0.1';
  return addr.replace(/^::ffff:/, '').split(',')[0].trim();
}

function isStaticAsset(pathname: string): boolean {
  return STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix)) ||
         pathname.match(/\.(js|mjs|css|png|svg|ico|woff2|map|json)$/i) !== null;
}

function isPublicPath(method: string, pathname: string): boolean {
  // GET / is the login page (or redirect to shell if authenticated)
  if (method === 'GET' && pathname === '/') return true;
  // GET /login.html is the SPA login page entry
  if (method === 'GET' && pathname === '/login.html') return true;
  // Auth endpoints
  if (PUBLIC_PATHS.has(pathname)) return true;
  // Static assets
  if (method === 'GET' && isStaticAsset(pathname)) return true;
  // OPTIONS (preflight)
  if (method === 'OPTIONS') return true;
  return false;
}

function sendJson(res: ServerResponse, status: number, data: Record<string, unknown>): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export interface AuthResult {
  authenticated: boolean;
  user?: string;
  token?: string;
  reason?: 'no_cookie' | 'invalid_session' | 'expired' | 'rate_limited' | 'ok';
}

/**
 * Check rate limit for an IP. Returns true if the request should be blocked.
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry) {
    // Check if currently locked out
    if (now < entry.lockedUntil) {
      return true; // Still locked out
    }

    // Reset if window has passed
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
      return false;
    }

    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.lockedUntil = now + LOCKOUT_DURATION_MS;
      return true;
    }
  }

  return false;
}

/**
 * Record a failed login attempt for rate limiting.
 */
export function recordFailedAttempt(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry && now - entry.firstAttempt <= RATE_LIMIT_WINDOW_MS) {
    entry.count++;
  } else {
    rateLimitMap.set(ip, {
      count: 1,
      firstAttempt: now,
      lockedUntil: 0,
    });
  }
}

/**
 * Clear rate limit for an IP (on successful auth).
 */
export function clearRateLimit(ip: string): void {
  rateLimitMap.delete(ip);
}

/**
 * Authenticate a request.
 * Returns AuthResult with authentication status.
 */
export function authenticateRequest(req: IncomingMessage): AuthResult {
  const cookieHeader = req.headers.cookie || '';
  const token = parseSessionCookie(cookieHeader);

  if (!token) {
    return { authenticated: false, reason: 'no_cookie' };
  }

  const session = validateSession(token);
  if (!session) {
    return { authenticated: false, reason: 'invalid_session' };
  }

  return {
    authenticated: true,
    user: session.user,
    token,
    reason: 'ok',
  };
}

/**
 * Auth gate middleware for HTTP requests.
 * Returns true if the request is allowed to proceed.
 * If false, the caller should send appropriate response (401 or redirect).
 */
export function authGate(req: IncomingMessage, res: ServerResponse): { proceed: boolean; auth: AuthResult } {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  // Always authenticate — even on public paths — so callers know auth state
  const auth = authenticateRequest(req);

  // Allow public paths through without blocking
  if (isPublicPath(method, pathname)) {
    return { proceed: true, auth };
  }

  // Rate limit check (only for protected paths)
  const ip = extractIP(req);
  if (checkRateLimit(ip)) {
    const body = JSON.stringify({ error: 'Too many requests. Please wait 30 seconds.' });
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Retry-After': String(Math.ceil(LOCKOUT_DURATION_MS / 1000)),
    });
    res.end(body);
    return { proceed: false, auth: { authenticated: false, reason: 'rate_limited' } };
  }

  if (!auth.authenticated) {
    // For API requests, return 401 JSON
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      sendJson(res, 401, { error: 'Unauthorized', reason: auth.reason });
    } else {
      // For page requests, redirect to login
      const redirectBody = '<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/"></head><body></body></html>';
      res.writeHead(302, {
        'Location': '/',
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(redirectBody),
      });
      res.end(redirectBody);
    }
    return { proceed: false, auth };
  }

  return { proceed: true, auth };
}

/**
 * Authenticate a WebSocket upgrade request.
 * Extracts the session cookie from the upgrade headers.
 */
export function authWsUpgrade(req: IncomingMessage): AuthResult {
  const cookieHeader = req.headers.cookie || '';
  const token = parseSessionCookie(cookieHeader);

  if (!token) {
    return { authenticated: false, reason: 'no_cookie' };
  }

  const session = validateSession(token);
  if (!session) {
    return { authenticated: false, reason: 'invalid_session' };
  }

  return {
    authenticated: true,
    user: session.user,
    token,
    reason: 'ok',
  };
}
