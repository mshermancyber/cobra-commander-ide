/**
 * Network defaults.
 *
 * Every listener binds to loopback by default: the API server holds an
 * unsandboxed shell and file tools, so it must never be reachable from the
 * network unless the operator deliberately puts an authenticating proxy in
 * front of it. Override per-process with the matching environment variable.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/** Loopback only. Set CC_BIND_HOST to expose a server on another interface. */
export const DEFAULT_BIND_HOST = process.env.CC_BIND_HOST || '127.0.0.1';

/** REST + WebSocket API (API_PORT). */
export const DEFAULT_API_PORT = intEnv('API_PORT', 4100);

/** Remote-control web shell (REMOTE_PORT). */
export const DEFAULT_REMOTE_PORT = intEnv('REMOTE_PORT', 4101);

/** Support-agent daemon (DESTRO_PORT). */
export const DEFAULT_SUPPORT_PORT = intEnv('DESTRO_PORT', 4102);

/** Base URL other local processes use to reach the API server. */
export function apiBaseUrl(): string {
  return process.env.CC_API_BASE || `http://127.0.0.1:${DEFAULT_API_PORT}`;
}
