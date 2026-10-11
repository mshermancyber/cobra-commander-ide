import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison to avoid leaking a secret via response timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ============================================================================
// Token management
// ============================================================================

const TOKEN_PATH = join(homedir(), '.cobra-commander', 'api-token');

let cachedToken: string | null = null;

export function loadToken(): string | null {
  if (cachedToken) return cachedToken;
  if (process.env.API_TOKEN) {
    cachedToken = process.env.API_TOKEN;
    return cachedToken;
  }
  if (existsSync(TOKEN_PATH)) {
    try {
      cachedToken = readFileSync(TOKEN_PATH, 'utf-8').trim();
      return cachedToken;
    } catch {
      return null;
    }
  }
  return null;
}

export function setToken(token: string): void {
  cachedToken = token;
}

// ============================================================================
// SSO Auth state (FIX-025)
// ============================================================================

interface SSOSession {
  userId: string;
  email: string;
  provider: string;
  expiresAt: number;
  roles: string[];
}

// In-memory SSO session store (in production, use a proper store)
const ssoSessions = new Map<string, SSOSession>();

/**
 * SSO provider configuration.
 */
export interface SSOProviderConfig {
  provider: 'oidc' | 'saml' | 'github' | 'google';
  clientId: string;
  authUrl: string;
  tokenUrl: string;
  userInfoUrl?: string;
  redirectUri: string;
  scopes: string[];
  /** PKCE state — populated during flow */
  _codeVerifier?: string;
  _state?: string;
}

let ssoConfig: SSOProviderConfig | null = null;

export function setSSOConfig(config: SSOProviderConfig): void {
  ssoConfig = config;
}

export function getSSOConfig(): SSOProviderConfig | null {
  return ssoConfig;
}

/**
 * Generate the SSO login URL with PKCE challenge.
 */
export function generateSSOLoginUrl(config: SSOProviderConfig): { loginUrl: string; state: string } {
  const state = randomBytes(16).toString('hex');
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

  // Store code verifier and state for verification later
  config._codeVerifier = codeVerifier;
  config._state = state;
  ssoConfig = config;

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    scope: config.scopes.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  const loginUrl = `${config.authUrl}?${params.toString()}`;
  return { loginUrl, state };
}

/**
 * Exchange authorization code for tokens (PKCE).
 */
export async function exchangeSSOCode(code: string, state: string): Promise<{ token: string; session: SSOSession }> {
  if (!ssoConfig) throw new Error('SSO not configured');
  if (state !== ssoConfig._state) throw new Error('State mismatch — possible CSRF attack');
  if (!ssoConfig._codeVerifier) throw new Error('PKCE code verifier missing');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: ssoConfig.redirectUri,
    client_id: ssoConfig.clientId,
    code_verifier: ssoConfig._codeVerifier,
  });

  // Validate URL before fetch
  const tokenUrl = ssoConfig.tokenUrl;
  if (!tokenUrl.startsWith('https://') && !tokenUrl.startsWith('http://localhost')) {
    throw new Error('Token URL must use HTTPS or localhost');
  }

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${resp.statusText}`);
  }

  const data = await resp.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    id_token?: string;
  };

  // Decode id_token to get user info
  let userId = 'sso-user';
  let email = 'sso-user@unknown';
  if (data.id_token) {
    try {
      const payload = JSON.parse(
        Buffer.from(data.id_token.split('.')[1], 'base64').toString()
      );
      userId = payload.sub || userId;
      email = payload.email || email;
    } catch { /* ignore */ }
  }

  // Optionally fetch user info
  if (ssoConfig.userInfoUrl) {
    try {
      const userResp = await fetch(ssoConfig.userInfoUrl, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (userResp.ok) {
        const userData = await userResp.json() as { sub?: string; email?: string };
        userId = userData.sub || userId;
        email = userData.email || email;
      }
    } catch { /* ignore */ }
  }

  const session: SSOSession = {
    userId,
    email,
    provider: ssoConfig.provider,
    expiresAt: Date.now() + Math.min(data.expires_in, 604800) * 1000,
    roles: ['user'],
  };

  // Generate API token for the session
  const apiToken = randomUUID();
  ssoSessions.set(apiToken, session);

  // Clean up PKCE state
  ssoConfig._codeVerifier = undefined;
  ssoConfig._state = undefined;

  return { token: apiToken, session };
}

// ============================================================================
// Auth middleware
// ============================================================================

export function authMiddleware(req: IncomingMessage, res: ServerResponse): boolean {
  // Skip auth for non-API routes and SSO callback
  if (!req.url?.startsWith('/api/')) return true;

  // Allow SSO callback without token
  if (req.url.startsWith('/api/v1/auth/sso/callback') || req.url.startsWith('/api/auth/sso/callback')) {
    return true;
  }

  // Allow SSO login endpoint without token
  if (req.url.startsWith('/api/v1/auth/sso/login') || req.url.startsWith('/api/auth/sso/login')) {
    return true;
  }

  const token = loadToken();
  if (!token) {
    // No token configured — generate and persist one, but REJECT this request.
    // Failing open (returning true) would let any unauthenticated request race
    // through before a token exists. The caller must retry with the new token.
    const autoToken = randomUUID();
    setToken(autoToken);
    console.warn('[auth] No API token configured. Generated one; request rejected. Retry with the token (see ~/.cobra-commander/api-token).');
    return false;
  }

  // Check Authorization header
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const provided = authHeader.slice(7);

    // Check against API token (constant-time)
    if (safeEqual(provided, token)) return true;

    // Check against SSO sessions
    if (ssoSessions.has(provided)) {
      const session = ssoSessions.get(provided)!;
      if (Date.now() < session.expiresAt) return true;
      ssoSessions.delete(provided); // expired
    }

    return false;
  }

  // Check query parameter (for WebSocket connections)
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const queryToken = url.searchParams.get('token');
  if (queryToken && safeEqual(queryToken, token)) return true;
  if (queryToken && ssoSessions.has(queryToken)) {
    const session = ssoSessions.get(queryToken)!;
    if (Date.now() < session.expiresAt) return true;
    ssoSessions.delete(queryToken);
  }

  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized', status: 401 }));
  return false;
}

// ============================================================================
// SSO route handlers
// ============================================================================

export async function handleSSOLogin(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ssoConfig) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'SSO not configured', status: 400 }));
    return;
  }

  const { loginUrl, state } = generateSSOLoginUrl(ssoConfig);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ loginUrl, state, provider: ssoConfig.provider }));
}

export async function handleSSOCallback(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `SSO error: ${error}`, status: 400 }));
    return;
  }

  if (!code || !state) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing code or state', status: 400 }));
    return;
  }

  try {
    const { token, session } = await exchangeSSOCode(code, state);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token,
      userId: session.userId,
      email: session.email,
      provider: session.provider,
      expiresAt: session.expiresAt,
    }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: err instanceof Error ? err.message : 'Token exchange failed',
      status: 500,
    }));
  }
}

export async function handleSSOLogout(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const provided = authHeader.slice(7);
    ssoSessions.delete(provided);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Logged out', status: 200 }));
}

export async function handleSSOStatus(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authenticated: false, provider: ssoConfig?.provider || null }));
    return;
  }

  const token = authHeader.slice(7);
  const session = ssoSessions.get(token);

  if (session && Date.now() < session.expiresAt) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authenticated: true,
      userId: session.userId,
      email: session.email,
      provider: session.provider,
      expiresIn: Math.floor((session.expiresAt - Date.now()) / 1000),
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ authenticated: false, provider: ssoConfig?.provider || null }));
}

// ============================================================================
// Helpers
// ============================================================================

function randomUUID(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
