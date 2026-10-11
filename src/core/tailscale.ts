import { execSync } from 'node:child_process';
import { request } from 'node:http';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Tailscale detection & local API client
// ---------------------------------------------------------------------------

const TS_SOCKET = '/var/run/tailscale/tailscaled.sock';

export interface TailscaleStatus {
  running: boolean;
  ip: string | null;
  hostname: string | null;
  tailnet: string | null;
}

export interface TailscaleWhoIs {
  userLoginName: string | null;
  node: string | null;
  tailnet: string | null;
}

let cachedStatus: TailscaleStatus | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

function parseTailscaleIP(): string | null {
  try {
    const output = execSync('ip addr show tailscale0 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const match = output.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function tailscaleAPI<T = unknown>(path: string): Promise<T | null> {
  return new Promise((resolve) => {
    if (!existsSync(TS_SOCKET)) {
      resolve(null);
      return;
    }

    const req = request(
      {
        socketPath: TS_SOCKET,
        path,
        method: 'GET',
        headers: { Host: 'localhost', Accept: 'application/json' },
        timeout: 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString();
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

export async function getTailscaleStatus(): Promise<TailscaleStatus> {
  const ip = parseTailscaleIP();

  if (!ip) {
    return { running: false, ip: null, hostname: null, tailnet: null };
  }

  // Use cached result if fresh
  if (cachedStatus && Date.now() - cacheTime < CACHE_TTL) {
    return cachedStatus;
  }

  // Query Tailscale local API
  const status = await tailscaleAPI<{
    Self?: { HostName?: string; TailscaleIPs?: string[] };
    CurrentTailnet?: { Name?: string };
  }>('/localapi/v0/status');

  const hostname = status?.Self?.HostName || null;
  const tailnet = status?.CurrentTailnet?.Name || null;

  const result: TailscaleStatus = { running: true, ip, hostname, tailnet };
  cachedStatus = result;
  cacheTime = Date.now();

  return result;
}

export function getTailscaleIP(): string | null {
  return parseTailscaleIP();
}

export async function whoIs(remoteAddr: string): Promise<TailscaleWhoIs | null> {
  const encoded = encodeURIComponent(remoteAddr);
  const result = await tailscaleAPI<{
    UserProfile?: { LoginName?: string };
    Node?: { Name?: string };
  }>(`/localapi/v0/whois?addr=${encoded}`);

  if (!result) return null;

  return {
    userLoginName: result.UserProfile?.LoginName || null,
    node: result.Node?.Name || null,
    tailnet: null,
  };
}
