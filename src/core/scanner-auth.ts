import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Auth + path translation for an external application-security scanner.
 *
 * Cobra Commander can hand code to a self-hosted AppSec platform (SAST/DAST/SCA)
 * and feed the findings back to the orchestrator. The integration is entirely
 * optional: with nothing configured, every entry point here returns null and the
 * security features stay inert.
 *
 * Configure it with SCANNER_API_BASE + SCANNER_EMAIL + SCANNER_PASSWORD, or with
 * a `.cobra-commander/scanner.json` file in the project:
 *
 *   { "baseUrl": "https://scanner.internal", "email": "...", "password": "...",
 *     "hostPath": "/srv/projects", "containerPath": "/scan" }
 */

const SCANNER_PORT = process.env.SCANNER_PORT || '3000';
const URL_TTL_MS = 60_000;

let _urlCache: { url: string; expiresAt: number } | null = null;

/**
 * If the scanner runs in a local container whose IP moves across restarts, set
 * SCANNER_CONTAINER and its live address is resolved at call time. Returns null
 * when no container is configured or the runtime is unavailable.
 */
function inspectContainerIp(container: string): string | null {
  try {
    const out = execFileSync(
      'docker',
      ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', container],
      { encoding: 'utf-8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const ip = out.trim().split(/\s+/).filter(Boolean)[0];
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the scanner base URL: an explicitly configured URL wins, otherwise a
 * configured container's live IP is used. Returns null when neither is set.
 */
export function resolveScannerBaseUrl(configured?: string): string | null {
  if (_urlCache && Date.now() < _urlCache.expiresAt) return _urlCache.url;

  const explicit = (configured || process.env.SCANNER_API_BASE || '').replace(/\/+$/, '');
  if (explicit) {
    _urlCache = { url: explicit, expiresAt: Date.now() + URL_TTL_MS };
    return explicit;
  }

  const container = process.env.SCANNER_CONTAINER;
  if (container) {
    const ip = inspectContainerIp(container);
    if (ip) {
      const url = `http://${ip}:${SCANNER_PORT}`;
      _urlCache = { url, expiresAt: Date.now() + URL_TTL_MS };
      return url;
    }
  }

  return null;
}

/** Clear the cached scanner base URL (e.g. after a known container restart). */
export function clearScannerUrlCache(): void {
  _urlCache = null;
}

// --- Path translation ---

export interface ScannerPathMapping {
  hostPath: string;
  containerPath: string;
}

let _pathMapping: ScannerPathMapping | null = null;

function loadPathMapping(workDir?: string): ScannerPathMapping {
  if (_pathMapping) return _pathMapping;

  const configPath = join(workDir || process.cwd(), '.cobra-commander', 'scanner.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (raw.hostPath && raw.containerPath) {
        _pathMapping = { hostPath: raw.hostPath, containerPath: raw.containerPath };
        return _pathMapping;
      }
    } catch { /* fall through to defaults */ }
  }

  const envHost = process.env.SCANNER_HOST_PATH;
  const envContainer = process.env.SCANNER_CONTAINER_PATH;
  if (envHost && envContainer) {
    _pathMapping = { hostPath: envHost, containerPath: envContainer };
    return _pathMapping;
  }

  _pathMapping = { hostPath: process.cwd(), containerPath: process.cwd() };
  return _pathMapping;
}

/**
 * Translate a host path into the path the scanner sees. When the scanner runs in
 * a container with the project bind-mounted elsewhere, a wrong path shows up as
 * "scan path not found", so this mapping is configuration, never a guess.
 */
export function translatePath(
  hostPath: string,
  hostRoot?: string,
  containerRoot?: string,
): string {
  const mapping = hostRoot && containerRoot
    ? { hostPath: hostRoot, containerPath: containerRoot }
    : loadPathMapping();

  const hRoot = (hostRoot || mapping.hostPath).replace(/\/+$/, '');
  const cRoot = (containerRoot || mapping.containerPath).replace(/\/+$/, '');

  if (hostPath.startsWith(hRoot)) return cRoot + hostPath.slice(hRoot.length);
  if (hostPath.startsWith('/')) return cRoot + hostPath;
  return cRoot + '/' + hostPath;
}

export function clearPathMappingCache(): void {
  _pathMapping = null;
}

// --- Auth ---

export interface ScannerCredentials {
  baseUrl: string;
  email: string;
  password: string;
}

export interface ScannerAuthHeaders {
  'Content-Type': string;
  'Accept': string;
  'Authorization': string;
  'Cookie': string;
  [key: string]: string;
}

const TOKEN_TTL_MS = 4.5 * 60 * 1000;

let cached: { token: string; expiresAt: number } | null = null;

/**
 * Pull the session token out of Set-Cookie. A `Secure` flag on the cookie means
 * naive cookie jars drop it silently, and multiple cookies can be merged into a
 * single header value — so read the individual cookie strings when available.
 */
function extractTokenFromSetCookie(response: Response): string | null {
  const cookies = response.headers.getSetCookie?.() || [];
  for (const cookie of cookies) {
    const match = cookie.match(/^access_token=([^;]+)/);
    if (match) return match[1];
  }

  const single = response.headers.get('set-cookie') || '';
  const match = single.match(/access_token=([^;]+)/);
  if (match) return match[1];

  return null;
}

export async function scannerLogin(creds: ScannerCredentials): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const resp = await fetch(`${creds.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: creds.email, password: creds.password }),
      signal: controller.signal,
    });

    if (!resp.ok) return null;

    let token = extractTokenFromSetCookie(resp);
    if (!token) {
      try {
        const body = await resp.json() as Record<string, unknown>;
        if (typeof body.token === 'string') token = body.token;
      } catch { /* no json body */ }
    }

    if (token) cached = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
    return token;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function scannerHeaders(token: string): ScannerAuthHeaders {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Cookie': `access_token=${token}`,
  };
}

export function clearScannerAuthCache(): void {
  cached = null;
}

/**
 * Load scanner credentials from `.cobra-commander/scanner.json` or the
 * environment. Returns null when the integration is not configured.
 */
export function loadScannerCredentials(workDir: string): ScannerCredentials | null {
  const configPath = join(workDir, '.cobra-commander', 'scanner.json');
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
      if (raw.email && raw.password) {
        const baseUrl = resolveScannerBaseUrl(raw.baseUrl || raw.apiBase);
        if (baseUrl) return { baseUrl, email: raw.email, password: raw.password };
      }
    } catch { /* fall through */ }
  }

  const email = process.env.SCANNER_EMAIL;
  const password = process.env.SCANNER_PASSWORD;
  if (email && password) {
    const baseUrl = resolveScannerBaseUrl();
    if (baseUrl) return { baseUrl, email, password };
  }

  return null;
}
