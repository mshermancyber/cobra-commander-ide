import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../middleware/error-handler.js';

const startTime = Date.now();

// ---------------------------------------------------------------------------
// Event loop lag probe — records max delay observed over recent iterations
// ---------------------------------------------------------------------------

let maxLagMs = 0;
let lastCheck = Date.now();

const lagInterval = setInterval(() => {
  const now = Date.now();
  const lag = now - lastCheck - 50; // subtract the interval period
  if (lag > maxLagMs) maxLagMs = lag;
  lastCheck = now;
}, 50);

// Prevent the interval from keeping the process alive
if (lagInterval.unref) lagInterval.unref();

// ---------------------------------------------------------------------------
// Disk check via df
// ---------------------------------------------------------------------------

interface DiskInfo {
  free: string;  // e.g. "42G"
  total: string; // e.g. "100G"
}

function getDiskInfo(): DiskInfo {
  try {
    const out = execSync("df -h / | tail -1 | awk '{print $4,$2}'", {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    const [free, total] = out.split(/\s+/);
    if (!free || !total) throw new Error('Unexpected df output');
    return { free, total };
  } catch {
    // Fallback if df fails (e.g. Windows or missing binary)
    return { free: 'unknown', total: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMonitoring(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Read version from package.json (same pattern as health.ts)
  let version = '0.1.0';
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    );
    version = pkg.version || version;
  } catch {
    /* ignore */
  }

  // Memory in MB, rounded
  const mem = process.memoryUsage();
  const memory = {
    rss: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    heapTotal: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
    heapUsed: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
    external: Math.round((mem.external / 1024 / 1024) * 100) / 100,
  };

  // CPU usage in ms
  const cpuUsage = process.cpuUsage();
  const cpu = {
    user: Math.round((cpuUsage.user / 1000) * 100) / 100,
    system: Math.round((cpuUsage.system / 1000) * 100) / 100,
  };

  // Snapshot and reset event-loop lag
  const eventLoopMax = maxLagMs;
  maxLagMs = 0;

  const disk = getDiskInfo();

  // Determine overall status
  let status: 'ok' | 'degraded' | 'down' = 'ok';
  if (eventLoopMax > 100) {
    status = 'degraded';
  }
  if (disk.free === 'unknown') {
    status = 'degraded';
  }

  sendJson(res, 200, {
    status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version,
    timestamp: new Date().toISOString(),
    memory,
    cpu,
    node: process.version,
    checks: {
      disk,
      eventLoop: {
        maxDelayMs: Math.round(eventLoopMax * 100) / 100,
      },
    },
  });
}
