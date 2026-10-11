import { createHmac, randomBytes } from 'node:crypto';
import { loadRemoteConfig } from './remote-config.js';

// ---------------------------------------------------------------------------
// Session management — HMAC-SHA256 signed tokens
// ---------------------------------------------------------------------------

export interface SessionEntry {
  user: string;
  created: number;
  expires: number;
}

// Secret for HMAC signing — generated once per process lifetime
const SIGNING_SECRET = randomBytes(64);

// Configurable defaults (overridden by remote config)
let SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
let MAX_SESSIONS = 5;

const sessions = new Map<string, SessionEntry>();

// Periodic cleanup of expired sessions (every 15 minutes)
const CLEANUP_INTERVAL = 15 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function startCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of sessions) {
      if (entry.expires <= now) {
        sessions.delete(token);
      }
    }
  }, CLEANUP_INTERVAL);
  // Allow Node to exit even if this timer is running
  cleanupTimer.unref();
}

/**
 * Apply remote configuration to session management.
 * Call once during server startup.
 */
export function configureSessions(config?: { sessionTTL?: number; maxSessions?: number }): void {
  const rc = config || loadRemoteConfig();
  if (rc.sessionTTL) {
    SESSION_DURATION_MS = rc.sessionTTL * 1000;
  }
  if (rc.maxSessions) {
    MAX_SESSIONS = rc.maxSessions;
  }
}

/**
 * Generate a token: randomPayload.hmacSignature
 * HMAC over `randomPayload:user:created:expires`
 */
function generateToken(user: string, created: number, expires: number): string {
  const payload = Buffer.from(randomBytes(32)).toString('base64url');
  const data = `${payload}:${user}:${created}:${expires}`;
  const hmac = createHmac('sha256', SIGNING_SECRET).update(data).digest('base64url');
  return `${payload}.${hmac}`;
}

/**
 * Verify a token and return its session data if valid.
 * Returns null for invalid, expired, or tampered tokens.
 */
function verifyToken(token: string): SessionEntry | null {
  const entry = sessions.get(token);
  if (!entry) return null;

  if (entry.expires <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return entry;
}

/**
 * Enforce max sessions per user — remove oldest if over limit.
 */
function enforceSessionLimit(user: string): void {
  const userSessions: { token: string; created: number }[] = [];
  for (const [token, entry] of sessions) {
    if (entry.user === user) {
      userSessions.push({ token, created: entry.created });
    }
  }

  // Sort oldest first
  userSessions.sort((a, b) => a.created - b.created);

  // Remove oldest sessions if over limit
  while (userSessions.length > MAX_SESSIONS) {
    const oldest = userSessions.shift()!;
    sessions.delete(oldest.token);
  }
}

/**
 * Create a new session for a user.
 * Returns the signed session token.
 */
export function createSession(user: string, ttlMs?: number): string {
  startCleanup();

  const duration = ttlMs || SESSION_DURATION_MS;
  const created = Date.now();
  const expires = created + duration;
  const token = generateToken(user, created, expires);

  // Enforce per-user session limit
  enforceSessionLimit(user);

  sessions.set(token, { user, created, expires });
  return token;
}

/**
 * Validate a session token and return the SessionEntry if valid.
 */
export function validateSession(token: string): SessionEntry | null {
  return verifyToken(token);
}

/**
 * Destroy a session by token.
 */
export function destroySession(token: string): boolean {
  return sessions.delete(token);
}

/**
 * Parse the cobra_session cookie from a Cookie header string.
 */
export function parseSessionCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(/(?:^|;\s*)cobra_session=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Format a Set-Cookie header for the session cookie.
 * HttpOnly, SameSite=Strict, Path=/, max-age from config.
 */
export function formatSessionCookie(token: string, maxAge?: number): string {
  const age = maxAge || Math.floor(SESSION_DURATION_MS / 1000);
  return `cobra_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`;
}

/**
 * Format a Set-Cookie header that clears the session (logout).
 */
export function clearSessionCookie(): string {
  return 'cobra_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
}

/**
 * Get active session count (for health checks / monitoring).
 */
export function getActiveSessionCount(): number {
  return sessions.size;
}
