import { totalmem, freemem, uptime } from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Metrics for system memory usage.
 */
export interface MemoryMetrics {
  /** Total system memory in bytes */
  total: number;
  /** Free system memory in bytes */
  free: number;
  /** Used system memory in bytes (total - free) */
  used: number;
  /** Memory usage as a percentage (0–100) */
  usagePercentage: number;
}

/**
 * Metrics for system uptime.
 */
export interface UptimeMetrics {
  /** System uptime in seconds (as reported by os.uptime) */
  seconds: number;
  /** Human-readable uptime string, e.g. "27d 14h 11m 9s" */
  humanReadable: string;
}

/**
 * Metrics for disk space on a mount point.
 */
export interface DiskMetrics {
  /** Total disk space in bytes */
  total: number;
  /** Free disk space in bytes */
  free: number;
  /** Used disk space in bytes */
  used: number;
  /** Disk usage as a percentage (0–100) */
  usagePercentage: number;
}

/**
 * Top-level system health snapshot returned by {@link getSystemHealth}.
 */
export interface SystemHealth {
  memory: MemoryMetrics;
  uptime: UptimeMetrics;
  /** Approximate count of active delegate worker processes */
  activeWorkers: number;
  disk: DiskMetrics;
}

/**
 * Convert a duration in seconds to a compact human-readable string.
 * Example: 2383869 → "27d 14h 11m 9s"
 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Query disk usage for a given mount path using `df -B1`.
 * Returns zeroed metrics if the command fails.
 */
function getDiskSpace(mountPath: string): DiskMetrics {
  try {
    const output = execSync(`df -B1 ${mountPath}`, { encoding: 'utf-8' });
    const lines = output.trim().split('\n');
    if (lines.length >= 2) {
      const cols = lines[1].split(/\s+/);
      const total = parseInt(cols[1], 10);
      const used = parseInt(cols[2], 10);
      const free = parseInt(cols[3], 10);
      if (!isNaN(total) && !isNaN(used) && !isNaN(free)) {
        const usagePercentage = total > 0 ? Math.round((used / total) * 10000) / 100 : 0;
        return { total, free, used, usagePercentage };
      }
    }
  } catch {
    // Return zeroed metrics on any failure
  }
  return { total: 0, free: 0, used: 0, usagePercentage: 0 };
}

/**
 * Count active delegate worker processes by grepping the process list for
 * `delegate.ts` entries. Each matching line corresponds to one OS process
 * (which may include intermediate shell / npm wrappers in addition to the
 * actual Node runtime, so the count is approximate).
 */
function countActiveWorkers(): number {
  try {
    const output = execSync('ps aux', { encoding: 'utf-8' });
    const lines = output.split('\n');
    let count = 0;
    for (const line of lines) {
      // Match delegate.ts worker processes spawned via npx tsx
      if (line.includes('delegate.ts') && !line.includes('grep')) {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Collect a snapshot of system health metrics including memory, uptime,
 * active worker count, and disk space on /data.
 *
 * @returns A structured {@link SystemHealth} object with all metrics.
 */
export function getSystemHealth(): SystemHealth {
  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;

  const uptimeSeconds = uptime();

  const disk = getDiskSpace('/data');
  const activeWorkers = countActiveWorkers();

  return {
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usagePercentage: totalMem > 0 ? Math.round((usedMem / totalMem) * 10000) / 100 : 0,
    },
    uptime: {
      seconds: uptimeSeconds,
      humanReadable: formatUptime(uptimeSeconds),
    },
    activeWorkers,
    disk,
  };
}
