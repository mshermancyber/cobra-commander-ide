import type { IncomingMessage } from 'node:http';
import { whoIs } from '../core/tailscale.js';

// ---------------------------------------------------------------------------
// Tailscale WhoIs auth middleware for remote control
// ---------------------------------------------------------------------------

export interface TailscaleAuthConfig {
  allowedUser: string;
}

function extractRemoteIP(req: IncomingMessage): string {
  // In Tailscale, the remote address is the actual Tailscale IP
  // Headers like X-Forwarded-For won't be set since this is direct Tailscale traffic
  const addr = req.socket?.remoteAddress || req.headers['x-real-ip'] as string || '';
  return addr.replace(/^::ffff:/, '');
}

/**
 * Create a Tailscale auth middleware function.
 * Verifies that the connecting peer's Tailscale identity matches the allowed user.
 */
export function createTailscaleAuth(allowedUser: string) {
  return async function tailscaleAuth(req: IncomingMessage): Promise<boolean> {
    const remoteIP = extractRemoteIP(req);

    // If no remote IP or localhost, allow (for local dev / health checks)
    if (!remoteIP || remoteIP === '127.0.0.1' || remoteIP === '::1') {
      return true;
    }

    // Anything that is not a Tailscale peer address has no WhoIs identity to
    // check, so it cannot be authenticated by this middleware. Fail closed.
    // Set TAILSCALE_AUTH_ALLOW_NON_PEERS=true only behind another auth layer.
    if (!remoteIP.startsWith('100.') && !remoteIP.startsWith('fd7a:')) {
      return process.env.TAILSCALE_AUTH_ALLOW_NON_PEERS === 'true';
    }

    try {
      const identity = await whoIs(remoteIP);
      if (!identity) return false;

      return identity.userLoginName === allowedUser;
    } catch {
      return false;
    }
  };
}

/**
 * Verify a WebSocket upgrade request against Tailscale identity.
 * Returns true if the peer is authorized.
 */
export async function verifyWsUpgrade(
  req: IncomingMessage,
  allowedUser: string,
): Promise<boolean> {
  const remoteIP = extractRemoteIP(req);

  if (!remoteIP || remoteIP === '127.0.0.1' || remoteIP === '::1') {
    return true;
  }

  if (!remoteIP.startsWith('100.') && !remoteIP.startsWith('fd7a:')) {
    return true; // Allow non-Tailscale for dev
  }

  try {
    const identity = await whoIs(remoteIP);
    if (!identity) return false;
    return identity.userLoginName === allowedUser;
  } catch {
    return false;
  }
}
