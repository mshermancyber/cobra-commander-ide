import { homedir } from 'node:os';
import { DEFAULT_REMOTE_PORT } from '../core/net-defaults.js';

// ---------------------------------------------------------------------------
// Remote Control .env Configuration
// All settings loadable from environment variables with sensible defaults.
// ---------------------------------------------------------------------------

export type RemoteBindMode = 'localhost' | 'tailscale' | '0.0.0.0';
export type AuthMode = 'token' | 'pam' | 'cli';

export interface RemoteConfig {
  // ── Core ──
  enabled: boolean;
  port: number;
  bind: RemoteBindMode | string;
  https: boolean;

  // ── Sessions ──
  maxSessions: number;
  sessionTTL: number;       // seconds
  idleTimeout: number;       // seconds

  // ── Auth ──
  authMode: AuthMode;
  allowedUsers: string[];

  // ── PAM (authMode 'pam' only) ──
  pamService: string;

  // ── Rate Limiting ──
  loginMaxAttempts: number;
  loginLockoutSeconds: number;
}

function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return homedir() + p.slice(1);
  }
  return p;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  const lower = v.toLowerCase();
  return lower === 'true' || lower === '1' || lower === 'yes';
}

function parseIntEnv(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function parseList(v: string | undefined, def: string[]): string[] {
  if (!v) return def;
  return v.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Load remote control configuration from environment variables.
 * Returns a fully populated RemoteConfig with defaults applied.
 */
export function loadRemoteConfig(): RemoteConfig {
  const enabled = parseBool(process.env.REMOTE_ENABLED, false);
  const port = parseIntEnv(process.env.REMOTE_PORT, DEFAULT_REMOTE_PORT);
  const bind = (process.env.REMOTE_BIND || 'localhost') as RemoteBindMode | string;
  const https = parseBool(process.env.REMOTE_HTTPS, false);

  const maxSessions = parseIntEnv(process.env.REMOTE_MAX_SESSIONS, 5);
  const sessionTTL = parseIntEnv(process.env.REMOTE_SESSION_TTL, 86400);
  const idleTimeout = parseIntEnv(process.env.REMOTE_IDLE_TIMEOUT, 3600);

  const authMode = (process.env.REMOTE_AUTH_MODE || process.env.AUTH_PROVIDER || 'token') as AuthMode;
  const allowedUsers = parseList(process.env.REMOTE_AUTH_ALLOWED_USERS, []);

  const pamService = process.env.REMOTE_PAM_SERVICE || 'login';

  const loginMaxAttempts = parseIntEnv(process.env.REMOTE_LOGIN_MAX_ATTEMPTS, 5);
  const loginLockoutSeconds = parseIntEnv(process.env.REMOTE_LOGIN_LOCKOUT_SECONDS, 30);

  return {
    enabled,
    port,
    bind,
    https,
    maxSessions,
    sessionTTL,
    idleTimeout,
    authMode,
    allowedUsers,
    pamService,
    loginMaxAttempts,
    loginLockoutSeconds,
  };
}
